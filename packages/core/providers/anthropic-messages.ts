import { z } from "zod";
import { ToolCallSchema } from "../agent/types.ts";
import { advertisements, completion, responseBody, systemAndMessages } from "./shared.ts";
import { parseRequest, type CompletionProfile } from "./types.ts";
const block = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("tool_use"),
    id: z.string(),
    name: z.string(),
    input: z.record(z.string(), z.json()),
  }),
]);
export const anthropicMessages: CompletionProfile = {
  id: "anthropic-messages@1",
  encode(raw) {
    const request = parseRequest(raw);
    const split = systemAndMessages(request);
    const messages: { role: string; content: unknown[] }[] = [];
    for (const message of split.messages) {
      const role = message.role === "assistant" ? "assistant" : "user";
      const content: unknown[] =
        message.role === "tool"
          ? [{ type: "tool_result", tool_use_id: message.callId, content: message.text }]
          : [
              ...(message.text ? [{ type: "text", text: message.text }] : []),
              ...(message.role === "assistant"
                ? (message.calls ?? []).map((call) => ({
                    type: "tool_use",
                    id: call.id,
                    name: call.name,
                    input: z.record(z.string(), z.json()).parse(call.args),
                  }))
                : []),
            ];
      const previous = messages.at(-1);
      if (previous?.role === role) previous.content.push(...content);
      else messages.push({ role, content });
    }
    return {
      path: "/messages",
      method: "POST",
      headers: { "anthropic-version": "2023-06-01" },
      body: {
        model: request.model,
        max_tokens: request.maxOutputTokens ?? 1024,
        system: split.system.map((text) => ({ type: "text", text })),
        messages,
        tools: advertisements(request).map(({ parameters, ...tool }) => ({
          ...tool,
          input_schema: parameters,
        })),
        thinking: { type: "disabled" },
        stream: false,
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      },
    };
  },
  decode(res) {
    const body = z
      .object({
        role: z.literal("assistant"),
        stop_reason: z.enum(["end_turn", "tool_use", "stop_sequence"]),
        content: z.array(block).min(1),
      })
      .parse(responseBody(res));
    return completion(
      body.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
      body.content.flatMap((part) =>
        part.type === "tool_use"
          ? [ToolCallSchema.parse({ id: part.id, name: part.name, args: part.input })]
          : [],
      ),
    );
  },
};
