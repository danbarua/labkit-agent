import type { TurnEvent } from "../../agent/agent-fsm.ts";
import type { PromptInput } from "../../agent/prompt.ts";
import type { ActorId, SessionId, TurnData } from "../../agent/types.ts";
import { Actor } from "../../fsm/fsm.ts";
import { createHost } from "../../host/host.ts";
import { diagnostic } from "../../logging/index.ts";
import { validatePolicy, type Policy, type PolicyPatch } from "../../policy/policy.ts";
import { AppendIdSchema, type AppendId } from "../persistence.ts";
import {
  decideSession,
  type CommandReceipt,
  type SessionCommand,
  type SessionEvent,
  type SessionState,
} from "../session-fsm.ts";
import { completionUsage, seedConversation, wireEvent, type JournalState } from "../session-log.ts";
import type { SessionRuntime, TerminalResult } from "../session-runtime.ts";
import type { Seed, SessionInput } from "../types.ts";
import type { ConfiguredSession } from "./configure.ts";
import { adopt } from "./env-events.ts";
import { createFacade } from "./facade.ts";
import { registryDifferences, type Adoption } from "./registry-adoption.ts";
import { executeSessionCommand } from "./session-commands.ts";

/** State and callbacks of one open session, passed explicitly to its command and event handlers. */
export type SessionInstance = {
  readonly configured: ConfiguredSession;
  readonly sessionId: SessionId;
  readonly actor: Actor<SessionState, SessionEvent, SessionCommand>;
  readonly host: ReturnType<typeof createHost>;
  /** Restore-only registry adoption waiting to be journaled, and whether it was submitted. */
  readonly adoption: { plan: Adoption | undefined; submitted: boolean };
  /** Committed state of the latest dispatched submission; branch seeds are cut from it. */
  dispatchBoundary: JournalState;
  /** Last logged `status/phase` transition and completion usage operation. */
  readonly observed: { transition: string; usage: string | undefined };
  /** Receipt callbacks by submission ID. */
  readonly receipts: Map<string, (receipt: CommandReceipt) => void>;
  /** Callbacks run once a submission's records commit, by submission ID. */
  readonly afterCommit: Map<string, () => void>;
  /** Settlements of submitted user input, by submission ID, until it is admitted to a turn. */
  readonly admissions: Map<string, (result: TerminalResult) => void>;
  /** Settlements waiting for a turn's terminal record, by turn ID. */
  readonly waiters: Map<ActorId, ((result: TerminalResult) => void)[]>;
  /** Settlements of queued user input, by input ID, until it is dequeued. */
  readonly queuedWaiters: Map<string, (result: TerminalResult) => void>;
  /** Fork and compaction requests waiting for their child session, by request ID. */
  readonly branchReplies: Map<
    ActorId,
    { resolve: (runtime: SessionRuntime) => void; reject: (error: unknown) => void }
  >;
  /** Storage operations and blob copies that closing the session cancels. */
  readonly storage: Set<{ cancel(): Promise<unknown> }>;
  /**
   * Tail of the configuration-store writes in progress, so selections reach the store in the order
   * the session actor registered them.
   */
  storing: Promise<unknown>;
  readonly send: (event: SessionEvent) => Promise<SessionState>;
  readonly submit: (
    input: SessionInput,
    committed?: () => void,
    settlement?: (result: TerminalResult) => void,
    stableAppendId?: AppendId,
  ) => Promise<CommandReceipt>;
  readonly post: (turnId: ActorId, event: TurnEvent) => void;
  readonly promptInput: (turn: TurnData) => PromptInput;
  /** Opens a fork or compaction child with the same configured bindings. */
  readonly initializeChild: (seed: Seed) => Promise<SessionRuntime>;
};

/** Opens a new session from `seed` and commits its creation record. */
export async function initializeSession(
  configured: ConfiguredSession,
  seed: Seed,
): Promise<SessionRuntime> {
  const built = openInstance(configured, seedConversation(seed, configured.resolvers));
  const receipt = await built.submit(
    { kind: "created", seed },
    undefined,
    undefined,
    AppendIdSchema.parse(`initialize/${seed.sessionId}`),
  );
  if (receipt.kind !== "accepted") {
    await built.runtime.close();
    throw new Error(receipt.kind === "failed" ? receipt.message : `Creation ${receipt.kind}`, {
      cause: receipt.kind === "failed" ? receipt.error : undefined,
    });
  }
  return built.runtime;
}

/**
 * Opens one session over the committed state `initial`: its actor, host and runtime facade.
 * `restoring` skips the checks that a restore replaces with a registry adoption plan.
 */
export function openInstance(
  configured: ConfiguredSession,
  initial: JournalState,
  restoring = false,
) {
  const { resolvers, configuration } = configured;
  const sessionId = initial.conversation.sessionId;
  // Restored policies are reconciled against live bindings by the adoption plan instead.
  if (!restoring && initial.policy)
    validatePolicy(initial.policy, initial.configuration, resolvers);
  if (!restoring && JSON.stringify(initial.configuration) !== JSON.stringify(configuration)) {
    const differences = registryDifferences(initial.configuration, configuration);
    throw Object.assign(
      new Error(
        `Session configuration does not match persisted registry: ${differences.join("; ")}`,
      ),
      { differences },
    );
  }
  const ctx: SessionInstance = {
    configured,
    sessionId,
    adoption: { plan: undefined, submitted: false },
    branchReplies: new Map(),
    receipts: new Map(),
    afterCommit: new Map(),
    admissions: new Map(),
    waiters: new Map(),
    queuedWaiters: new Map(),
    storage: new Set(),
    dispatchBoundary: initial,
    observed: { transition: "", usage: initial.lastCompletionUsage?.operationId },
    storing: Promise.resolve(),
    send: (event) => send(ctx, event),
    promptInput: (turn) => promptInput(ctx, turn),
    post: (turnId, event) => post(ctx, turnId, event),
    submit: (input, committed, settlement, stableAppendId) =>
      submit(ctx, input, committed, settlement, stableAppendId),
    initializeChild: (seed) => initializeSession(configured, seed),
    host: createHost(
      {
        agents: configured.agents,
        tools: configured.tools,
        sessionId,
        requestPermission: configured.requestPermission,
        complete: configured.completePort,
        storeBlob: (bytes, meta) =>
          configured.port.putBlob(sessionId, bytes, meta, new AbortController().signal),
        effects: configured.effects,
      },
      {
        turn: (turnId, event) => ctx.post(turnId, event),
        toolUpdate: configured.toolUpdate,
        streamUpdate: configured.streamUpdate,
        tool: (outcome) => {
          void ctx.submit({ kind: "tool", ...outcome }, () => ctx.host.releaseTool(outcome));
        },
      },
    ),
    actor: new Actor<SessionState, SessionEvent, SessionCommand>(
      { status: "ready", durable: initial, queue: [] },
      (state, event) => decideSession(state, event, resolvers),
      (command) => executeSessionCommand(ctx, command),
      () => ({ type: "close" }),
    ),
  };
  const runtime = createFacade(ctx);
  /** Restore-only: every registry difference is journaled before the next new work. */
  const pend = (plan: Adoption) => {
    ctx.adoption.plan = plan;
  };
  /** Restore-only: applies a selection stored before the session last closed. */
  const reselect = (policy: Policy) => {
    const id = ctx.configured.id();
    const { promise, resolve } = Promise.withResolvers<CommandReceipt>();
    ctx.receipts.set(id, resolve);
    void ctx.send({ type: "reselect", id, policy });
    return promise;
  };
  return { runtime, submit: ctx.submit, pend, adopt: () => adopt(ctx), reselect };
}

function promptInput(ctx: SessionInstance, turn: TurnData): PromptInput {
  const policy = ctx.actor.snapshot.durable.policy;
  const resolved = policy?.provider
    ? ctx.configured.describeModel?.(
        policy.provider,
        policy.model ?? ctx.configured.agents.get(turn.agent)!.model,
      )
    : undefined;
  return {
    context: ctx.actor.snapshot.durable.conversation.context,
    log: ctx.actor.snapshot.durable.conversation.log,
    turn,
    ...(resolved
      ? {
          target: {
            provider: resolved.provider,
            model: resolved.model,
            media: resolved.capabilities.media,
          },
        }
      : {}),
    agent: {
      ...ctx.configured.agents.get(turn.agent)!,
      tools:
        ctx.actor.snapshot.durable.policy?.tools[turn.agent] ??
        ctx.configured.agents.get(turn.agent)!.tools,
    },
  };
}

function send(ctx: SessionInstance, event: SessionEvent) {
  const { sessionId, observed } = ctx;
  return ctx.actor.send(event).then((snapshot) => {
    const usage = snapshot.durable.lastCompletionUsage;
    if (usage && usage.operationId !== observed.usage) {
      observed.usage = usage.operationId;
      diagnostic("session", "info", "completion.usage.committed", {
        sessionId,
        turnId: usage.turnId,
        childId: usage.operationId,
        revision: snapshot.durable.revision,
        ...("appendId" in event ? { appendId: event.appendId } : {}),
        usage: usage.usage,
        message:
          "Completion response accounting committed; not a current-context estimate or cumulative cost",
      });
    }
    const phase = snapshot.durable.conversation.turn.status;
    const transition = `${snapshot.status}/${phase}`;
    if (transition !== observed.transition) {
      diagnostic(
        "session",
        snapshot.status === "failed" ? "error" : "debug",
        "session.transition",
        {
          sessionId,
          turnId: snapshot.durable.conversation.turnId,
          previousStatus: observed.transition || undefined,
          status: snapshot.status,
          phase,
          revision: snapshot.durable.revision,
          operation: event.type,
          queuedSubmissions: snapshot.queue.length,
          ...("pending" in snapshot
            ? {
                appendId: snapshot.pending.request.appendId,
                requestId: snapshot.pending.submission.id,
                attempts: snapshot.pending.attempts,
                reason:
                  snapshot.status === "reconciling"
                    ? "Append outcome unknown; verifying committed journal"
                    : "Waiting for durable append receipt before releasing work",
              }
            : {}),
          ...(snapshot.status === "failed"
            ? { reason: snapshot.message, error: snapshot.error }
            : {}),
        },
      );
      observed.transition = transition;
    }
    try {
      const result = ctx.configured.observe?.(snapshot);
      if (result instanceof Promise) void result.catch(() => {});
    } catch {
      /* Observation cannot change execution. */
    }
    return snapshot;
  });
}

function post(ctx: SessionInstance, turnId: ActorId, event: TurnEvent) {
  const conversation = { type: "child" as const, turnId, event };
  const usage = completionUsage(conversation);
  void ctx.submit({
    kind: "event",
    event: wireEvent(conversation),
    systemVersion: ctx.actor.snapshot.durable.systemVersion,
    ...(usage ? { usage } : {}),
  });
}

/**
 * Selects a configuration change (D6). The session actor registers the selection at once, so any
 * input sent afterwards waits for it at an idle boundary; it applies `patch` to the configuration
 * the next turn runs under, validates it against the live registry, stores it in the persistence
 * port's configuration store and applies it at the next boundary between turns. Never `busy`.
 */
export function selectConfiguration(
  ctx: SessionInstance,
  patch: PolicyPatch,
): Promise<CommandReceipt> {
  const id = ctx.configured.id();
  const { promise, resolve } = Promise.withResolvers<CommandReceipt>();
  ctx.receipts.set(id, resolve);
  void ctx.send({ type: "select", id, patch });
  return promise.then((receipt) => {
    if (receipt.kind !== "failed" || receipt.error.classification !== "admission") return receipt;
    const { details } = receipt.error;
    // Staging at the boundary names its append; a rejected patch never reached the store.
    const staged =
      typeof details === "object" &&
      details !== null &&
      !Array.isArray(details) &&
      details.appendId !== undefined;
    diagnostic("session", "warning", "configuration.rejected", {
      sessionId: ctx.sessionId,
      selectionId: id,
      turnId: ctx.actor.snapshot.durable.conversation.turnId,
      fields: Object.keys(patch),
      reason: receipt.message,
      error: receipt.error,
      consequence: staged
        ? "The stored selection no longer validates at the boundary; the configuration in force is unchanged"
        : "Nothing stored; the selected configuration is unchanged",
    });
    return receipt;
  });
}

function submit(
  ctx: SessionInstance,
  input: SessionInput,
  committed?: () => void,
  settlement?: (result: TerminalResult) => void,
  stableAppendId?: AppendId,
): Promise<CommandReceipt> {
  const requestId = stableAppendId ?? ctx.configured.id();
  return new Promise((resolve) => {
    ctx.receipts.set(requestId, resolve);
    if (committed) ctx.afterCommit.set(requestId, committed);
    if (settlement) ctx.admissions.set(requestId, settlement);
    void ctx.send({
      type: "submit",
      submission: {
        id: requestId,
        appendId: stableAppendId ?? AppendIdSchema.parse(`${ctx.sessionId}/append/${requestId}`),
        input,
      },
    });
  });
}
