import { z } from "zod";
import { Actor, freeze } from "../fsm/fsm.ts";
import {
  createChatCompletion,
  PreparedModelSchema,
  type ChatCompletionRequest,
} from "../agent/agent.ts";
import { admittedCompletionSchema, type TurnEvent } from "../agent/agent-fsm.ts";
import type { ConversationCommand, SessionRequest } from "../agent/agent-conversation.ts";
import {
  createOperationActor,
  type Operation,
  type OperationState,
} from "../agent/operation-actor.ts";
import { parseSessionContext, type PromptInput } from "../agent/prompt.ts";
import {
  toolBatchMachine,
  type BatchCommand,
  type BatchEvent,
  type BatchState,
} from "../agent/tool-batch.ts";
import {
  ActorIdSchema,
  SessionIdSchema,
  AgentIdSchema,
  MessagesSchema,
  StepsSchema,
  ToolNameSchema,
  UserEventSchema,
  failure,
  type ActorId,
  type ChildRef,
  type Result,
  type TurnData,
  type TurnRecord,
} from "../agent/types.ts";
import type { RuntimeOptions, Tool, AgentDefinition } from "../agent/agent-runtime.ts";
import { AppendIdSchema, type AppendId, type SessionPersistence } from "./persistence.ts";
import { appendOperation, loadOperation, loadSession } from "./session-operation.ts";
import {
  decideSession,
  type SessionState,
  type SessionEvent,
  type SessionCommand,
  type CommandReceipt,
} from "./session-fsm.ts";
import { replay, seedConversation, toSeed, wireEvent, type JournalState } from "./session-log.ts";
import {
  AgentDefinitionSchema,
  ConfigurationSchema,
  SeedSchema,
  SystemInputsSchema,
  SystemVersionSchema,
  type Seed,
  type SessionInput,
} from "./types.ts";
import { projectSessionPrompt } from "./session-prompt.ts";

export { defineTool } from "../agent/agent-runtime.ts";
export type { Tool, AgentDefinition };
export type SessionOptions = Omit<RuntimeOptions, "projectPrompt"> & {
  persistence: SessionPersistence;
  sessionId?: string;
  systemInputs?: readonly string[];
  /** UUIDs for session identities; arbitrary nonempty strings for append/request IDs. */
  id?: () => string;
};
export type TerminalResult =
  | Readonly<{ kind: "terminal"; turnId: ActorId; record: TurnRecord }>
  | Readonly<{ kind: "failed" | "closed"; message: string }>;
export type SessionRuntime = {
  readonly snapshot: SessionState;
  fire(event: unknown): Promise<CommandReceipt>;
  input(text: string): { accepted: Promise<CommandReceipt>; settled: Promise<TerminalResult> };
  updateSystem(inputs: readonly string[]): Promise<CommandReceipt>;
  fork(): Promise<SessionRuntime>;
  compact(context: unknown): Promise<SessionRuntime>;
  close(): Promise<void>;
};
type Child = {
  readonly snapshot: OperationState<unknown> | BatchState;
  cancel(): Promise<unknown>;
};

function configure(options: SessionOptions) {
  const agentId = AgentIdSchema.parse(options.agent);
  const steps = StepsSchema.parse(options.steps);
  const baseUrl = z.url({ protocol: /^https?$/ }).parse(options.baseUrl);
  const agents = new Map(
    [...options.agents].map(([id, definition]) => [
      AgentIdSchema.parse(id),
      AgentDefinitionSchema.parse(definition),
    ]),
  );
  if (!agents.has(agentId)) throw new Error(`Unknown agent: ${agentId}`);
  const tools = new Map(
    [...(options.tools ?? [])].map(([name, tool]) => [
      ToolNameSchema.parse(name),
      Object.freeze({ ...tool, parameters: freeze(structuredClone(tool.parameters)) }),
    ]),
  );
  for (const definition of agents.values())
    for (const name of definition.tools)
      if (!tools.has(ToolNameSchema.parse(name))) throw new Error(`Unknown tool: ${name}`);
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
    const built = build(seedConversation(seed));
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
    const children = new Map<ActorId, { ref: ChildRef; actor: Child }>();
    const storage = new Set<{ cancel(): Promise<unknown> }>();
    let session: Actor<SessionState, SessionEvent, SessionCommand>;
    let dispatchBoundary = initial;
    const input = (turn: TurnData): PromptInput => ({
      context: session.snapshot.durable.conversation.context,
      log: session.snapshot.durable.conversation.log,
      turn,
      agent: agents.get(turn.agent)!,
    });
    const project = (value: PromptInput, _signal: AbortSignal) =>
      projectSessionPrompt(value, session.snapshot.durable.systemInputs);
    const post = (turnId: ActorId, event: TurnEvent) => {
      void submit({
        kind: "event",
        event: wireEvent({ type: "child", turnId, event }),
        systemVersion: session.snapshot.durable.systemVersion,
      });
    };
    function spawn<I, O>(
      child: ChildRef,
      operation: Operation<I, O>,
      settled: (result: Result<O>) => void,
    ) {
      const actor = createOperationActor(child, operation, (result) => {
        children.delete(child.id);
        settled(result);
      });
      children.set(child.id, { ref: child, actor });
      void actor.start();
    }
    const cancel = (child: ChildRef) => {
      void children.get(child.id)?.actor.cancel();
    };
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
      const { turnId, command } = effect;
      switch (command.type) {
        case "cancel":
          cancel(command.child);
          break;
        case "prepare_model": {
          const agent = agents.get(command.turn.agent)!;
          spawn(
            command.child,
            {
              input: null,
              parseInput: z.null().parse,
              run: async (_, signal) => ({
                baseUrl,
                apiKey,
                model: agent.model,
                messages: await project(input(command.turn), signal),
                tools: agent.tools.map((name) => ({
                  type: "function",
                  function: {
                    name,
                    description: tools.get(name)!.description,
                    parameters: tools.get(name)!.parameters,
                  },
                })),
              }),
              parseOutput: PreparedModelSchema.parseAsync,
            },
            (result) => post(turnId, { type: "prepared", child: command.child, result }),
          );
          break;
        }
        case "complete": {
          const admitted = admittedCompletionSchema(
            new Set(agents.keys()),
            new Set(agents.get(command.turn.agent)!.tools),
          );
          spawn(
            command.child,
            {
              input: { ...command.request, baseUrl, apiKey },
              parseInput: PreparedModelSchema.parseAsync,
              run: (request, signal) => complete({ ...request, signal }),
              parseOutput: admitted.parseAsync,
            },
            (result) => post(turnId, { type: "model_settled", child: command.child, result }),
          );
          break;
        }
        case "prepare_handoff": {
          spawn(
            command.child,
            {
              input: null,
              parseInput: z.null().parse,
              run: (_, signal) =>
                projectHandoff
                  ? projectHandoff(
                      { ...input(command.turn), from: command.from, to: command.turn.agent },
                      signal,
                    )
                  : [
                      command.turn.messages.findLast((message) => message.role === "user"),
                      command.turn.messages.at(-1),
                    ].filter((message) => message !== undefined),
              parseOutput: MessagesSchema.parseAsync,
            },
            (result) => post(turnId, { type: "handoff_prepared", child: command.child, result }),
          );
          break;
        }
        case "run_tools": {
          let batch: Actor<BatchState, BatchEvent, BatchCommand>;
          const runBatchCommand = (batchCommand: BatchCommand): undefined => {
            switch (batchCommand.type) {
              case "spawn_tool": {
                const tool = tools.get(batchCommand.call.name)!;
                spawn(
                  batchCommand.child,
                  {
                    input: batchCommand.call.args,
                    parseInput: tool.parseInput,
                    run: tool.run,
                    parseOutput: (value) => {
                      const json = z.json().parse(value);
                      return typeof json === "string" ? json : JSON.stringify(json);
                    },
                  },
                  (result) => {
                    void submit(
                      {
                        kind: "tool",
                        turnId,
                        batchId: command.child.id,
                        callId: batchCommand.call.id,
                        result,
                      },
                      () => {
                        void batch.send({
                          type: "tool_settled",
                          callId: batchCommand.call.id,
                          result,
                        });
                      },
                    );
                  },
                );
                break;
              }
              case "cancel_tool":
                cancel(batchCommand.child);
                break;
              case "notify":
                children.delete(command.child.id);
                post(turnId, {
                  type: "batch_settled",
                  child: command.child,
                  outcome: batchCommand.outcome,
                });
                break;
            }
            return undefined;
          };
          batch = new Actor<BatchState, BatchEvent, BatchCommand>(
            { status: "ready", calls: command.completion.calls },
            toolBatchMachine(command.child),
            runBatchCommand,
            (_, error) => ({ type: "failed", error: failure(error) }),
          );
          children.set(command.child.id, {
            ref: command.child,
            actor: {
              get snapshot() {
                return batch.snapshot;
              },
              cancel: () => batch.send({ type: "cancel" }),
            },
          });
          void batch.send({ type: "start" });
          break;
        }
      }
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
        void session.send({
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
      for (const { actor } of children.values()) void actor.cancel();
      for (const actor of storage) void actor.cancel();
      const result: TerminalResult =
        session.snapshot.status === "closed"
          ? { kind: "closed", message: "Session closed" }
          : { kind: "failed", message: "Session persistence failed" };
      for (const settle of admissions.values()) settle(result);
      admissions.clear();
      for (const group of waiters.values()) for (const settle of group) settle(result);
      waiters.clear();
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
            return session.send({ type: "appended", appendId: command.request.appendId, result });
          });
          break;
        }
        case "load": {
          const actor = loadOperation(port, initial.conversation.sessionId);
          storage.add(actor);
          void actor.start();
          void actor.result.then((result) => {
            storage.delete(actor);
            return session.send({ type: "loaded", appendId: command.appendId, result });
          });
          break;
        }
        case "dispatch": {
          dispatchBoundary = command.durable;
          const terminal = command.durable.records.at(-1)?.body;
          const admission = admissions.get(command.submission.id);
          if (admission) {
            admissions.delete(command.submission.id);
            const turnId =
              terminal?.kind === "terminal" ? terminal.turnId : command.durable.conversation.turnId;
            waiters.set(turnId, [...(waiters.get(turnId) ?? []), admission]);
          }
          // Forward a committed individual result before processing a queued cancellation.
          afterCommit.get(command.submission.id)?.();
          afterCommit.delete(command.submission.id);
          if (terminal?.kind === "terminal") {
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
            }
          }
          break;
        }
        case "reply": {
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
          void session.send({ type: "drain" });
          break;
        case "stop":
          stop();
          break;
      }
      return undefined;
    };
    session = new Actor<SessionState, SessionEvent, SessionCommand>(
      { status: "ready", durable: initial, queue: [] },
      decideSession,
      executeSession,
      () => ({ type: "close" }),
    );
    const branch = (request: SessionRequest): Promise<SessionRuntime> =>
      new Promise((resolve, reject) => {
        branchReplies.set(request.id, { resolve, reject });
        void submit({
          kind: "event",
          event: wireEvent({ type: "request", request }),
          systemVersion: session.snapshot.durable.systemVersion,
        }).then((receipt) => {
          if (receipt.kind !== "accepted") {
            branchReplies.delete(request.id);
            reject(new Error(`Branch ${receipt.kind}`));
          }
        });
      });
    const runtime: SessionRuntime = {
      get snapshot() {
        return session.snapshot;
      },
      fire(raw) {
        return submit({
          kind: "event",
          event: UserEventSchema.parse(raw),
          systemVersion: session.snapshot.durable.systemVersion,
        });
      },
      input(text) {
        let settle!: (result: TerminalResult) => void;
        const settled = new Promise<TerminalResult>((resolve) => {
          settle = resolve;
        });
        const accepted = submit(
          {
            kind: "event",
            event: UserEventSchema.parse({ type: "user", text }),
            systemVersion: session.snapshot.durable.systemVersion,
          },
          undefined,
          settle,
        );
        return { accepted, settled };
      },
      updateSystem(inputs) {
        return submit({
          kind: "system",
          inputs: SystemInputsSchema.parse(inputs),
          version: SystemVersionSchema.parse(session.snapshot.durable.systemVersion + 1),
        });
      },
      fork: () =>
        branch({
          kind: "fork",
          id: ActorIdSchema.parse(id()),
          sessionId: SessionIdSchema.parse(id()),
        }),
      compact(raw) {
        const context = parseSessionContext(raw);
        return branch({
          kind: "compact",
          id: ActorIdSchema.parse(id()),
          sessionId: SessionIdSchema.parse(id()),
          context,
        });
      },
      async close() {
        await session.send({ type: "close" });
      },
    };
    return { runtime, submit };
  }
  return { agentId, steps, configuration, id, initialize, build };
}
export async function createSession(options: SessionOptions): Promise<SessionRuntime> {
  const configured = configure(options);
  const sessionId = SessionIdSchema.parse(options.sessionId ?? configured.id());
  return configured.initialize(
    SeedSchema.parse({
      sessionId,
      origin: { kind: "root" },
      context: [],
      log: [],
      agent: configured.agentId,
      allowance: configured.steps,
      sequence: 1,
      systemInputs: options.systemInputs ?? [],
      systemVersion: 0,
      configuration: configured.configuration,
    }),
  );
}
export async function restoreSession(
  options: SessionOptions,
  rawSessionId: string,
): Promise<SessionRuntime> {
  const configured = configure(options);
  const sessionId = SessionIdSchema.parse(rawSessionId);
  const loaded = await loadSession(options.persistence, sessionId);
  if (loaded.kind !== "loaded")
    throw new Error(loaded.kind === "not_found" ? "Session not found" : loaded.message);
  const journal = replay(loaded.batches);
  if (journal.conversation.sessionId !== sessionId || journal.revision !== loaded.revision)
    throw new Error("Loaded stream identity/revision mismatch");
  const built = configured.build(
    freeze({ ...journal, conversation: { ...journal.conversation, pending: [] } }),
  );
  if (journal.conversation.turn.status !== "idle") {
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
  return built.runtime;
}
