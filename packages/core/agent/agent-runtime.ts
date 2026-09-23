import { createChatCompletion, type ChatCompletionRequest, type ChatMessage, type ChatTool } from "./agent.ts";
import { createAgentMachine } from "./agent-fsm.ts";
import { createConversationMachine, type ConversationMachine, type TurnRecord } from "./agent-conversation.ts";
import { appendMessage, type AgentContext, type AgentEvent, type AgentMessage, type Completion, type Operation } from "./types.ts";

export type Tool = {
  description?: string;
  parameters: Record<string, unknown>;
  run: (args: unknown, signal: AbortSignal) => unknown | Promise<unknown>;
};
export type AgentDefinition = {
  model: string;
  systemPrompt?: string;
  tools?: readonly string[];
};
export type PromptInput = {
  log: readonly TurnRecord[];
  context: AgentContext;
  agent: AgentDefinition;
};
export type RuntimeOptions = {
  agent: string;
  agents: ReadonlyMap<string, AgentDefinition>;
  tools?: ReadonlyMap<string, Tool>;
  budget: { steps: number; usd: number };
  baseUrl: string;
  apiKey?: string;
  fetch?: typeof fetch;
  complete?: (request: ChatCompletionRequest) => Promise<Completion>;
  projectPrompt?: (input: PromptInput) => ChatMessage[];
  projectHandoff?: (input: PromptInput & { from: string; to: string }) => AgentMessage[];
};

/** Only an interrupted turn's final exchange may legitimately lack results. */
function completedExchanges(
  messages: readonly Readonly<AgentMessage>[],
  source: string,
  allowIncompleteTail = false,
): AgentMessage[] {
  const result: AgentMessage[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role === "tool") throw new Error(`Invalid tool history in ${source}: orphan result ${message.toolCallId}`);
    if (!message.toolCalls?.length) { result.push(structuredClone(message)); continue; }
    const results: AgentMessage[] = [];
    while (messages[index + 1]?.role === "tool") results.push(structuredClone(messages[++index]!));
    const callIds = new Set(message.toolCalls.map(call => call.id));
    const resultIds = new Set(results.map(item => item.toolCallId));
    if (callIds.size !== message.toolCalls.length || resultIds.size !== results.length ||
        results.some(item => !item.toolCallId || !callIds.has(item.toolCallId))) {
      throw new Error(`Invalid tool history in ${source}: duplicate or unmatched tool IDs`);
    }
    const missing = message.toolCalls.filter(call => !resultIds.has(call.id));
    if (missing.length && !(allowIncompleteTail && index === messages.length - 1)) {
      throw new Error(`Invalid tool history in ${source}: missing results for ${missing.map(call => call.id).join(", ")}`);
    }
    const calls = message.toolCalls.filter(call => resultIds.has(call.id));
    result.push({ ...structuredClone(message), toolCalls: calls.length ? calls : undefined });
    result.push(...results.filter(item => calls.some(call => call.id === item.toolCallId)));
  }
  return result;
}

export function projectConversationPrompt({ log, context, agent }: PromptInput): ChatMessage[] {
  // Validate the source transcript even when a handoff packet replaces its prompt view.
  const history = log.flatMap((turn, index) => completedExchanges(
    turn.messages, `logged turn ${index + 1}`, turn.completion !== "completed",
  ));
  const current = completedExchanges(context.messages, "current turn");
  const messages = context.promptMessages
    ? completedExchanges(context.promptMessages, "handoff packet")
    : [...history, ...current];
  return [
    ...(agent.systemPrompt ? [{ role: "system" as const, content: agent.systemPrompt }] : []),
    ...messages.map(message => ({
      role: message.role, content: message.text,
      ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
      ...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map(call => ({
        id: call.id, type: "function" as const,
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      })) } : {}),
    })),
  ];
}

export function createAgentRuntime(options: RuntimeOptions): ConversationMachine {
  if (!options.agents.has(options.agent)) throw new Error(`Unknown agent: ${options.agent}`);
  if (!Number.isInteger(options.budget.steps) || options.budget.steps < 0) {
    throw new Error("Step budget must be a nonnegative integer");
  }
  const registry = options.tools ?? new Map<string, Tool>();
  for (const agent of options.agents.values()) {
    for (const name of agent.tools ?? []) {
      if (!registry.has(name)) throw new Error(`Unknown tool: ${name}`);
    }
  }
  const complete = options.complete ?? (request => createChatCompletion(request, options.fetch));
  const project = options.projectPrompt ?? projectConversationPrompt;
  let sequence = 0;
  let conversation: ConversationMachine;
  const definition = (ctx: AgentContext) => options.agents.get(ctx.agent)!;
  const allowed = (ctx: AgentContext) => {
    const names = definition(ctx).tools ?? [];
    return new Set(ctx.pendingTools.map(call => call.id)).size === ctx.pendingTools.length &&
      ctx.pendingTools.every(call => Boolean(call.id) && names.includes(call.name) && registry.has(call.name));
  };
  const cancel = (ctx: AgentContext): AgentContext => {
    ctx.operation?.controller.abort();
    return { ...ctx, operation: undefined };
  };
  const newOperation = (kind: Operation["kind"]): Operation => ({ id: ++sequence, kind, controller: new AbortController() });
  const input = (ctx: AgentContext): PromptInput => ({
    log: conversation.snapshot.log, context: ctx, agent: definition(ctx),
  });

  conversation = createConversationMachine({
    agent: options.agent, messages: [], pendingTools: [], budget: { ...options.budget },
  }, {
    createAgentMachine: (ctx, turnId) => {
      const post = (operation: Operation, event: AgentEvent) => {
        // Never await the parent mailbox from a lifecycle action.
        void conversation.fire({ type: "agent", turnId, operationId: operation.id, event });
      };
      const failed = (operation: Operation, error: unknown) => post(operation, {
        type: "failed", error: error instanceof Error ? error.message : String(error),
      });
      return createAgentMachine(ctx, {
        cancel,
        canHandoff: agent => options.agents.has(agent),
        canRunTools: allowed,
        swapAgent: (current, to) => ({ ...current, agent: to }),
        startCompletion: current => {
          const operation = newOperation("model");
          const next = { ...current, operation };
          if (current.budget.steps === 0) {
            post(operation, { type: "exhausted" });
            return next;
          }
          next.budget = { ...current.budget, steps: current.budget.steps - 1 };
          // Defer invocation so synchronous adapter exceptions also become failure events.
          void Promise.resolve().then(() => {
            operation.controller.signal.throwIfAborted();
            const agent = definition(next);
            const tools: ChatTool[] = (agent.tools ?? []).map(name => {
              const tool = registry.get(name)!;
              return { type: "function", function: { name, description: tool.description, parameters: tool.parameters } };
            });
            return complete({ baseUrl: options.baseUrl, apiKey: options.apiKey, model: agent.model,
              messages: project(input(next)), tools, signal: operation.controller.signal });
          }).then(value => {
            if (operation.controller.signal.aborted) return;
            const result = structuredClone(value);
            if (result.handoff && result.toolCalls?.length) throw new Error("Completion cannot both hand off and call tools");
            if (result.handoff && !options.agents.has(result.handoff)) throw new Error(`Unknown agent: ${result.handoff}`);
            if (result.toolCalls?.length && !allowed({ ...next, pendingTools: result.toolCalls })) {
              throw new Error("Completion requested an unpermitted tool or duplicate call ID");
            }
            let handoffMessages: AgentMessage[] | undefined;
            if (result.handoff) {
              const handoffContext = { ...appendMessage(next, { role: "assistant", text: result.text }), agent: result.handoff };
              // Keep the most recent instruction and handoff response by default.
              // A custom projector can supply a domain-specific summary instead.
              const packet = options.projectHandoff?.({ ...input(handoffContext), from: next.agent, to: result.handoff }) ??
                [handoffContext.messages.findLast(message => message.role === "user"), handoffContext.messages.at(-1)]
                  .filter((message): message is AgentMessage => Boolean(message));
              handoffMessages = structuredClone(packet);
            }
            post(operation, { ...result, type: "model_done", handoffMessages });
          }).catch(error => failed(operation, error));
          return next;
        },
        runTools: current => {
          const operation = newOperation("tools");
          for (const call of current.pendingTools) {
            void Promise.resolve().then(() => {
              operation.controller.signal.throwIfAborted();
              return registry.get(call.name)!.run(call.args, operation.controller.signal);
            })
              .then(result => post(operation, { type: "tool_done", id: call.id,
                result: typeof result === "string" ? result : JSON.stringify(result) ?? "null" }))
              .catch(error => failed(operation, error));
          }
          return { ...current, operation };
        },
      });
    },
  });
  return conversation;
}
