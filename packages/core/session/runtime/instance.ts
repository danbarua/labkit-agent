import type { ConversationCommand, SessionRequest } from "../../agent/agent-conversation.ts";
import type { TurnEvent } from "../../agent/agent-fsm.ts";
import { blobRefs } from "../../agent/content.ts";
import { parseSessionContext, type PromptInput } from "../../agent/prompt.ts";
import {
  ActorIdSchema,
  failure,
  SessionIdSchema,
  type ActorId,
  type SessionId,
  type TurnData,
} from "../../agent/types.ts";
import { Actor } from "../../fsm/fsm.ts";
import { createHost } from "../../host/host.ts";
import { diagnostic, diagnosticError } from "../../logging/index.ts";
import { projectPolicy, validatePolicy } from "../../policy/policy.ts";
import {
  continuationBlobRefs,
  copyBranchBlobs,
  resolveRequestBlobs,
  storeContinuation,
} from "../blobs.ts";
import { EnvEventSchema, type EnvEvent } from "../events.ts";
import { AppendIdSchema, type AppendId } from "../persistence.ts";
import {
  decideSession,
  type CommandReceipt,
  type SessionCommand,
  type SessionEvent,
  type SessionState,
} from "../session-fsm.ts";
import { seedConversation, toSeed, wireEvent, type JournalState } from "../session-log.ts";
import { appendOperation, loadOperation } from "../session-operation.ts";
import type {
  EnvCommandHandle,
  EnvSettlement,
  SessionRegistry,
  SessionRuntime,
  TerminalResult,
} from "../session-runtime.ts";
import { SystemVersionSchema, type Seed, type SessionInput } from "../types.ts";
import type { ConfiguredSession } from "./configure.ts";
import { registryDifferences, type Adoption } from "./registry-adoption.ts";

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
  /** Restore-only: any registry difference is journaled before the next new work. */
  const pend = (plan: Adoption) => {
    ctx.adoption.plan = plan;
  };
  return { runtime, submit: ctx.submit, pend };
}

function promptInput(ctx: SessionInstance, turn: TurnData): PromptInput {
  return {
    context: ctx.actor.snapshot.durable.conversation.context,
    log: ctx.actor.snapshot.durable.conversation.log,
    turn,
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
  void ctx.submit({
    kind: "event",
    event: wireEvent({ type: "child", turnId, event }),
    systemVersion: ctx.actor.snapshot.durable.systemVersion,
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

function stop(ctx: SessionInstance) {
  const { sessionId } = ctx;
  diagnostic("session", "info", "session.stopped", {
    sessionId,
    status: ctx.actor.snapshot.status,
  });
  ctx.host.close();
  for (const actor of ctx.storage) void actor.cancel();
  const result: TerminalResult =
    ctx.actor.snapshot.status === "closed"
      ? { kind: "closed", message: "Session closed" }
      : {
          kind: "failed",
          message:
            ctx.actor.snapshot.status === "failed"
              ? ctx.actor.snapshot.error.message
              : "Session stopped",
          error:
            ctx.actor.snapshot.status === "failed"
              ? ctx.actor.snapshot.error
              : failure("Session stopped", {
                  classification: "interrupted",
                  operation: { id: sessionId, kind: "admission", sessionId },
                  phase: "stop",
                }),
        };
  for (const settle of ctx.admissions.values()) settle(result);
  ctx.admissions.clear();
  for (const group of ctx.waiters.values()) for (const settle of group) settle(result);
  ctx.waiters.clear();
  for (const settle of ctx.queuedWaiters.values()) settle(result);
  ctx.queuedWaiters.clear();
  for (const reply of ctx.branchReplies.values())
    reply.reject(result.kind === "failed" ? result.error : new Error(result.message));
  ctx.branchReplies.clear();
}

function executeSessionCommand(ctx: SessionInstance, command: SessionCommand): undefined {
  const { sessionId } = ctx;
  switch (command.type) {
    case "append": {
      const actor = appendOperation(ctx.configured.port, command.request);
      ctx.storage.add(actor);
      void actor.start();
      void actor.result.then((result) => {
        ctx.storage.delete(actor);
        return ctx.send({ type: "appended", appendId: command.request.appendId, result });
      });
      break;
    }
    case "load": {
      diagnostic("session", "warning", "append.reconciling", {
        sessionId,
        appendId: command.appendId,
      });
      const actor = loadOperation(ctx.configured.port, sessionId);
      ctx.storage.add(actor);
      void actor.start();
      void actor.result.then((result) => {
        ctx.storage.delete(actor);
        return ctx.send({ type: "loaded", appendId: command.appendId, result });
      });
      break;
    }
    case "dispatch": {
      const previousPolicy = ctx.dispatchBoundary.policy;
      ctx.dispatchBoundary = command.durable;
      const terminal = command.durable.records.at(-1)?.body;
      const newBodies = command.durable.records
        .filter((record) => record.appendId === command.submission.appendId)
        .map((record) => record.body);
      for (const body of newBodies)
        if (body.kind === "dequeued") {
          const waiting = ctx.queuedWaiters.get(body.inputId);
          if (waiting) {
            ctx.queuedWaiters.delete(body.inputId);
            const turnId =
              terminal?.kind === "terminal" ? terminal.turnId : command.durable.conversation.turnId;
            ctx.waiters.set(turnId, [...(ctx.waiters.get(turnId) ?? []), waiting]);
          }
        }
      for (const body of newBodies) {
        if (body.kind === "policy") {
          const toolsChanged = Object.entries(body.policy.tools).some(([agent, tools]) => {
            const previous = previousPolicy?.tools[agent] ?? [];
            return (
              tools.some((tool) => !previous.includes(tool)) ||
              previous.some((tool) => !tools.includes(tool))
            );
          });
          if (body.patch.permissions !== undefined || toolsChanged)
            ctx.host.resetPermissions(
              body.patch.permissions !== undefined
                ? "Permission mode explicitly committed; remembered tool approvals revoked"
                : "Allowed tool scope changed; remembered tool approvals revoked",
              { policyVersion: body.policy.version, appendId: command.submission.appendId },
            );
          diagnostic("session", "info", "policy.committed", {
            sessionId,
            appendId: command.submission.appendId,
            requestId: command.submission.id,
            revision: command.durable.revision,
            policy: body.policy,
          });
        }
        if (body.kind === "configuration" && ctx.adoption.plan) {
          diagnostic("session", "info", "session.registry.adopted", {
            sessionId,
            appendId: command.submission.appendId,
            requestId: command.submission.id,
            revision: command.durable.revision,
            differences: ctx.adoption.plan.differences,
            ...(body.agent ? { agentId: body.agent } : {}),
            ...(body.policy ? { policyVersion: body.policy.version } : {}),
            message: "Live tool/agent registry journaled; later prompts validate against it",
          });
          ctx.adoption.plan = undefined;
        }
      }
      const admission = ctx.admissions.get(command.submission.id);
      if (admission) {
        ctx.admissions.delete(command.submission.id);
        const queued = newBodies.find((body) => body.kind === "queued");
        if (queued?.kind === "queued") ctx.queuedWaiters.set(queued.inputId, admission);
        else {
          const turnId =
            terminal?.kind === "terminal" ? terminal.turnId : command.durable.conversation.turnId;
          ctx.waiters.set(turnId, [...(ctx.waiters.get(turnId) ?? []), admission]);
        }
      }
      if (command.submission.input.kind === "tool") {
        diagnostic("session", "debug", "tool.receipt_committed", {
          sessionId,
          turnId: command.submission.input.turnId,
          batchId: command.submission.input.batchId,
          callId: command.submission.input.callId,
          appendId: command.submission.appendId,
          requestId: command.submission.id,
          revision: command.durable.revision,
          reason: "Individual tool result is durable; releasing batch gate",
        });
      }
      // Forward a committed individual result before processing a queued cancellation.
      ctx.afterCommit.get(command.submission.id)?.();
      ctx.afterCommit.delete(command.submission.id);
      if (terminal?.kind === "terminal") {
        const input = command.submission.input;
        const trigger =
          input.kind === "event" && input.event.type === "child" ? input.event.event : undefined;
        diagnostic(
          "session",
          terminal.record.outcome.kind === "failed" ? "warning" : "info",
          "turn.settled",
          {
            sessionId,
            turnId: terminal.turnId,
            operation: "agent_turn",
            agentId: terminal.record.agent,
            message: `Agent turn ${terminal.record.outcome.kind}${terminal.record.outcome.kind === "failed" ? `: ${terminal.record.outcome.error.message}` : ""}`,
            ...(trigger
              ? {
                  trigger: trigger.type,
                  childId: trigger.child.id,
                  childOperation: trigger.child.kind,
                }
              : { trigger: input.kind === "event" ? input.event.type : input.kind }),
            outcome: terminal.record.outcome.kind,
            revision: command.durable.revision,
            appendId: command.submission.appendId,
            requestId: command.submission.id,
            stepLimit: command.durable.conversation.allowance,
            ...(terminal.record.outcome.kind === "failed"
              ? {
                  reason: terminal.record.outcome.error.message,
                  error: diagnosticError(terminal.record.outcome.error),
                }
              : {}),
            ...(terminal.record.outcome.kind === "exhausted"
              ? { reason: "Turn step allowance exhausted; user continuation required" }
              : {}),
          },
        );
        for (const settle of ctx.waiters.get(terminal.turnId) ?? [])
          settle({ kind: "terminal", turnId: terminal.turnId, record: terminal.record });
        ctx.waiters.delete(terminal.turnId);
      }
      for (const effect of command.commands) {
        try {
          execute(ctx, effect);
        } catch (error) {
          diagnostic("session", "error", "dispatch.failed", {
            sessionId,
            appendId: command.submission.appendId,
            operation: effect.type,
            error: diagnosticError(error),
            ...(effect.type === "turn"
              ? { turnId: effect.turnId, childId: effect.command.child.id }
              : {}),
          });
          if (effect.type === "turn")
            ctx.post(effect.turnId, {
              type: "failed",
              child: effect.command.child,
              error: failure(error),
            });
          else {
            const reply = ctx.branchReplies.get(effect.requestId);
            ctx.branchReplies.delete(effect.requestId);
            reply?.reject(error);
          }
        }
      }
      break;
    }
    case "reply": {
      diagnostic(
        "session",
        command.result.kind === "failed" ? "error" : "debug",
        "submission.receipt",
        {
          sessionId,
          requestId: command.id,
          outcome: command.result.kind,
          ...(command.result.kind === "accepted"
            ? {
                appendId: command.result.receipt.appendId,
                revision: command.result.receipt.revision,
              }
            : {}),
          ...(command.result.kind === "failed"
            ? { reason: command.result.message, error: command.result.error }
            : {}),
        },
      );
      ctx.receipts.get(command.id)?.(command.result);
      ctx.receipts.delete(command.id);
      ctx.afterCommit.delete(command.id);
      const settle = ctx.admissions.get(command.id);
      if (settle) {
        settle({
          kind: "failed",
          message:
            command.result.kind === "failed"
              ? command.result.message
              : `Input ${command.result.kind}`,
          error:
            command.result.kind === "failed"
              ? command.result.error
              : failure(`Input ${command.result.kind}`, {
                  classification: "admission",
                  operation: {
                    id: command.id,
                    kind: "admission",
                    sessionId,
                    turnId: ctx.actor.snapshot.durable.conversation.turnId,
                  },
                  phase: "admission",
                  details: { outcome: command.result.kind },
                }),
        });
        ctx.admissions.delete(command.id);
      }
      break;
    }
    case "drain":
      void ctx.send({ type: "drain" });
      break;
    case "stop":
      stop(ctx);
      break;
  }
  return undefined;
}

async function initializeBranch(ctx: SessionInstance, seed: Seed) {
  const controller = new AbortController();
  const owned = { cancel: async () => controller.abort() };
  ctx.storage.add(owned);
  try {
    await copyBranchBlobs(
      ctx.configured.port,
      ctx.sessionId,
      seed.sessionId,
      [
        ...blobRefs([...seed.context, ...seed.log.flatMap((record) => record.messages)]),
        ...continuationBlobRefs(seed.continuations ?? []),
      ],
      controller.signal,
    );
    controller.signal.throwIfAborted();
    return await ctx.initializeChild(seed);
  } finally {
    ctx.storage.delete(owned);
  }
}

function execute(ctx: SessionInstance, effect: ConversationCommand): undefined {
  const { sessionId } = ctx;
  if (effect.type === "reply") {
    const reply = ctx.branchReplies.get(effect.requestId);
    if (reply)
      void initializeBranch(ctx, toSeed(ctx.dispatchBoundary, effect.result.state)).then(
        (child) => {
          ctx.branchReplies.delete(effect.requestId);
          if (ctx.actor.snapshot.status === "closed" || ctx.actor.snapshot.status === "failed") {
            void child.close();
            reply.reject(new Error("Parent closed before branch publication"));
          } else reply.resolve(child);
        },
        (error) => {
          ctx.branchReplies.delete(effect.requestId);
          reply.reject(error);
        },
      );
    return undefined;
  }
  const durable = ctx.actor.snapshot.durable;
  const policy = durable.policy;
  const prompt = "turn" in effect.command ? ctx.promptInput(effect.command.turn) : undefined;
  ctx.host.dispatch(effect, {
    prompt,
    allowedTools: prompt?.agent.tools,
    toolFailure: policy?.toolFailure,
    permissions: policy?.permissions,
    policyVersion: policy?.version,
    completionTimeoutMs: policy?.completionTimeoutMs ?? undefined,
    toolTimeoutMs: policy?.toolTimeoutMs ?? undefined,
    provider: policy,
    continuations: durable.continuations,
    storeContinuation: (entry, signal) =>
      storeContinuation(ctx.configured.port, sessionId, entry, signal),
    loadBlobs: (request, signal, includeContinuations) =>
      resolveRequestBlobs(
        ctx.configured.port,
        sessionId,
        request,
        ctx.configured.providerMedia?.(request.provider ?? "", request.model) ?? [],
        signal,
        includeContinuations,
      ),
    projectPrompt: (value) =>
      projectPolicy(value, durable.systemInputs, policy, ctx.configured.resolvers),
    projectHandoff: (value) => ctx.configured.resolvers.handoffs.get(policy.handoff)!(value),
  });
  return undefined;
}

function branch(ctx: SessionInstance, request: SessionRequest) {
  let resolve!: (runtime: SessionRuntime) => void;
  let reject!: (error: unknown) => void;
  const settled = new Promise<SessionRuntime>((done, failed) => {
    resolve = done;
    reject = failed;
  });
  ctx.branchReplies.set(request.id, { resolve, reject });
  const accepted = ctx.submit({
    kind: "event",
    event: wireEvent({ type: "request", request }),
    systemVersion: ctx.actor.snapshot.durable.systemVersion,
  });
  void accepted.then((receipt) => {
    if (receipt.kind !== "accepted") {
      ctx.branchReplies.delete(request.id);
      reject(new Error(`Branch ${receipt.kind}`));
    }
  });
  return { accepted, settled };
}

/**
 * Journal the live registry ahead of the first new work. That work queues behind this append in
 * the session actor, so its commit-time prompt checks run against the registry it actually uses.
 */
function adopt(ctx: SessionInstance) {
  const { sessionId } = ctx;
  if (!ctx.adoption.plan || ctx.adoption.submitted) return;
  ctx.adoption.submitted = true;
  const { body, differences } = ctx.adoption.plan;
  const revision = ctx.actor.snapshot.durable.revision;
  const appendId = AppendIdSchema.parse(`configuration/${sessionId}/${revision}`);
  void ctx.submit(body, undefined, undefined, appendId).then((receipt) => {
    if (receipt.kind === "accepted" || receipt.kind === "closed") return;
    diagnostic("session", "error", "session.registry.adoption_failed", {
      sessionId,
      appendId,
      revision,
      differences,
      outcome: receipt.kind,
      ...(receipt.kind === "failed"
        ? { reason: receipt.message, error: receipt.error }
        : { reason: `Registry adoption ${receipt.kind}` }),
      consequence: "submissions queued behind the adoption fail with this cause",
    });
  });
}

function dispatchEvent(ctx: SessionInstance, raw: unknown): EnvCommandHandle {
  const { sessionId } = ctx;
  const event = EnvEventSchema.parse(raw);
  diagnostic("session", "debug", "event.received", { sessionId, operation: event.type });
  if (event.type !== "close" && event.type !== "abort") adopt(ctx);
  if (event.type === "user") {
    let settle!: (result: TerminalResult) => void;
    const settled = new Promise<TerminalResult>((resolve) => {
      settle = resolve;
    });
    const accepted = ctx.submit(
      { kind: "event", event, systemVersion: ctx.actor.snapshot.durable.systemVersion },
      undefined,
      settle,
    );
    return { accepted, settled };
  }
  if (event.type === "fork" || event.type === "compact") {
    const request = {
      id: ActorIdSchema.parse(ctx.configured.id()),
      sessionId: SessionIdSchema.parse(ctx.configured.id()),
    };
    const handle = branch(
      ctx,
      event.type === "fork"
        ? { ...request, kind: "fork" }
        : { ...request, kind: "compact", context: event.context },
    );
    return {
      accepted: handle.accepted,
      settled: handle.settled.then(
        (child) => ({ kind: "branch" as const, session: child }),
        (error) => {
          const cause = failure(error, {
            classification: "execution",
            operation: { id: request.id, kind: "branch", sessionId },
            phase: "publication",
          });
          return { kind: "failed" as const, message: cause.message, error: cause };
        },
      ),
    };
  }
  if (event.type === "close") {
    const accepted = ctx.send({ type: "close" }).then(() => ({
      kind: "close_acknowledged" as const,
    }));
    return {
      accepted,
      settled: accepted.then((receipt) => ({ kind: "acknowledged", receipt })),
    };
  }
  const input: SessionInput =
    event.type === "system"
      ? {
          kind: "system",
          inputs: event.inputs,
          version: SystemVersionSchema.parse(ctx.actor.snapshot.durable.systemVersion + 1),
        }
      : event.type === "policy"
        ? { kind: "policy", patch: event.patch }
        : { kind: "event", event, systemVersion: ctx.actor.snapshot.durable.systemVersion };
  const accepted = ctx.submit(input);
  return { accepted, settled: accepted.then((receipt) => ({ kind: "acknowledged", receipt })) };
}

function createFacade(ctx: SessionInstance): SessionRuntime {
  function dispatch(raw: Extract<EnvEvent, { type: "user" }>): {
    accepted: Promise<CommandReceipt>;
    settled: Promise<TerminalResult>;
  };
  function dispatch(raw: Extract<EnvEvent, { type: "system" | "policy" | "abort" }>): {
    accepted: Promise<CommandReceipt>;
    settled: Promise<EnvSettlement>;
  };
  function dispatch(raw: unknown): EnvCommandHandle;
  function dispatch(raw: unknown): EnvCommandHandle {
    return dispatchEvent(ctx, raw);
  }
  const publishBranch = async (event: EnvEvent): Promise<SessionRuntime> => {
    const result = await dispatch(event).settled;
    if (result.kind !== "branch")
      throw new Error("message" in result ? result.message : "Branch was not published");
    return result.session;
  };
  const runtime: SessionRuntime = {
    get snapshot() {
      return ctx.actor.snapshot;
    },
    get lastCompletionUsage() {
      return ctx.actor.snapshot.durable.lastCompletionUsage;
    },
    get registry(): SessionRegistry {
      return ctx.adoption.plan
        ? { kind: "pending_adoption", differences: ctx.adoption.plan.differences }
        : { kind: "current" };
    },
    get policy() {
      return ctx.adoption.plan?.body.policy ?? ctx.actor.snapshot.durable.policy;
    },
    get model() {
      const { conversation } = ctx.actor.snapshot.durable;
      const policy = runtime.policy;
      // A pending adoption may switch an unregistered agent; describe what the next turn uses.
      const agent =
        conversation.turn.status === "idle"
          ? (ctx.adoption.plan?.body.agent ?? conversation.turn.agent)
          : conversation.turn.turn.agent;
      return policy?.provider
        ? ctx.configured.describeModel?.(
            policy.provider,
            policy.model ?? ctx.configured.agents.get(agent)!.model,
          )
        : undefined;
    },
    dispatch,
    fire: (raw) => dispatch(raw).accepted,
    input: (input) =>
      dispatch(
        typeof input === "string" ? { type: "user", text: input } : { ...input, type: "user" },
      ),
    updateSystem: (inputs) => dispatch({ type: "system", inputs }).accepted,
    updatePolicy: (patch) => dispatch({ type: "policy", patch }).accepted,
    fork: () => publishBranch({ type: "fork" }),
    compact: (context) => {
      const validated = parseSessionContext(context);
      return publishBranch({ type: "compact", context: validated });
    },
    async close() {
      await dispatch({ type: "close" }).accepted;
    },
  };
  return runtime;
}
