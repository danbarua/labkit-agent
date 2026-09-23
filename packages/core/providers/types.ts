import { z } from "zod";

import { CompletionOwnerSchema, MessagesSchema, ToolNameSchema } from "../agent/types.ts";
import { freeze } from "../fsm/fsm.ts";

export const ThinkingSchema = z.enum(["off", "low", "medium", "high", "adaptive"]);
export type ThinkingCapability =
  | Readonly<{ mode: "off" }>
  | Readonly<{ mode: "effort"; values: readonly ("none" | "low" | "medium" | "high")[] }>
  | Readonly<{ mode: "budget"; maxTokens: number }>
  | Readonly<{ mode: "adaptive" }>;
export const ContinuationPayloadSchema = z
  .json()
  .refine((payload) => JSON.stringify(payload).length <= 65536, "Continuation exceeds 64 KiB");
export const ContinuationSchema = z
  .strictObject({
    provider: z.string().regex(/^.+@\d+$/),
    owner: CompletionOwnerSchema,
    payload: ContinuationPayloadSchema,
  })
  .readonly();
export type Continuation = z.infer<typeof ContinuationSchema>;
export type DecodedCompletion = Readonly<{ completion: unknown; continuationPayload?: unknown }>;
export function validateThinking(
  thinking: z.infer<typeof ThinkingSchema> | undefined,
  capability: ThinkingCapability,
) {
  if (thinking === undefined || thinking === "off") return;
  if (
    thinking === "adaptive"
      ? capability.mode === "adaptive"
      : capability.mode === "effort" && capability.values.includes(thinking)
  )
    return;
  throw new Error("Unsupported thinking setting");
}
export function matchingContinuations(
  messages: readonly { role: string; owner?: z.infer<typeof CompletionOwnerSchema> }[],
  continuations: readonly Continuation[],
  provider?: string,
) {
  return continuations.filter(
    (entry) =>
      entry.provider === provider &&
      messages.some(
        (message) =>
          message.role === "assistant" &&
          message.owner?.turnId === entry.owner.turnId &&
          message.owner.generation === entry.owner.generation,
      ),
  );
}
/** Data only. More thinking modes can be added with a journal/metadata migration. */
export const ProviderSettingsSchema = z
  .strictObject({
    provider: z.string().regex(/^.+@\d+$/),
    thinking: ThinkingSchema.optional(),
    stream: z.literal(false).optional(),
    maxOutputTokens: z.number().int().positive().optional(),
  })
  .readonly();
export type ProviderSettings = z.infer<typeof ProviderSettingsSchema>;
export const ToolAdvertisementSchema = z
  .strictObject({
    name: ToolNameSchema,
    description: z.string().optional(),
    parameters: z.record(z.string(), z.json()),
  })
  .readonly();
export const CompletionRequestSchema = z
  .strictObject({
    provider: ProviderSettingsSchema.unwrap().shape.provider.optional(),
    model: z.string().min(1),
    messages: MessagesSchema,
    continuations: z.array(ContinuationSchema).readonly().optional(),
    tools: z.array(ToolAdvertisementSchema).readonly(),
    thinking: ThinkingSchema.optional(),
    stream: z.literal(false).optional(),
    temperature: z.number().finite().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    successors: z.array(z.string().min(1)).readonly(),
  })
  .readonly();
export type CompletionRequest = z.infer<typeof CompletionRequestSchema>;
/** Relative endpoint: no origin or credentials are visible to profiles. */
export type HttpRequest = Readonly<{
  path: string;
  method: "POST";
  headers: Readonly<Record<string, string>>;
  body: unknown;
}>;
export type HttpResponse = Readonly<{ status: number; headers: Headers; body: unknown }>;
export type CompletionProfile = Readonly<{
  id: string;
  capabilities: Readonly<{ thinking: ThinkingCapability; stream: false }>;
  encode(request: CompletionRequest): HttpRequest;
  decode(response: HttpResponse): DecodedCompletion;
}>;
export function parseRequest(raw: unknown, profileId?: string): CompletionRequest {
  const request = freeze(CompletionRequestSchema.parse(raw));
  const owners = request.messages.flatMap((message) =>
    message.role === "assistant" && message.owner ? [JSON.stringify(message.owner)] : [],
  );
  if (new Set(owners).size !== owners.length) throw new Error("Duplicate assistant owner");
  const continuationOwners = (request.continuations ?? []).map((entry) =>
    JSON.stringify(entry.owner),
  );
  if (new Set(continuationOwners).size !== continuationOwners.length)
    throw new Error("Duplicate continuation owner");
  if (profileId !== undefined && request.provider !== undefined && request.provider !== profileId)
    throw new Error("Request provider does not match profile");
  const provider = profileId ?? request.provider;
  if ((request.continuations ?? []).some((entry) => entry.provider !== provider))
    throw new Error("Continuation provider does not match request provider");
  if (
    matchingContinuations(request.messages, request.continuations ?? [], provider).length !==
    continuationOwners.length
  )
    throw new Error("Continuation owner has no assistant message");
  const pending = new Set<string>();
  let conversationStarted = false;
  for (const message of request.messages) {
    if (message.role === "system") {
      if (conversationStarted)
        throw new Error("System messages must precede conversation messages");
      continue;
    }
    conversationStarted = true;
    if (message.role === "tool") {
      if (!pending.delete(message.callId)) throw new Error("Uncorrelated tool result");
    } else {
      if (pending.size) throw new Error("Missing tool results");
      if (message.role === "assistant")
        for (const call of message.calls ?? []) pending.add(call.id);
    }
  }
  if (pending.size) throw new Error("Missing tool results");
  return request;
}
