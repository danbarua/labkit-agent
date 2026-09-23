import { z } from "zod";
import { CompletionSchema, type Completion } from "./types.ts";

const ChatToolCallSchema = z.strictObject({
  id: z.string().min(1), type: z.literal("function"),
  function: z.strictObject({ name: z.string().min(1), arguments: z.string() }),
}).readonly();
export const ChatMessageSchema = z.discriminatedUnion("role", [
  z.strictObject({ role: z.literal("system"), content: z.string() }),
  z.strictObject({ role: z.literal("user"), content: z.string() }),
  z.strictObject({ role: z.literal("assistant"), content: z.string(), tool_calls: z.array(ChatToolCallSchema).min(1).readonly().optional() }),
  z.strictObject({ role: z.literal("tool"), content: z.string(), tool_call_id: z.string().min(1) }),
]).readonly();
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export const ChatToolSchema = z.strictObject({
  type: z.literal("function"),
  function: z.strictObject({ name: z.string().min(1), description: z.string().optional(), parameters: z.record(z.string(), z.json()) }),
}).readonly();
export type ChatTool = z.infer<typeof ChatToolSchema>;
export const PreparedModelSchema = z.strictObject({
  baseUrl: z.url({ protocol: /^https?$/ }), model: z.string().min(1),
  messages: z.array(ChatMessageSchema).readonly(), tools: z.array(ChatToolSchema).readonly().optional(),
  apiKey: z.string().optional(), temperature: z.number().finite().optional(),
}).readonly().brand<"PreparedModel">();
export type PreparedModel = z.infer<typeof PreparedModelSchema>;
export type ChatCompletionRequest = z.input<typeof PreparedModelSchema> & { signal?: AbortSignal };

const ProviderResponseSchema = z.object({ choices: z.array(z.object({ message: z.object({
  role: z.literal("assistant").optional(), content: z.string().nullable().optional(),
  tool_calls: z.array(ChatToolCallSchema).optional(), handoff: z.string().min(1).optional(),
}).refine(message => !(message.tool_calls?.length && message.handoff), "A completion cannot call tools and hand off")
  .refine(message => typeof message.content === "string" || Boolean(message.tool_calls?.length || message.handoff), "No assistant message"),
})).min(1) });

/** Transport adapter: the completion actor owns execution, validation, failure and cancellation. */
export async function createChatCompletion(request: ChatCompletionRequest, fetcher: typeof fetch = fetch): Promise<Completion> {
  const { signal, ...body } = request;
  const parsed = PreparedModelSchema.parse(body);
  const endpoint = `${parsed.baseUrl.replace(/\/+$/, "").replace(/\/chat\/completions$/, "")}/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (parsed.apiKey?.trim()) headers.Authorization = `Bearer ${parsed.apiKey.trim()}`;
  const response = await fetcher(endpoint, {
    method: "POST", headers, signal,
    body: JSON.stringify({ model: parsed.model, messages: parsed.messages,
      ...(parsed.tools?.length ? { tools: parsed.tools } : {}),
      ...(parsed.temperature === undefined ? {} : { temperature: parsed.temperature }),
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`OpenAI-compatible API request failed (${response.status}): ${text}`);
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch { throw new Error("OpenAI-compatible API returned invalid JSON"); }
  const message = ProviderResponseSchema.parse(raw).choices[0]!.message;
  if (message.tool_calls?.length) return CompletionSchema.parse({ kind: "tools", text: message.content ?? "", calls:
    message.tool_calls.map(call => ({ id: call.id, name: call.function.name, args: JSON.parse(call.function.arguments) })),
  });
  if (message.handoff) return CompletionSchema.parse({ kind: "handoff", text: message.content ?? "", agent: message.handoff });
  return CompletionSchema.parse({ kind: "answer", text: message.content });
}
