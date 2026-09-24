import { z } from "zod";

import { ToolCallSchema } from "../agent/types.ts";
import {
  advertisements,
  completion,
  continuationPayload,
  jsonArguments,
  messageText,
  responseBody,
} from "./shared.ts";
import {
  matchingContinuations,
  parseRequest,
  validateProviderSettings,
  type CompletionProfile,
} from "./types.ts";
import { decodeUsage } from "./usage.ts";

const reasoning = z
  .object({
    type: z.literal("reasoning"),
    id: z.string().min(1).optional(),
    encrypted_content: z.string().min(1).nullish(),
    summary: z.array(z.object({ type: z.literal("summary_text"), text: z.string() })),
    status: z.literal("completed").optional(),
  })
  .refine(
    (item) => !item.id || !!item.encrypted_content,
    "Reasoning id requires encrypted_content for stateless replay",
  );
const payloadSchema = z.strictObject({ items: z.array(reasoning).min(1) });
const output = z.union([
  reasoning,
  z.object({
    type: z.literal("message"),
    role: z.literal("assistant"),
    status: z.literal("completed").optional(),
    content: z.array(z.object({ type: z.literal("output_text"), text: z.string() })),
  }),
  z.object({
    type: z.literal("function_call"),
    call_id: z.string().min(1),
    name: z.string().min(1),
    arguments: z.string(),
    status: z.literal("completed").optional(),
  }),
]);
export const openaiResponsesV2: CompletionProfile = {
  id: "openai-responses@2",
  capabilities: {
    thinking: { mode: "effort", values: ["none", "low", "medium", "high"] },
    stream: false,
    media: ["text/plain", "text/markdown"],
  },
  encode(raw, blobs) {
    const request = parseRequest(raw, "openai-responses@2");
    validateProviderSettings(request, this.capabilities);
    const input: unknown[] = [];
    for (const message of request.messages) {
      const text = messageText(message, blobs);
      for (const entry of matchingContinuations(
        [message],
        request.continuations ?? [],
        "openai-responses@2",
      ))
        input.push(...payloadSchema.parse(continuationPayload(entry, blobs)).items);
      if (message.role === "tool")
        input.push({ type: "function_call_output", call_id: message.callId, output: text });
      else {
        if (text || message.role !== "assistant" || !message.calls?.length)
          input.push({ role: message.role, content: text });
        if (message.role === "assistant")
          for (const call of message.calls ?? [])
            input.push({
              type: "function_call",
              call_id: call.id,
              name: call.name,
              arguments: JSON.stringify(call.args),
            });
      }
    }
    return {
      path: "/responses",
      method: "POST",
      headers: {},
      body: {
        model: request.model,
        input,
        store: false,
        stream: false,
        tools: advertisements(request).map((tool) => ({
          type: "function",
          ...tool,
          strict: false,
        })),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.maxOutputTokens === undefined
          ? {}
          : { max_output_tokens: request.maxOutputTokens }),
        ...(request.thinking === "off" ? {} : { include: ["reasoning.encrypted_content"] }),
        ...(request.thinking === undefined
          ? {}
          : { reasoning: { effort: request.thinking === "off" ? "none" : request.thinking } }),
      },
    };
  },
  decode(res) {
    const usage = decodeUsage(res.body, "responses");
    const body = z
      .object({ status: z.literal("completed"), output: z.array(output).min(1) })
      .parse(responseBody(res));
    const decoded = completion(
      body.output
        .flatMap((item) => (item.type === "message" ? item.content.map((part) => part.text) : []))
        .join(""),
      body.output.flatMap((item) =>
        item.type === "function_call"
          ? [
              ToolCallSchema.parse({
                id: item.call_id,
                name: item.name,
                args: jsonArguments(item.arguments),
              }),
            ]
          : [],
      ),
    );
    const items = body.output.filter((item) => item.type === "reasoning");
    return {
      ...decoded,
      ...(usage ? { usage } : {}),
      ...(items.length ? { continuationPayload: { items } } : {}),
    };
  },
};
