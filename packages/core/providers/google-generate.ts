import { z } from "zod";

import { ToolCallSchema } from "../agent/types.ts";
import {
  advertisements,
  completion,
  messageText,
  responseBody,
  systemAndMessages,
} from "./shared.ts";
import { parseRequest, validateThinking, type CompletionProfile } from "./types.ts";

const part = z.union([
  z.strictObject({
    text: z.string(),
    thought: z.literal(false).optional(),
    thoughtSignature: z.never().optional(),
  }),
  z.strictObject({
    functionCall: z.object({
      id: z.string().optional(),
      name: z.string(),
      args: z.record(z.string(), z.json()).optional(),
    }),
    thoughtSignature: z.never().optional(),
  }),
]);
export const googleGenerate: CompletionProfile = {
  id: "google-generate@1",
  capabilities: {
    thinking: { mode: "off" },
    stream: false,
    media: ["text/plain", "text/markdown"],
  },
  encode(raw, blobs) {
    const request = parseRequest(raw, "google-generate@1");
    validateThinking(request.thinking, this.capabilities.thinking);
    const split = systemAndMessages(request, blobs);
    const contents: { role: string; parts: unknown[] }[] = [];
    const calls = new Map<string, string>();
    for (const message of split.messages) {
      const text = messageText(message, blobs);
      const role = message.role === "assistant" ? "model" : "user";
      const parts: unknown[] = [];
      if (message.role === "tool")
        parts.push({
          functionResponse: {
            id: message.callId,
            name: calls.get(message.callId),
            response: { output: text },
          },
        });
      else {
        if (text) parts.push({ text: text });
        if (message.role === "assistant")
          for (const call of message.calls ?? []) {
            calls.set(call.id, call.name);
            parts.push({
              functionCall: {
                id: call.id,
                name: call.name,
                args: z.record(z.string(), z.json()).parse(call.args),
              },
            });
          }
      }
      const previous = contents.at(-1);
      if (previous?.role === role) previous.parts.push(...parts);
      else contents.push({ role, parts });
    }
    return {
      path: `/models/${encodeURIComponent(request.model.replace(/^models\//, ""))}:generateContent`,
      method: "POST",
      headers: {},
      body: {
        contents,
        systemInstruction: { parts: split.system.map((text) => ({ text })) },
        tools: [
          {
            functionDeclarations: advertisements(request).map(({ parameters, ...tool }) => ({
              ...tool,
              parametersJsonSchema: parameters,
            })),
          },
        ],
        generationConfig: {
          thinkingConfig: { thinkingBudget: 0 },
          ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
          ...(request.maxOutputTokens === undefined
            ? {}
            : { maxOutputTokens: request.maxOutputTokens }),
        },
      },
    };
  },
  decode(res) {
    const body = z
      .object({
        candidates: z
          .array(
            z.object({
              finishReason: z.literal("STOP"),
              content: z.object({ role: z.literal("model"), parts: z.array(part).min(1) }),
            }),
          )
          .length(1),
      })
      .parse(responseBody(res));
    const parts = body.candidates[0]!.content.parts;
    return completion(
      parts.flatMap((value) => ("text" in value ? [value.text] : [])).join(""),
      parts.flatMap((value, index) =>
        "functionCall" in value
          ? [
              ToolCallSchema.parse({
                // Stable within this response. Domain correlation scopes IDs to each batch.
                id: value.functionCall.id ?? `google-call-${index}`,
                name: value.functionCall.name,
                args: value.functionCall.args ?? {},
              }),
            ]
          : [],
      ),
    );
  },
};
