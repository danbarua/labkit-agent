import { configure, type Machine } from "../fsm";
import { appendMessage, type AgentContext, type AgentEvent } from "./types.ts";
export type { AgentContext, AgentEvent, AgentMessage, ToolCall } from "./types.ts";

export type Phase = "idle" | "awaiting_model" | "executing_tools" | "done";
export type AgentId = string;
export type AgentMachine = Machine<Phase, AgentContext>;

/** Actions launch work and return context; they never await completion or posted events. */
export type AgentActions = {
  startCompletion: (ctx: AgentContext) => AgentContext;
  runTools: (ctx: AgentContext) => AgentContext;
  cancel: (ctx: AgentContext) => AgentContext;
  canHandoff: (agent: AgentId) => boolean;
  canRunTools: (ctx: AgentContext) => boolean;
  swapAgent: (ctx: AgentContext, agent: AgentId) => AgentContext;
};

export function createAgentMachine(ctx: AgentContext, actions: AgentActions): AgentMachine {
  const appendUser = (current: AgentContext, event: Extract<AgentEvent, { type: "user" }>) =>
    appendMessage(current, { role: "user", text: event.text });
  const appendAssistant = (current: AgentContext, event: Extract<AgentEvent, { type: "model_done" }>) =>
    appendMessage(current, {
      role: "assistant", text: event.text,
      ...(event.toolCalls?.length ? { toolCalls: structuredClone(event.toolCalls) } : {}),
    });
  const pending = (current: AgentContext, event: Extract<AgentEvent, { type: "tool_done" }>) =>
    current.pendingTools.some((call) => call.id === event.id);
  const appendTool = (current: AgentContext, event: Extract<AgentEvent, { type: "tool_done" }>) => ({
    ...appendMessage(current, { role: "tool", text: event.result, toolCallId: event.id }),
    pendingTools: current.pendingTools.filter((call) => call.id !== event.id),
  });
  const aborted = (current: AgentContext): AgentContext => ({ ...current, completion: "aborted" });
  const failed = (current: AgentContext, event: Extract<AgentEvent, { type: "failed" }>): AgentContext =>
    ({ ...current, completion: "failed", error: event.error });

  return configure<AgentContext, Phase>("idle")
    .state("idle", state => state
      .on("user", "awaiting_model", appendUser)
      .on("abort", "done", aborted))
    .state("awaiting_model", state => state
      .onEntry(actions.startCompletion)
      .onExit(actions.cancel)
      .on("user", "awaiting_model", appendUser)
      .on("abort", "done", aborted)
      .on("failed", "done", failed)
      .on("exhausted", "done", current => ({ ...current, completion: "exhausted" }))
      .onIf("model_done", "executing_tools", (current, event) =>
        !event.handoff && Boolean(event.toolCalls?.length) &&
        actions.canRunTools({ ...current, pendingTools: event.toolCalls }),
        (current, event) => ({ ...appendAssistant(current, event), pendingTools: structuredClone(event.toolCalls) }))
      .onIf("model_done", "awaiting_model", (_, event) =>
        Boolean(event.handoff) && !event.toolCalls?.length && actions.canHandoff(event.handoff),
        (current, event) => ({ ...actions.swapAgent(appendAssistant(current, event), event.handoff),
          promptMessages: event.handoffMessages }))
      .onIf("model_done", "done", (_, event) => !event.handoff && !event.toolCalls?.length,
        (current, event) => ({ ...appendAssistant(current, event), completion: "completed" })))
    .state("executing_tools", state => state
      .onEntry(actions.runTools)
      .onExit(actions.cancel)
      .on("abort", "done", aborted)
      .on("failed", "done", failed)
      .onIf("tool_done", "awaiting_model", (current, event) =>
        pending(current, event) && current.pendingTools.length === 1, appendTool)
      .internal("tool_done", appendTool, pending))
    .final("done")
    .build(ctx);
}
