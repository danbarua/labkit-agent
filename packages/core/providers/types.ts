import { z } from "zod";

import { MessagesSchema, ToolNameSchema } from "../agent/types.ts";
import { freeze } from "../fsm/fsm.ts";

/** Data only. More thinking modes can be added with a journal/metadata migration. */
export const ProviderSettingsSchema = z
  .strictObject({
    provider: z.string().regex(/^.+@\d+$/),
    thinking: z.literal("off").optional(),
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
    model: z.string().min(1),
    messages: MessagesSchema,
    tools: z.array(ToolAdvertisementSchema).readonly(),
    thinking: z.literal("off").optional(),
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
  encode(request: CompletionRequest): HttpRequest;
  decode(response: HttpResponse): unknown;
}>;
export function parseRequest(raw: unknown): CompletionRequest {
  const request = freeze(CompletionRequestSchema.parse(raw));
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
