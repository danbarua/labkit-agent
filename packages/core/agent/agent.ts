import type { Completion, ToolCall } from "./types.ts";

export type ChatToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};
export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
};
export type ChatTool = {
  type: "function";
  function: { name: string; description?: string; parameters: Record<string, unknown> };
};
export type ChatCompletionRequest = {
  baseUrl: string;
  model: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  apiKey?: string;
  temperature?: number;
  signal?: AbortSignal;
};

export async function createChatCompletion(
  request: ChatCompletionRequest,
  fetcher: typeof fetch = fetch,
): Promise<Completion> {
  const endpoint = `${request.baseUrl.replace(/\/+$/, "").replace(/\/chat\/completions$/, "")}/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (request.apiKey?.trim()) headers.Authorization = `Bearer ${request.apiKey.trim()}`;
  const response = await fetcher(endpoint, {
    method: "POST", headers, signal: request.signal,
    body: JSON.stringify({
      model: request.model, messages: request.messages,
      ...(request.tools?.length ? { tools: request.tools } : {}),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`OpenAI-compatible API request failed (${response.status}): ${body}`);
  let data;
  try { data = JSON.parse(body); }
  catch { throw new Error("OpenAI-compatible API returned invalid JSON"); }
  const message = data?.choices?.[0]?.message;
  if (!message || (message.content != null && typeof message.content !== "string")) {
    throw new Error("OpenAI-compatible API returned no assistant message");
  }
  let toolCalls: ToolCall[] | undefined;
  if (message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls)) throw new Error("Invalid tool calls");
    toolCalls = message.tool_calls.map((call: ChatToolCall) => {
      if (!call || call.type !== "function" || typeof call.id !== "string" || !call.id ||
          typeof call.function?.name !== "string" || !call.function.name ||
          typeof call.function.arguments !== "string") throw new Error("Invalid tool call");
      return { id: call.id, name: call.function.name, args: JSON.parse(call.function.arguments) };
    });
  }
  // Optional adapter extension; ordinary chat completions need only content/tool_calls.
  if (message.handoff !== undefined && (typeof message.handoff !== "string" || !message.handoff)) {
    throw new Error("Invalid handoff agent");
  }
  if (typeof message.content !== "string" && !toolCalls?.length && !message.handoff) {
    throw new Error("OpenAI-compatible API returned no assistant message");
  }
  return {
    text: message.content ?? "",
    ...(toolCalls?.length ? { toolCalls } : {}),
    ...(message.handoff ? { handoff: message.handoff } : {}),
  };
}
