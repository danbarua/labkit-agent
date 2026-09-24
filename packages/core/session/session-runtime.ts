import type { z } from "zod";

import type { ConversationCommand, SessionRequest } from "../agent/agent-conversation.ts";
import type { TurnEvent } from "../agent/agent-fsm.ts";
import type { AgentDefinition, Tool } from "../agent/agent-runtime.ts";
import { blobRefs } from "../agent/content.ts";
import { parseSessionContext, type PromptInput } from "../agent/prompt.ts";
import {
  ActorIdSchema,
  AgentIdSchema,
  failure,
  SessionIdSchema,
  StepsSchema,
  type ActorId,
  type Failure,
  type TurnData,
  type TurnRecord,
} from "../agent/types.ts";
import { Actor, freeze } from "../fsm/fsm.ts";
import { createHost, type StreamUpdateSink, type ToolUpdateSink } from "../host/host.ts";
import type { CompletionPort, PermissionPort } from "../host/ports.ts";
import { copyRegistries } from "../host/ports.ts";
import { diagnostic, diagnosticError } from "../logging/index.ts";
import {
  copyResolvers,
  projectPolicy,
  initialPolicy as resolveInitialPolicy,
  validatePolicy,
  type PolicyPatch,
  type PolicyResolvers,
} from "../policy/policy.ts";
import {
  bindProviders,
  type ProviderBindings,
  type ResolvedModel,
} from "../providers/transport.ts";
import {
  continuationBlobRefs,
  copyBranchBlobs,
  resolveRequestBlobs,
  storeContinuation,
} from "./blobs.ts";
import { EnvEventSchema, type EnvEvent } from "./events.ts";
import { AppendIdSchema, type AppendId, type SessionPersistence } from "./persistence.ts";
import {
  decideSession,
  type CommandReceipt,
  type SessionCommand,
  type SessionEvent,
  type SessionState,
} from "./session-fsm.ts";
import {
  replay,
  seedConversation,
  toSeed,
  wireEvent,
  type JournalState,
  type LastCompletionUsage,
} from "./session-log.ts";
import { appendOperation, loadOperation, loadSession } from "./session-operation.ts";
import {
  ConfigurationSchema,
  SeedSchema,
  SystemVersionSchema,
  type Seed,
  type SessionInput,
} from "./types.ts";

export { defineTool } from "../host/ports.ts";

export type { Tool, AgentDefinition };

export type {
  HostToolNotification,
  ToolUpdateSink,
  HostStreamNotification,
  StreamUpdateSink,
} from "../host/host.ts";

export type { PermissionPort, PermissionRequest, ToolKind, ToolLocation } from "../host/ports.ts";

export type SessionConfiguration = Readonly<{
  agent: string;
  agents: ReadonlyMap<string, AgentDefinition>;
  steps: number;
  systemInputs?: readonly string[];
  policy?: PolicyPatch;
}>;

export type SessionBindings = Readonly<{
  complete?: CompletionPort;
  providers?: ProviderBindings;
  tools?: ReadonlyMap<string, Tool>;
  policies?: PolicyResolvers;
  id?: () => string;
  observe?: (snapshot: SessionState) => unknown;
  toolUpdate?: ToolUpdateSink;
  streamUpdate?: StreamUpdateSink;
  requestPermission?: PermissionPort;
}>;

export type SessionOptions = Readonly<{
  persistence: SessionPersistence;
  configuration: SessionConfiguration;
  bindings: SessionBindings;
  sessionId?: string;
}>;

function bindOptions(options: SessionOptions, restoring = false) {
  const { configuration, bindings } = options;
  const capabilities = {
    agents: [...configuration.agents].map(
      ([name, agent]) => [name, { ...agent, tools: agent.tools ?? [] }] as const,
    ),
  };
  if (Boolean(bindings.complete) === Boolean(bindings.providers))
    throw new Error("Bind exactly one completion port or provider registry");
  const providers = bindings.providers ? bindProviders(bindings.providers) : undefined;
  const resolvers = copyResolvers({
    ...copyResolvers(bindings.policies),
    providerCapabilities: providers?.capabilities,
    validateSelection: providers?.validateSelection,
    providerStreams: providers?.streams,
    permissionRequests: !!bindings.requestPermission,
    providerIds: providers ? new Set(providers.ids) : undefined,
  });
  const initialPolicy = restoring
    ? undefined
    : resolveInitialPolicy(capabilities, configuration.steps, configuration.policy, resolvers);
  if (!restoring && providers && !initialPolicy?.provider)
    throw new Error("Provider-bound sessions require an explicit provider policy");
  const completePort = providers?.complete ?? bindings.complete!;
  const normalized = {
    ...configuration,
    steps: initialPolicy?.steps ?? configuration.steps,
    persistence: options.persistence,
    sessionId: options.sessionId,
    ...bindings,
  };
  return {
    options: normalized,
    resolvers,
    initialPolicy,
    observe: bindings.observe,
    completePort,
    providerMedia: providers?.mediaFor,
    describeModel: providers?.describe,
  };
}

export type TerminalResult =
  | Readonly<{ kind: "terminal"; turnId: ActorId; record: TurnRecord }>
  | Readonly<{ kind: "failed"; message: string; error: Failure }>
  | Readonly<{ kind: "closed"; message: string }>;

export type EnvReceipt = CommandReceipt | Readonly<{ kind: "close_acknowledged" }>;

export type EnvSettlement =
  | TerminalResult
  | Readonly<{ kind: "branch"; session: SessionRuntime }>
  | Readonly<{ kind: "acknowledged"; receipt: EnvReceipt }>;

export type EnvCommandHandle = Readonly<{
  accepted: Promise<EnvReceipt>;
  settled: Promise<EnvSettlement>;
}>;

export type SessionRuntime = {
  readonly snapshot: SessionState;
  readonly model?: ResolvedModel;
  readonly lastCompletionUsage?: LastCompletionUsage;
  fire(event: unknown): Promise<EnvReceipt>;
  dispatch(event: unknown): EnvCommandHandle;
  input(input: string | Omit<Extract<EnvEvent, { type: "user" }>, "type">): {
    accepted: Promise<CommandReceipt>;
    settled: Promise<TerminalResult>;
  };
  updateSystem(inputs: readonly string[]): Promise<CommandReceipt>;
  updatePolicy(patch: PolicyPatch): Promise<CommandReceipt>;
  fork(): Promise<SessionRuntime>;
  compact(context: unknown): Promise<SessionRuntime>;
  close(): Promise<void>;
};

/** Describe binding drift without copying system prompts or JSON-schema bodies into errors. */
function registryDifferences(
  expected: z.infer<typeof ConfigurationSchema>,
  actual: z.infer<typeof ConfigurationSchema>,
): string[] {
  const differences: string[] = [];
  for (const group of ["agents", "tools"] as const) {
    const before = new Map<string, unknown>(expected[group]);
    const after = new Map<string, unknown>(actual[group]);
    const names = [...new Set([...before.keys(), ...after.keys()])].sort();
    for (const name of names) {
      const path = `${group}.${name}`;
      if (!after.has(name)) differences.push(`missing ${path}`);
      else if (!before.has(name)) differences.push(`added ${path}`);
      else if (JSON.stringify(before.get(name)) !== JSON.stringify(after.get(name))) {
        if (group === "tools") differences.push(`changed ${path}.parameters`);
        else {
          const previous = before.get(name) as Record<string, unknown>;
          const current = after.get(name) as Record<string, unknown>;
          const fields = [...new Set([...Object.keys(previous), ...Object.keys(current)])].sort();
          const changed = fields.filter(
            (field) => JSON.stringify(previous[field]) !== JSON.stringify(current[field]),
          );
          for (const field of changed) differences.push(`changed ${path}.${field}`);
          if (!changed.length) differences.push(`changed ${path} serialization order`);
        }
      }
    }
    if (
      JSON.stringify([...before.keys()]) !== JSON.stringify([...after.keys()]) &&
      names.every((name) => before.has(name) && after.has(name))
    )
      differences.push(`changed ${group} registry order`);
  }
  return differences;
}

function configure(raw: SessionOptions, restoring = false) {
  const { options, resolvers, initialPolicy, observe, completePort, providerMedia, describeModel } =
    bindOptions(raw, restoring);
  const toolUpdate = options.toolUpdate;
  const streamUpdate = options.streamUpdate;
  const requestPermission = options.requestPermission;
  const agentId = AgentIdSchema.parse(options.agent);
  const steps = StepsSchema.parse(options.steps);
  const { agents, tools } = copyRegistries(options);
  if (!agents.has(agentId)) throw new Error(`Unknown agent: ${agentId}`);
  const configuration = ConfigurationSchema.parse({
    agents: [...agents],
    tools: [...tools].map(([name, tool]) => [name, tool.parameters]),
  });
  const id = options.id ?? (() => crypto.randomUUID());
  const port = options.persistence;
  if (!port) throw new Error("Session persistence is required");

  async function initialize(seed: Seed): Promise<SessionRuntime> {
    const built = build(seedConversation(seed, resolvers));
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
  function build(initial: JournalState) {
    const sessionId = initial.conversation.sessionId;
    if (initial.policy) validatePolicy(initial.policy, initial.configuration, resolvers);
    if (JSON.stringify(initial.configuration) !== JSON.stringify(configuration)) {
      const differences = registryDifferences(initial.configuration, configuration);
      throw Object.assign(
        new Error(
          `Session configuration does not match persisted registry: ${differences.join("; ")}`,
        ),
        { differences },
      );
    }
    const branchReplies = new Map<
      ActorId,
      { resolve: (runtime: SessionRuntime) => void; reject: (error: unknown) => void }
    >();
    const receipts = new Map<string, (receipt: CommandReceipt) => void>();
    const afterCommit = new Map<string, () => void>();
    const admissions = new Map<string, (result: TerminalResult) => void>();
    const waiters = new Map<ActorId, ((result: TerminalResult) => void)[]>();
    const queuedWaiters = new Map<string, (result: TerminalResult) => void>();

    const storage = new Set<{ cancel(): Promise<unknown> }>();
    let session: Actor<SessionState, SessionEvent, SessionCommand>;
    let dispatchBoundary = initial;
    const input = (turn: TurnData): PromptInput => ({
      context: session.snapshot.durable.conversation.context,
      log: session.snapshot.durable.conversation.log,
      turn,
      agent: {
        ...agents.get(turn.agent)!,
        tools: session.snapshot.durable.policy?.tools[turn.agent] ?? agents.get(turn.agent)!.tools,
      },
    });
    let observedTransition = "";
    let observedUsage = initial.lastCompletionUsage?.operationId;

    function send(event: SessionEvent) {
      return session.send(event).then((snapshot) => {
        const usage = snapshot.durable.lastCompletionUsage;
        if (usage && usage.operationId !== observedUsage) {
          observedUsage = usage.operationId;
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
        if (transition !== observedTransition) {
          diagnostic(
            "session",
            snapshot.status === "failed" ? "error" : "debug",
            "session.transition",
            {
              sessionId,
              turnId: snapshot.durable.conversation.turnId,
              previousStatus: observedTransition || undefined,
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
          observedTransition = transition;
        }
        try {
          const result = observe?.(snapshot);
          if (result instanceof Promise) void result.catch(() => {});
        } catch {
          /* Observation cannot change execution. */
        }
        return snapshot;
      });
    }
    const post = (turnId: ActorId, event: TurnEvent) => {
      void submit({
        kind: "event",
        event: wireEvent({ type: "child", turnId, event }),
        systemVersion: session.snapshot.durable.systemVersion,
      });
    };
    const host = createHost(
      {
        agents,
        tools,
        sessionId,
        requestPermission,
        complete: completePort,
      },
      {
        turn: post,
        toolUpdate,
        streamUpdate,
        tool: (outcome) => {
          void submit({ kind: "tool", ...outcome }, () => host.releaseTool(outcome));
        },
      },
    );
    async function initializeBranch(seed: Seed) {
      const controller = new AbortController();
      const owned = { cancel: async () => controller.abort() };
      storage.add(owned);
      try {
        await copyBranchBlobs(
          port,
          sessionId,
          seed.sessionId,
          [
            ...blobRefs([...seed.context, ...seed.log.flatMap((record) => record.messages)]),
            ...continuationBlobRefs(seed.continuations ?? []),
          ],
          controller.signal,
        );
        controller.signal.throwIfAborted();
        return await initialize(seed);
      } finally {
        storage.delete(owned);
      }
    }
    const execute = (effect: ConversationCommand): undefined => {
      if (effect.type === "reply") {
        const reply = branchReplies.get(effect.requestId);
        if (reply)
          void initializeBranch(toSeed(dispatchBoundary, effect.result.state)).then(
            (child) => {
              branchReplies.delete(effect.requestId);
              if (session.snapshot.status === "closed" || session.snapshot.status === "failed") {
                void child.close();
                reply.reject(new Error("Parent closed before branch publication"));
              } else reply.resolve(child);
            },
            (error) => {
              branchReplies.delete(effect.requestId);
              reply.reject(error);
            },
          );
        return undefined;
      }
      const durable = session.snapshot.durable;
      const policy = durable.policy;
      const prompt = "turn" in effect.command ? input(effect.command.turn) : undefined;
      host.dispatch(effect, {
        prompt,
        allowedTools: prompt?.agent.tools,
        toolFailure: policy?.toolFailure,
        permissions: policy?.permissions,
        policyVersion: policy?.version,
        completionTimeoutMs: policy?.completionTimeoutMs ?? undefined,
        toolTimeoutMs: policy?.toolTimeoutMs ?? undefined,
        provider: policy,
        continuations: durable.continuations,
        storeContinuation: (entry, signal) => storeContinuation(port, sessionId, entry, signal),
        loadBlobs: (request, signal, includeContinuations) =>
          resolveRequestBlobs(
            port,
            sessionId,
            request,
            providerMedia?.(request.provider ?? "", request.model) ?? [],
            signal,
            includeContinuations,
          ),
        projectPrompt: (value) => projectPolicy(value, durable.systemInputs, policy, resolvers),
        projectHandoff: (value) => resolvers.handoffs.get(policy.handoff)!(value),
      });
      return undefined;
    };
    function submit(
      input: SessionInput,
      committed?: () => void,
      settlement?: (result: TerminalResult) => void,
      stableAppendId?: AppendId,
    ): Promise<CommandReceipt> {
      const requestId = stableAppendId ?? id();
      return new Promise((resolve) => {
        receipts.set(requestId, resolve);
        if (committed) afterCommit.set(requestId, committed);
        if (settlement) admissions.set(requestId, settlement);
        void send({
          type: "submit",
          submission: {
            id: requestId,
            appendId:
              stableAppendId ??
              AppendIdSchema.parse(`${initial.conversation.sessionId}/append/${requestId}`),
            input,
          },
        });
      });
    }
    function stop() {
      diagnostic("session", "info", "session.stopped", {
        sessionId,
        status: session.snapshot.status,
      });
      host.close();
      for (const actor of storage) void actor.cancel();
      const result: TerminalResult =
        session.snapshot.status === "closed"
          ? { kind: "closed", message: "Session closed" }
          : {
              kind: "failed",
              message:
                session.snapshot.status === "failed"
                  ? session.snapshot.error.message
                  : "Session stopped",
              error:
                session.snapshot.status === "failed"
                  ? session.snapshot.error
                  : failure("Session stopped", {
                      classification: "interrupted",
                      operation: { id: sessionId, kind: "admission", sessionId },
                      phase: "stop",
                    }),
            };
      for (const settle of admissions.values()) settle(result);
      admissions.clear();
      for (const group of waiters.values()) for (const settle of group) settle(result);
      waiters.clear();
      for (const settle of queuedWaiters.values()) settle(result);
      queuedWaiters.clear();
      for (const reply of branchReplies.values())
        reply.reject(result.kind === "failed" ? result.error : new Error(result.message));
      branchReplies.clear();
    }
    const executeSession = (command: SessionCommand): undefined => {
      switch (command.type) {
        case "append": {
          const actor = appendOperation(port, command.request);
          storage.add(actor);
          void actor.start();
          void actor.result.then((result) => {
            storage.delete(actor);
            return send({ type: "appended", appendId: command.request.appendId, result });
          });
          break;
        }
        case "load": {
          diagnostic("session", "warning", "append.reconciling", {
            sessionId,
            appendId: command.appendId,
          });
          const actor = loadOperation(port, initial.conversation.sessionId);
          storage.add(actor);
          void actor.start();
          void actor.result.then((result) => {
            storage.delete(actor);
            return send({ type: "loaded", appendId: command.appendId, result });
          });
          break;
        }
        case "dispatch": {
          dispatchBoundary = command.durable;
          const terminal = command.durable.records.at(-1)?.body;
          const newBodies = command.durable.records
            .filter((record) => record.appendId === command.submission.appendId)
            .map((record) => record.body);
          for (const body of newBodies)
            if (body.kind === "dequeued") {
              const waiting = queuedWaiters.get(body.inputId);
              if (waiting) {
                queuedWaiters.delete(body.inputId);
                const turnId =
                  terminal?.kind === "terminal"
                    ? terminal.turnId
                    : command.durable.conversation.turnId;
                waiters.set(turnId, [...(waiters.get(turnId) ?? []), waiting]);
              }
            }
          for (const body of newBodies) {
            if (body.kind === "policy")
              diagnostic("session", "info", "policy.committed", {
                sessionId,
                appendId: command.submission.appendId,
                requestId: command.submission.id,
                revision: command.durable.revision,
                policy: body.policy,
              });
          }
          const admission = admissions.get(command.submission.id);
          if (admission) {
            admissions.delete(command.submission.id);
            const queued = newBodies.find((body) => body.kind === "queued");
            if (queued?.kind === "queued") queuedWaiters.set(queued.inputId, admission);
            else {
              const turnId =
                terminal?.kind === "terminal"
                  ? terminal.turnId
                  : command.durable.conversation.turnId;
              waiters.set(turnId, [...(waiters.get(turnId) ?? []), admission]);
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
          afterCommit.get(command.submission.id)?.();
          afterCommit.delete(command.submission.id);
          if (terminal?.kind === "terminal") {
            const input = command.submission.input;
            const trigger =
              input.kind === "event" && input.event.type === "child"
                ? input.event.event
                : undefined;
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
            for (const settle of waiters.get(terminal.turnId) ?? [])
              settle({ kind: "terminal", turnId: terminal.turnId, record: terminal.record });
            waiters.delete(terminal.turnId);
          }
          for (const effect of command.commands) {
            try {
              execute(effect);
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
                post(effect.turnId, {
                  type: "failed",
                  child: effect.command.child,
                  error: failure(error),
                });
              else {
                const reply = branchReplies.get(effect.requestId);
                branchReplies.delete(effect.requestId);
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
          receipts.get(command.id)?.(command.result);
          receipts.delete(command.id);
          afterCommit.delete(command.id);
          const settle = admissions.get(command.id);
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
                        turnId: session.snapshot.durable.conversation.turnId,
                      },
                      phase: "admission",
                      details: { outcome: command.result.kind },
                    }),
            });
            admissions.delete(command.id);
          }
          break;
        }
        case "drain":
          void send({ type: "drain" });
          break;
        case "stop":
          stop();
          break;
      }
      return undefined;
    };
    session = new Actor<SessionState, SessionEvent, SessionCommand>(
      { status: "ready", durable: initial, queue: [] },
      (state, event) => decideSession(state, event, resolvers),
      executeSession,
      () => ({ type: "close" }),
    );
    function branch(request: SessionRequest) {
      let resolve!: (runtime: SessionRuntime) => void;
      let reject!: (error: unknown) => void;
      const settled = new Promise<SessionRuntime>((done, failed) => {
        resolve = done;
        reject = failed;
      });
      branchReplies.set(request.id, { resolve, reject });
      const accepted = submit({
        kind: "event",
        event: wireEvent({ type: "request", request }),
        systemVersion: session.snapshot.durable.systemVersion,
      });
      void accepted.then((receipt) => {
        if (receipt.kind !== "accepted") {
          branchReplies.delete(request.id);
          reject(new Error(`Branch ${receipt.kind}`));
        }
      });
      return { accepted, settled };
    }
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
      const event = EnvEventSchema.parse(raw);
      diagnostic("session", "debug", "event.received", { sessionId, operation: event.type });
      if (event.type === "user") {
        let settle!: (result: TerminalResult) => void;
        const settled = new Promise<TerminalResult>((resolve) => {
          settle = resolve;
        });
        const accepted = submit(
          { kind: "event", event, systemVersion: session.snapshot.durable.systemVersion },
          undefined,
          settle,
        );
        return { accepted, settled };
      }
      if (event.type === "fork" || event.type === "compact") {
        const request = { id: ActorIdSchema.parse(id()), sessionId: SessionIdSchema.parse(id()) };
        const handle = branch(
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
        const accepted = send({ type: "close" }).then(() => ({
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
              version: SystemVersionSchema.parse(session.snapshot.durable.systemVersion + 1),
            }
          : event.type === "policy"
            ? { kind: "policy", patch: event.patch }
            : { kind: "event", event, systemVersion: session.snapshot.durable.systemVersion };
      const accepted = submit(input);
      return { accepted, settled: accepted.then((receipt) => ({ kind: "acknowledged", receipt })) };
    }
    const publishBranch = async (event: EnvEvent): Promise<SessionRuntime> => {
      const result = await dispatch(event).settled;
      if (result.kind !== "branch")
        throw new Error("message" in result ? result.message : "Branch was not published");
      return result.session;
    };
    const runtime: SessionRuntime = {
      get snapshot() {
        return session.snapshot;
      },
      get lastCompletionUsage() {
        return session.snapshot.durable.lastCompletionUsage;
      },
      get model() {
        const { policy, conversation } = session.snapshot.durable;
        const agent =
          conversation.turn.status === "idle"
            ? conversation.turn.agent
            : conversation.turn.turn.agent;
        return policy.provider
          ? describeModel?.(policy.provider, policy.model ?? agents.get(agent)!.model)
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
    return { runtime, submit };
  }
  return {
    agentId,
    steps,
    configuration,
    id,
    initialize,
    build,
    options,
    resolvers,
    initialPolicy,
  };
}

export async function createSession(options: SessionOptions): Promise<SessionRuntime> {
  const configured = configure(options);
  const sessionId = SessionIdSchema.parse(configured.options.sessionId ?? configured.id());
  return configured.initialize(
    SeedSchema.parse({
      sessionId,
      origin: { kind: "root" },
      context: [],
      log: [],
      agent: configured.agentId,
      allowance: configured.steps,
      sequence: 1,
      systemInputs: configured.options.systemInputs ?? [],
      ...(configured.initialPolicy ? { policy: configured.initialPolicy } : {}),
      systemVersion: 0,
      configuration: configured.configuration,
    }),
  );
}

export async function restoreSession(
  options: SessionOptions,
  rawSessionId: string,
): Promise<SessionRuntime> {
  const sessionId = SessionIdSchema.parse(rawSessionId);
  const startedAt = performance.now();
  let stage = "configure_bindings";
  try {
    const configured = configure(options, true);
    diagnostic("session", "info", "session.restoring", { sessionId });
    stage = "load_journal";
    const loaded = await loadSession(options.persistence, sessionId);
    if (loaded.kind !== "loaded")
      throw new Error(loaded.kind === "not_found" ? "Session not found" : loaded.message, {
        cause: loaded.kind === "failed" ? loaded.error : undefined,
      });
    stage = "replay_journal";
    const journal = replay(loaded.batches, configured.resolvers);
    if (journal.conversation.sessionId !== sessionId || journal.revision !== loaded.revision)
      throw new Error("Loaded stream identity/revision mismatch");
    stage = "validate_registry";
    const built = configured.build(
      freeze({ ...journal, conversation: { ...journal.conversation, pending: [] } }),
    );
    if (journal.conversation.turn.status !== "idle" || journal.pendingInputs?.length) {
      stage = "recover_interrupted_turn";
      diagnostic("session", "warning", "session.recovering", {
        sessionId,
        turnId: journal.conversation.turnId,
        phase: journal.conversation.turn.status,
        revision: journal.revision,
        reason: "Interrupted operation; external effects will not be replayed",
      });
      const receipt = await built.submit(
        {
          kind: "recovery",
          turnId: journal.conversation.turnId,
          reason: "Interrupted session; external effects were not replayed",
        },
        undefined,
        undefined,
        AppendIdSchema.parse(`recovery/${sessionId}/${journal.conversation.turnId}`),
      );
      if (receipt.kind !== "accepted") {
        await built.runtime.close();
        throw new Error(receipt.kind === "failed" ? receipt.message : `Recovery ${receipt.kind}`, {
          cause: receipt.kind === "failed" ? receipt.error : undefined,
        });
      }
    }
    diagnostic("session", "info", "session.restored", {
      sessionId,
      revision: built.runtime.snapshot.durable.revision,
      durationMs: Math.round(performance.now() - startedAt),
      provider: built.runtime.snapshot.durable.policy?.provider,
      model: built.runtime.snapshot.durable.policy?.model,
    });
    return built.runtime;
  } catch (error) {
    diagnostic("session", "error", "session.restore_failed", {
      sessionId,
      stage,
      durationMs: Math.round(performance.now() - startedAt),
      error: diagnosticError(error),
    });
    throw error;
  }
}
