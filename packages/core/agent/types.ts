export type ToolCall = { id: string; name: string; args: unknown };

export type AgentMessage = {
  role: "system" | "user" | "assistant" | "tool";
  text: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
};

export type Completion = {
  text: string;
  toolCalls?: ToolCall[];
  handoff?: string;
};

export type CompletionStatus = "completed" | "aborted" | "exhausted" | "failed";

export type Operation = {
  id: number;
  kind: "model" | "tools";
  controller: AbortController;
};

export type AgentContext = {
  agent: string;
  messages: AgentMessage[];
  /** Optional turn-local projected view after a handoff; the transcript remains intact. */
  promptMessages?: AgentMessage[];
  pendingTools: ToolCall[];
  budget: { steps: number; usd: number };
  operation?: Operation;
  completion?: CompletionStatus;
  error?: string;
};

export type AgentEvent =
  | { type: "user"; text: string }
  | ({ type: "model_done"; handoffMessages?: AgentMessage[] } & Completion)
  | { type: "tool_done"; id: string; result: string }
  | { type: "abort" }
  | { type: "exhausted" }
  | { type: "failed"; error: string };

export function appendMessage(ctx: AgentContext, message: AgentMessage): AgentContext {
  return {
    ...ctx,
    messages: [...ctx.messages, message],
    ...(ctx.promptMessages ? { promptMessages: [...ctx.promptMessages, message] } : {}),
  };
}
