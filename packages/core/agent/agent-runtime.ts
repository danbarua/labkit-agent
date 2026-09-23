import { z } from "zod";
import { Actor, freeze } from "../fsm/fsm.ts";
import { createChatCompletion, PreparedModelSchema, type ChatCompletionRequest } from "./agent.ts";
import { admittedCompletionSchema, type TurnEvent } from "./agent-fsm.ts";
import { decideConversation, initialConversation, type ConversationCommand, type ConversationEvent, type ConversationState, type SessionRequest, type SessionReply } from "./agent-conversation.ts";
import { createOperationActor, type Operation, type OperationState } from "./operation-actor.ts";
import { projectConversationPrompt, parseSessionContext, type PromptInput } from "./prompt.ts";
import { toolBatchMachine, type BatchCommand, type BatchEvent, type BatchState } from "./tool-batch.ts";
import { ActorIdSchema, SessionIdSchema, AgentIdSchema, MessagesSchema, StepsSchema, ToolNameSchema, UserEventSchema, failure,
  type ActorId, type ChildRef, type Result, type TurnData } from "./types.ts";
export { projectConversationPrompt } from "./prompt.ts";
export type { PromptInput } from "./prompt.ts";

/** Existential tool adapter: defineTool retains schema inference at the authoring boundary. */
export type Tool = Readonly<{
  description?: string;
  parameters: Record<string, unknown>;
  parseInput: (raw: unknown) => Promise<unknown>;
  run: (input: unknown, signal: AbortSignal) => unknown | Promise<unknown>;
}>;
export function defineTool<S extends z.ZodType>(definition: {
  input: S;
  description?: string;
  run: (input: z.output<S>, signal: AbortSignal) => unknown | Promise<unknown>;
}): Tool {
  return Object.freeze({
    description: definition.description,
    parameters: z.toJSONSchema(definition.input, { io: "input" }),
    parseInput: raw => definition.input.parseAsync(raw),
    run: (input, signal) => definition.run(input as z.output<S>, signal),
  });
}
const AgentDefinitionSchema = z.strictObject({ model: z.string().min(1), systemPrompt: z.string().optional(), tools: z.array(ToolNameSchema).default([]).readonly() }).readonly();
export type AgentDefinition = z.input<typeof AgentDefinitionSchema>;
export type RuntimeOptions = {
  agent: string;
  agents: ReadonlyMap<string, AgentDefinition>;
  tools?: ReadonlyMap<string, Tool>;
  steps: number;
  baseUrl: string;
  apiKey?: string;
  fetch?: typeof fetch;
  /** Adapters return untrusted data; the completion actor parses and admits it. */
  complete?: (request: ChatCompletionRequest) => unknown | Promise<unknown>;
  projectPrompt?: (input: PromptInput, signal: AbortSignal) => unknown | Promise<unknown>;
  projectHandoff?: (input: PromptInput & { from: string; to: string }, signal: AbortSignal) => unknown | Promise<unknown>;
};
export type ChildSnapshot = Readonly<{ ref: ChildRef; state: OperationState<unknown> | BatchState }>;
export type RuntimeSnapshot = Readonly<{ conversation: ConversationState; children: readonly ChildSnapshot[] }>;
export type AgentRuntime = {
  readonly snapshot: RuntimeSnapshot;
  fire(event: unknown): Promise<RuntimeSnapshot>;
  /** Resolve at the next completed-turn boundary with an independent runtime. */
  fork(): Promise<AgentRuntime>;
  /** Fork with validated replacement messages, clearing inherited transcript/context. */
  compact(context: unknown): Promise<AgentRuntime>;
};
type Child = { readonly snapshot: OperationState<unknown> | BatchState; cancel(): Promise<unknown> };

export function createAgentRuntime(options: RuntimeOptions): AgentRuntime {
  const agentId = AgentIdSchema.parse(options.agent);
  const steps = StepsSchema.parse(options.steps);
  const baseUrl = z.url({ protocol: /^https?$/ }).parse(options.baseUrl);
  // Copy registries so caller mutation cannot invalidate an admitted actor message.
  const agents = new Map([...options.agents].map(([id, definition]) => [AgentIdSchema.parse(id), AgentDefinitionSchema.parse(definition)]));
  if (!agents.has(agentId)) throw new Error(`Unknown agent: ${agentId}`);
  const tools = new Map([...options.tools ?? []].map(([name, tool]) => [ToolNameSchema.parse(name), Object.freeze({ ...tool, parameters: freeze(structuredClone(tool.parameters)) })]));
  for (const definition of agents.values()) {
    for (const name of definition.tools) if (!tools.has(name)) throw new Error(`Unknown tool: ${name}`);
  }
  const apiKey = options.apiKey;
  const fetcher = options.fetch;
  const projectHandoff = options.projectHandoff;
  const complete = options.complete ?? ((request: ChatCompletionRequest) => createChatCompletion(request, fetcher));
  const project = options.projectPrompt ?? projectConversationPrompt;
  function build(initial: ConversationState): AgentRuntime {
    const replies = new Map<ActorId, (reply: SessionReply) => void>();
    const children = new Map<ActorId, { ref: ChildRef; actor: Child }>();
    let conversation: Actor<ConversationState, ConversationEvent, ConversationCommand>;
    const input = (turn: TurnData): PromptInput => ({ context: conversation.snapshot.context, log: conversation.snapshot.log, turn, agent: agents.get(turn.agent)! });
    const post = (turnId: ActorId, event: TurnEvent) => {
      // Only validated, typed child outcomes enter this private mailbox.
      void conversation.send({ type: "child", turnId, event });
    };
    function spawn<I, O>(child: ChildRef, operation: Operation<I, O>, settled: (result: Result<O>) => void) {
      const actor = createOperationActor(child, operation, result => {
        children.delete(child.id);
        settled(result);
      });
      children.set(child.id, { ref: child, actor });
      void actor.start();
    }
    const cancel = (child: ChildRef) => { void children.get(child.id)?.actor.cancel(); };
    const execute = (effect: ConversationCommand): undefined => {
      if (effect.type === "reply") {
        const reply = replies.get(effect.requestId);
        replies.delete(effect.requestId);
        reply?.(effect.result);
        return undefined;
      }
      const { turnId, command } = effect;
      switch (command.type) {
        case "cancel": cancel(command.child); break;
        case "prepare_model": {
          const agent = agents.get(command.turn.agent)!;
          spawn(command.child, {
            input: null, parseInput: z.null().parse,
            run: async (_, signal) => ({ baseUrl, apiKey, model: agent.model,
              messages: await project(input(command.turn), signal),
              tools: agent.tools.map(name => ({ type: "function", function: {
                name, description: tools.get(name)!.description, parameters: tools.get(name)!.parameters,
              } })),
            }),
            parseOutput: PreparedModelSchema.parseAsync,
          }, result => post(turnId, { type: "prepared", child: command.child, result }));
          break;
        }
        case "complete": {
          const admitted = admittedCompletionSchema(new Set(agents.keys()), new Set(agents.get(command.turn.agent)!.tools));
          spawn(command.child, {
            input: command.request, parseInput: PreparedModelSchema.parseAsync,
            run: (request, signal) => complete({ ...request, signal }), parseOutput: admitted.parseAsync,
          }, result => post(turnId, { type: "model_settled", child: command.child, result }));
          break;
        }
        case "prepare_handoff": {
          spawn(command.child, {
            input: null, parseInput: z.null().parse,
            run: (_, signal) => projectHandoff
              ? projectHandoff({ ...input(command.turn), from: command.from, to: command.turn.agent }, signal)
              : [command.turn.messages.findLast(message => message.role === "user"), command.turn.messages.at(-1)].filter(message => message !== undefined),
            parseOutput: MessagesSchema.parseAsync,
          }, result => post(turnId, { type: "handoff_prepared", child: command.child, result }));
          break;
        }
        case "run_tools": {
          let batch: Actor<BatchState, BatchEvent, BatchCommand>;
          const runBatchCommand = (batchCommand: BatchCommand): undefined => {
            switch (batchCommand.type) {
              case "spawn_tool": {
                const tool = tools.get(batchCommand.call.name)!;
                spawn(batchCommand.child, {
                  input: batchCommand.call.args, parseInput: tool.parseInput,
                  run: tool.run,
                  parseOutput: value => {
                    const json = z.json().parse(value);
                    return typeof json === "string" ? json : JSON.stringify(json);
                  },
                }, result => { void batch.send({ type: "tool_settled", callId: batchCommand.call.id, result }); });
                break;
              }
              case "cancel_tool": cancel(batchCommand.child); break;
              case "notify":
                children.delete(command.child.id);
                post(turnId, { type: "batch_settled", child: command.child, outcome: batchCommand.outcome });
                break;
            }
            return undefined;
          };
          batch = new Actor<BatchState, BatchEvent, BatchCommand>(
            { status: "ready", calls: command.completion.calls }, toolBatchMachine(command.child), runBatchCommand,
            (_, error) => ({ type: "failed", error: failure(error) }),
          );
          children.set(command.child.id, { ref: command.child, actor: {
            get snapshot() { return batch.snapshot; }, cancel: () => batch.send({ type: "cancel" }),
          } });
          void batch.send({ type: "start" });
          break;
        }
      }
      return undefined;
    };
    conversation = new Actor<ConversationState, ConversationEvent, ConversationCommand>(initial, decideConversation, execute,
      (command, error) => ({ type: "dispatch_failed", command, error: failure(error) }));
    const snapshot = (): RuntimeSnapshot => freeze({ conversation: conversation.snapshot,
      children: [...children.values()].map(({ ref, actor }) => ({ ref, state: actor.snapshot })),
    });
    const enqueue = (request: SessionRequest): Promise<SessionReply> => new Promise((resolve, reject) => {
      replies.set(request.id, resolve);
      void conversation.send({ type: "request", request }).catch(error => {
        replies.delete(request.id);
        reject(error);
      });
    });
    const requestId = () => ActorIdSchema.parse(`${initial.sessionId}/request/${crypto.randomUUID()}`);
    const branch = async (request: SessionRequest): Promise<AgentRuntime> => {
      const reply = await enqueue(request);
      return build(reply.state);
    };
    return {
      get snapshot() { return snapshot(); },
      async fire(raw) {
        await conversation.send(UserEventSchema.parse(raw));
        return snapshot();
      },
      fork: () => branch({ kind: "fork", id: requestId(), sessionId: SessionIdSchema.parse(crypto.randomUUID()) }),
      async compact(raw) {
        const context = parseSessionContext(raw);
        return branch({ kind: "compact", id: requestId(), sessionId: SessionIdSchema.parse(crypto.randomUUID()), context });
      },
    };
  }
  return build(initialConversation(agentId, steps));
}
