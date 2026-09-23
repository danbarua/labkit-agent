import { configure, type Machine } from "../fsm";

export type Phase = "idle" | "awaiting_model" | "executing_tools" | "handed_off" | "done";

export type AgentId = string;

export type ToolCall = {
  id: string;
  name: string;
  args: unknown;
};

export type AgentEvent =
  | { type: "user"; text: string }
  | { type: "model_delta"; text: string }
  | { type: "model_done"; toolCalls?: ToolCall[]; handoff?: AgentId }
  | { type: "tool_done"; id: string; result: unknown }
  | { type: "abort" };

export type AgentMessage = {
  role: "system" | "user" | "assistant" | "tool";
  text: string;
};

export type AgentContext = {
  agent: AgentId;
  messages: AgentMessage[];
  inflight?: AbortController;
  pendingTools: ToolCall[];
  budget: { steps: number; usd: number };
};

export type AgentActions = {
  startCompletion?: (ctx: AgentContext) => AgentContext | Promise<AgentContext>;
  cancelHttp?: (ctx: AgentContext) => AgentContext | Promise<AgentContext>;
  cancelTools?: (ctx: AgentContext) => AgentContext | Promise<AgentContext>;
  swapAgent?: (ctx: AgentContext, agent: AgentId) => AgentContext | Promise<AgentContext>;
};

export type AgentMachine = Machine<Phase, AgentContext>;

const unchanged = (ctx: AgentContext) => ctx;

export function createAgentMachine(ctx: AgentContext, actions: AgentActions = {}): AgentMachine {
  const startCompletion = actions.startCompletion ?? unchanged;
  const cancelHttp = actions.cancelHttp ?? unchanged;
  const cancelTools = actions.cancelTools ?? unchanged;

  const appendUser = (current: AgentContext, event: AgentEvent) => {
    if (event.type !== "user") return current;
    return {
      ...current,
      messages: [...current.messages, { role: "user" as const, text: event.text }],
    };
  };

  const startForUser = async (current: AgentContext, event: AgentEvent) =>
    startCompletion(appendUser(current, event));

  const setPendingTools = (current: AgentContext, event: AgentEvent) =>
    event.type === "model_done" ? { ...current, pendingTools: event.toolCalls ?? [] } : current;

  const appendToolResult = (current: AgentContext, event: AgentEvent) => {
    if (event.type !== "tool_done") return current;
    return {
      ...current,
      messages: [...current.messages, { role: "tool" as const, text: String(event.result) }],
      pendingTools: current.pendingTools.filter((tool) => tool.id !== event.id),
    };
  };

  const allToolsSettled = (current: AgentContext, event: AgentEvent) =>
    event.type === "tool_done" && current.pendingTools.some((tool) => tool.id === event.id) && current.pendingTools.length === 1;

  return configure<AgentContext, Phase>("idle")
    .state("idle", (state) =>
      state
        .on("user", "awaiting_model", undefined, startForUser)
        .on("abort", "done"),
    )
    .state("awaiting_model", (state) =>
      state
        .on("abort", "idle", undefined, cancelHttp)
        .on("user", "awaiting_model", undefined, async (current, event) =>
          startCompletion(appendUser(await cancelHttp(current), event)),
        )
        .on("model_done", "executing_tools", (current, event) =>
          event.type === "model_done" && Boolean(event.toolCalls?.length), setPendingTools)
        .on("model_done", "handed_off", (current, event) =>
          event.type === "model_done" && Boolean(event.handoff), async (current, event) =>
           actions.swapAgent ? actions.swapAgent(current, (event as Extract<AgentEvent, { type: "model_done" }>).handoff!) : current,
        )
        .on("model_done", "idle")
        .onExit(cancelHttp),
    )
    .state("executing_tools", (state) =>
      state
        .on("abort", "idle", undefined, cancelTools)
        .on("tool_done", "awaiting_model", allToolsSettled, appendToolResult)
        .on("tool_done", "executing_tools", undefined, appendToolResult),
    )
    .state("handed_off", (state) =>
      state.on("model_done", "idle", undefined, startCompletion),
    )
    .final("done")
    .build(ctx);
}