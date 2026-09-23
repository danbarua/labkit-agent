import { z } from "zod";
import { bindProviders, type ProviderBindings } from "../providers/transport.ts";

import type { ConversationCommand, SessionRequest } from "../agent/agent-conversation.ts";
import type { TurnEvent } from "../agent/agent-fsm.ts";
import type { AgentDefinition, RuntimeOptions, Tool } from "../agent/agent-runtime.ts";
import {
  createChatCompletion,
  PreparedModelSchema,
  type ChatCompletionRequest,
} from "../agent/agent.ts";
import { parseSessionContext, type PromptInput } from "../agent/prompt.ts";
import {
  ActorIdSchema,
  AgentIdSchema,
  failure,
  SessionIdSchema,
  StepsSchema,
  type ActorId,
  type TurnData,
  type TurnRecord,
} from "../agent/types.ts";
import { diagnostic } from "../logging/index.ts";
import { Actor, freeze } from "../fsm/fsm.ts";
import { createHost } from "../host/host.ts";
import type { CompletionPort } from "../host/ports.ts";
import { copyRegistries } from "../host/ports.ts";
import {
  copyResolvers,
  projectPolicy,
  initialPolicy as resolveInitialPolicy,
  validatePolicy,
  type PolicyPatch,
  type PolicyResolvers,
} from "../policy/policy.ts";
import { EnvEventSchema, type EnvEvent } from "./events.ts";
import { AppendIdSchema, type AppendId, type SessionPersistence } from "./persistence.ts";
import {
  decideSession,
  type CommandReceipt,
  type SessionCommand,
  type SessionEvent,
  type SessionState,
} from "./session-fsm.ts";
import { replay, seedConversation, toSeed, wireEvent, type JournalState } from "./session-log.ts";
import { appendOperation, loadOperation, loadSession } from "./session-operation.ts";
import { projectSessionPrompt } from "./session-prompt.ts";
import {
  ConfigurationSchema,
  SeedSchema,
  SystemVersionSchema,
  type Seed,
  type SessionInput,
} from "./types.ts";

export { defineTool } from "../host/ports.ts";
export type { Tool, AgentDefinition };
/** Compatibility input: new integrations should supply SessionConfiguration and SessionBindings. */
export type LegacySessionOptions = Omit<RuntimeOptions, "projectPrompt"> & {
  persistence: SessionPersistence;
  sessionId?: string;
  systemInputs?: readonly string[];
  /** UUIDs for session identities; arbitrary nonempty strings for append/request IDs. */
  id?: () => string;
};
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
}>;
export type BoundSessionOptions = Readonly<{
  persistence: SessionPersistence;
  configuration: SessionConfiguration;
  bindings: SessionBindings;
  sessionId?: string;
}>;
export type SessionOptions = LegacySessionOptions | BoundSessionOptions;
function normalizeOptions(options: SessionOptions, restoring = false) {
  if (!("configuration" in options))
    return { options, resolvers: copyResolvers(), initialPolicy: undefined, observe: undefined };
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
    providerIds: providers ? new Set(providers.ids) : undefined,
  });
  const initialPolicy = restoring
    ? undefined
    : resolveInitialPolicy(capabilities, configuration.steps, configuration.policy, resolvers);
  if (!restoring && providers && !initialPolicy?.provider)
    throw new Error("Provider-bound sessions require an explicit provider policy");
  const completePort = providers?.complete ?? bindings.complete!;
  const normalized: LegacySessionOptions = {
    ...configuration,
    steps: initialPolicy?.steps ?? configuration.steps,
    persistence: options.persistence,
    sessionId: options.sessionId,
    tools: bindings.tools,
    id: bindings.id,
    baseUrl: "https://journal.invalid",
    complete: (request) => {
      const { signal, baseUrl: _baseUrl, apiKey: _apiKey, ...prepared } = request;
      return completePort(PreparedModelSchema.parse(prepared), signal!);
    },
  };
  return { options: normalized, resolvers, initialPolicy, observe: bindings.observe };
}
export type TerminalResult =
  | Readonly<{ kind: "terminal"; turnId: ActorId; record: TurnRecord }>
  | Readonly<{ kind: "failed" | "closed"; message: string }>;
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
  fire(event: unknown): Promise<EnvReceipt>;
  dispatch(event: unknown): EnvCommandHandle;
  input(text: string): { accepted: Promise<CommandReceipt>; settled: Promise<TerminalResult> };
  updateSystem(inputs: readonly string[]): Promise<CommandReceipt>;
  updatePolicy(patch: PolicyPatch): Promise<CommandReceipt>;
  fork(): Promise<SessionRuntime>;
  compact(context: unknown): Promise<SessionRuntime>;
  close(): Promise<void>;
};

function configure(raw: SessionOptions, restoring = false) {
  const { options, resolvers, initialPolicy, observe } = normalizeOptions(raw, restoring);
  const agentId = AgentIdSchema.parse(options.agent);
  const steps = StepsSchema.parse(options.steps);
  const baseUrl = z.url({ protocol: /^https?$/ }).parse(options.baseUrl);
  const { agents, tools } = copyRegistries(options);
  if (!agents.has(agentId)) throw new Error(`Unknown agent: ${agentId}`);
  const configuration = ConfigurationSchema.parse({
    agents: [...agents],
    tools: [...tools].map(([name, tool]) => [name, tool.parameters]),
  });
  const apiKey = options.apiKey;
  const fetcher = options.fetch;
  const projectHandoff = options.projectHandoff;
  const complete =
    options.complete ??
    ((request: ChatCompletionRequest) => createChatCompletion(request, fetcher));
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
      throw new Error(receipt.kind === "failed" ? receipt.message : `Creation ${receipt.kind}`);
    }
    return built.runtime;
  }
  function build(initial: JournalState) {
    const sessionId = initial.conversation.sessionId;
    if (initial.policy) validatePolicy(initial.policy, initial.configuration, resolvers);
    if (JSON.stringify(initial.configuration) !== JSON.stringify(configuration))
      throw new Error("Session configuration does not match persisted registry");
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
    function send(event: SessionEvent) {
      return session.send(event).then((snapshot) => {
        diagnostic(
          "session",
          snapshot.status === "failed" ? "error" : "debug",
          "session.observed",
          {
            sessionId,
            status: snapshot.status,
            revision: snapshot.durable.revision,
            operation: event.type,
          },
        );
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
        complete: (request, signal) => complete({ ...request, baseUrl, apiKey, signal }),
      },
      {
        turn: post,
        tool: (outcome) => {
          void submit({ kind: "tool", ...outcome }, () => host.releaseTool(outcome));
        },
      },
    );
    const execute = (effect: ConversationCommand): undefined => {
      if (effect.type === "reply") {
        const reply = branchReplies.get(effect.requestId);
        if (reply)
          void initialize(toSeed(dispatchBoundary, effect.result.state)).then(
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
        provider: policy,
        projectPrompt: (value) =>
          policy
            ? projectPolicy(value, durable.systemInputs, policy, resolvers)
            : projectSessionPrompt(value, durable.systemInputs),
        projectHandoff: policy
          ? (value) => resolvers.handoffs.get(policy.handoff)!(value)
          : projectHandoff,
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
          : { kind: "failed", message: "Session persistence failed" };
      for (const settle of admissions.values()) settle(result);
      admissions.clear();
      for (const group of waiters.values()) for (const settle of group) settle(result);
      waiters.clear();
      for (const settle of queuedWaiters.values()) settle(result);
      queuedWaiters.clear();
      for (const reply of branchReplies.values()) reply.reject(new Error(result.message));
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
          // Forward a committed individual result before processing a queued cancellation.
          afterCommit.get(command.submission.id)?.();
          afterCommit.delete(command.submission.id);
          if (terminal?.kind === "terminal") {
            diagnostic(
              "session",
              terminal.record.outcome.kind === "failed" ? "warning" : "info",
              "turn.settled",
              {
                sessionId,
                turnId: terminal.turnId,
                outcome: terminal.record.outcome.kind,
                revision: command.durable.revision,
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
            },
          );
          receipts.get(command.id)?.(command.result);
          receipts.delete(command.id);
          afterCommit.delete(command.id);
          const settle = admissions.get(command.id);
          if (settle) {
            settle({ kind: "failed", message: `Input ${command.result.kind}` });
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
            (error) => ({ kind: "failed" as const, message: failure(error).message }),
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
      if (event.type === "policy" && projectHandoff && !session.snapshot.durable.policy) {
        const accepted = Promise.resolve<CommandReceipt>({
          kind: "failed",
          message: "Bind a named handoff policy before upgrading a legacy callback",
        });
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
      dispatch,
      fire: (raw) => dispatch(raw).accepted,
      input: (text) => dispatch({ type: "user", text }),
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
  const configured = configure(options, true);
  const sessionId = SessionIdSchema.parse(rawSessionId);
  diagnostic("session", "info", "session.restoring", { sessionId });
  const loaded = await loadSession(options.persistence, sessionId);
  if (loaded.kind !== "loaded")
    throw new Error(loaded.kind === "not_found" ? "Session not found" : loaded.message);
  const journal = replay(loaded.batches, configured.resolvers);
  if (journal.conversation.sessionId !== sessionId || journal.revision !== loaded.revision)
    throw new Error("Loaded stream identity/revision mismatch");
  const built = configured.build(
    freeze({ ...journal, conversation: { ...journal.conversation, pending: [] } }),
  );
  if (journal.conversation.turn.status !== "idle" || journal.pendingInputs?.length) {
    diagnostic("session", "warning", "session.recovering", {
      sessionId,
      turnId: journal.conversation.turnId,
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
      throw new Error(receipt.kind === "failed" ? receipt.message : `Recovery ${receipt.kind}`);
    }
  }
  diagnostic("session", "info", "session.restored", {
    sessionId,
    revision: built.runtime.snapshot.durable.revision,
  });
  return built.runtime;
}
