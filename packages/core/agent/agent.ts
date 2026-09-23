import { z } from "zod";

import { openaiChat } from "../providers/openai-chat.ts";
import { canonicalRequest, httpTransport } from "../providers/transport.ts";
import { ContinuationSchema, ProviderSettingsSchema } from "../providers/types.ts";
import { CompletionOwnerSchema, CompletionSchema, type Completion } from "./types.ts";

const ChatToolCallSchema = z
  .strictObject({
    id: z.string().min(1),
    type: z.literal("function"),
    function: z.strictObject({ name: z.string().min(1), arguments: z.string() }),
  })
  .readonly();

export const ChatMessageSchema = z
  .discriminatedUnion("role", [
    z.strictObject({ role: z.literal("system"), content: z.string() }),
    z.strictObject({ role: z.literal("user"), content: z.string() }),
    z.strictObject({
      role: z.literal("assistant"),
      content: z.string(),
      owner: CompletionOwnerSchema.optional(),
      tool_calls: z.array(ChatToolCallSchema).min(1).readonly().optional(),
    }),
    z.strictObject({
      role: z.literal("tool"),
      content: z.string(),
      tool_call_id: z.string().min(1),
    }),
  ])
  .readonly();

export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export const ChatToolSchema = z
  .strictObject({
    type: z.literal("function"),
    function: z.strictObject({
      name: z.string().min(1),
      description: z.string().optional(),
      parameters: z.record(z.string(), z.json()),
    }),
  })
  .readonly();

export type ChatTool = z.infer<typeof ChatToolSchema>;
export const PreparedModelSchema = z
  .strictObject({
    model: z.string().min(1),
    messages: z.array(ChatMessageSchema).readonly(),
    continuations: z.array(ContinuationSchema).readonly().optional(),
    tools: z.array(ChatToolSchema).readonly().optional(),
    temperature: z.number().finite().optional(),
    ...ProviderSettingsSchema.unwrap().partial().shape,
    successors: z.array(z.string().min(1)).readonly().optional(),
  })
  .readonly()
  .brand<"PreparedModel">();
export type PreparedModel = z.infer<typeof PreparedModelSchema>;
export type ChatCompletionRequest = z.input<typeof PreparedModelSchema> & {
  baseUrl: string;
  apiKey?: string;
  signal?: AbortSignal;
};

/** Legacy convenience adapter. New environments bind a versioned profile explicitly. */
export async function createChatCompletion(
  request: ChatCompletionRequest,
  fetcher: typeof fetch = fetch,
): Promise<Completion> {
  const { signal, baseUrl, apiKey, ...body } = request;
  const prepared = PreparedModelSchema.parse(body);
  const http = httpTransport(
    {
      baseUrl: baseUrl.replace(/\/+$/, "").replace(/\/chat\/completions$/, ""),
      headers: apiKey?.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {},
      fetch: fetcher,
    },
    true,
  );
  const response = await http(
    openaiChat.encode(canonicalRequest(prepared)),
    signal ?? new AbortController().signal,
  );
  // Retained only for pre-profile custom servers; all new profiles use handoff_to.
  const legacy = z
    .object({
      choices: z
        .array(
          z.object({
            message: z.object({
              handoff: z.string().min(1).optional(),
              content: z.string().nullish(),
              tool_calls: z.array(z.unknown()).optional(),
            }),
          }),
        )
        .min(1),
    })
    .safeParse(response.body);
  const message = legacy.success ? legacy.data.choices[0]?.message : undefined;
  if (message?.handoff) {
    if (message.tool_calls?.length) throw new Error("A completion cannot call tools and hand off");
    return CompletionSchema.parse({
      kind: "handoff",
      text: message.content ?? "",
      agent: message.handoff,
    });
  }
  return CompletionSchema.parse(openaiChat.decode(response).completion);
}
