import { z } from "zod";

import { openaiChat } from "../providers/openai-chat.ts";
import { canonicalRequest, httpTransport } from "../providers/transport.ts";
import { ContinuationSchema, ProviderSettingsSchema } from "../providers/types.ts";
import { ContentPartsSchema, partsText } from "./content.ts";
import { CompletionOwnerSchema, CompletionSchema, type Completion } from "./types.ts";

const ChatToolCallSchema = z
  .strictObject({
    id: z.string().min(1),
    type: z.literal("function"),
    function: z.strictObject({ name: z.string().min(1), arguments: z.string() }),
  })
  .readonly();

/**
 * One message of a model request in OpenAI chat shape (`content`, `tool_calls`,
 * `tool_call_id`), as prompt projection produces it. `canonicalRequest` turns it back into an
 * `AgentMessage` before a provider profile encodes the request. When `parts` is present,
 * `content` must equal the concatenation of its text parts.
 */
export const ChatMessageSchema = z
  .discriminatedUnion("role", [
    z.strictObject({
      role: z.literal("system"),
      content: z.string(),
      parts: ContentPartsSchema.optional(),
    }),
    z.strictObject({
      role: z.literal("user"),
      content: z.string(),
      parts: ContentPartsSchema.optional(),
    }),
    z.strictObject({
      role: z.literal("assistant"),
      content: z.string(),
      owner: CompletionOwnerSchema.optional(),
      parts: ContentPartsSchema.optional(),
      tool_calls: z.array(ChatToolCallSchema).min(1).readonly().optional(),
    }),
    z.strictObject({
      role: z.literal("tool"),
      content: z.string(),
      tool_call_id: z.string().min(1),
    }),
  ])
  .refine(
    (message) =>
      message.role === "tool" || !message.parts || message.content === partsText(message.parts),
    "Message content must equal its text parts",
  )
  .readonly();

/** One message of a model request in OpenAI chat shape. See {@link ChatMessageSchema}. */
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
/** A tool advertised to the model in OpenAI chat shape; `parameters` is its JSON Schema. */
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

/** A tool advertised to the model. See {@link ChatToolSchema}. */
export type ChatTool = z.infer<typeof ChatToolSchema>;
/**
 * The request a successful prepare operation produces for one step: the model, the projected
 * messages, the advertised tools and the provider settings (provider, thinking, output limit,
 * streaming) captured for that step.
 */
export const PreparedModelSchema = z
  .strictObject({
    model: z.string().min(1),
    messages: z.array(ChatMessageSchema).readonly(),
    /**
     * Provider continuation payloads (such as thinking signatures; not the next step) to send
     * back with the assistant messages that own them.
     */
    continuations: z.array(ContinuationSchema).readonly().optional(),
    tools: z.array(ChatToolSchema).readonly().optional(),
    temperature: z.number().finite().optional(),
    ...ProviderSettingsSchema.unwrap().partial().shape,
    /**
     * Agents the model may hand off to; omitted means none. The handoff tool advertises them,
     * and a bound provider rejects a handoff to any other agent.
     */
    successors: z.array(z.string().min(1)).readonly().optional(),
  })
  .readonly()
  .brand<"PreparedModel">();
/** The request prepared for one step. See {@link PreparedModelSchema}. */
export type PreparedModel = z.infer<typeof PreparedModelSchema>;
/**
 * Input to {@link createChatCompletion}: a prepared request plus the endpoint.
 * `baseUrl` is an OpenAI-compatible base URL; trailing slashes and a trailing
 * `/chat/completions` are removed. `apiKey` is sent as a Bearer token when not blank.
 */
export type ChatCompletionRequest = z.input<typeof PreparedModelSchema> & {
  baseUrl: string;
  apiKey?: string;
  signal?: AbortSignal;
};

/**
 * Runs one step against an OpenAI-compatible chat completions endpoint and decodes the reply.
 * Legacy convenience adapter. New environments bind a versioned profile explicitly.
 *
 * A reply whose message carries a legacy `handoff` field decodes as a handoff completion.
 * Unlike a bound provider, this function does not check handoff targets against `successors`.
 *
 * @param fetcher Replaces the global `fetch`.
 * @throws Error when a legacy reply both calls tools and hands off. Also rejects when the request
 * is invalid, the HTTP call fails or is aborted, or the reply is not a valid completion.
 */
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
