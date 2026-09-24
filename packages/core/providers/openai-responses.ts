import { z } from "zod";

import { ToolCallSchema } from "../agent/types.ts";
import { advertisements, completion, jsonArguments, messageText, responseBody } from "./shared.ts";
import { parseRequest, validateProviderSettings, type CompletionProfile } from "./types.ts";

const output = z.discriminatedUnion("type", [
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
export const openaiResponses: CompletionProfile = {
  id: "openai-responses@1",
  capabilities: {
    thinking: { mode: "effort", values: ["none"] },
    stream: false,
    media: ["text/plain", "text/markdown"],
  },
  encode(raw, blobs) {
    const request = parseRequest(raw, "openai-responses@1");
    validateProviderSettings(request, this.capabilities);
    const input: unknown[] = [];
    for (const message of request.messages) {
      const text = messageText(message, blobs);
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
        ...(request.thinking === undefined ? {} : { reasoning: { effort: "none" } }),
      },
    };
  },
  decode(res) {
    const body = z
      .object({ status: z.literal("completed"), output: z.array(output).min(1) })
      .parse(responseBody(res));
    return completion(
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
  },
};
