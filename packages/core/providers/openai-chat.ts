import { z } from "zod";

import { ToolCallSchema } from "../agent/types.ts";
import { advertisements, completion, jsonArguments, messageText, responseBody } from "./shared.ts";
import { parseRequest, validateThinking, type CompletionProfile } from "./types.ts";

const response = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.enum(["stop", "tool_calls"]).optional(),
        message: z.object({
          role: z.literal("assistant").optional(),
          content: z.string().nullish(),
          tool_calls: z
            .array(
              z.object({
                id: z.string().min(1),
                type: z.literal("function"),
                function: z.object({ name: z.string().min(1), arguments: z.string() }),
              }),
            )
            .optional(),
          refusal: z.string().nullish(),
          // Legacy custom-server extension. New profiles use the reserved tool.
          handoff: z.string().optional(),
        }),
      }),
    )
    .length(1),
});
export const openaiChat: CompletionProfile = {
  id: "openai-chat@1",
  capabilities: {
    thinking: { mode: "effort", values: ["none", "low", "medium", "high"] },
    stream: false,
    media: ["text/plain", "text/markdown"],
  },
  encode(raw, blobs) {
    const request = parseRequest(raw, "openai-chat@1");
    validateThinking(request.thinking, this.capabilities.thinking);
    const tools = advertisements(request);
    return {
      path: "/chat/completions",
      method: "POST",
      headers: {},
      body: {
        model: request.model,
        messages: request.messages.map((message) => {
          const text = messageText(message, blobs);
          if (message.role === "tool")
            return { role: "tool", content: text, tool_call_id: message.callId };
          if (message.role === "assistant" && message.calls)
            return {
              role: "assistant",
              content: text,
              tool_calls: message.calls.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.args) },
              })),
            };
          return { role: message.role, content: text };
        }),
        ...(tools.length
          ? { tools: tools.map((tool) => ({ type: "function", function: tool })) }
          : {}),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.maxOutputTokens === undefined
          ? {}
          : { max_completion_tokens: request.maxOutputTokens }),
        ...(request.thinking === undefined
          ? {}
          : { reasoning_effort: request.thinking === "off" ? "none" : request.thinking }),
        // Omit stream for compatibility with minimal OpenAI-shaped local servers.
      },
    };
  },
  decode(res) {
    const message = response.parse(responseBody(res)).choices[0]!.message;
    if (message.refusal) throw new Error("Provider refused completion");
    if (message.handoff) throw new Error("Use the reserved handoff tool");
    if (message.content == null && !message.tool_calls?.length)
      throw new Error("No assistant message");
    return completion(
      message.content ?? "",
      (message.tool_calls ?? []).map((call) =>
        ToolCallSchema.parse({
          id: call.id,
          name: call.function.name,
          args: jsonArguments(call.function.arguments),
        }),
      ),
    );
  },
};
