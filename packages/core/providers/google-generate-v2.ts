import { z } from "zod";

import { ToolCallSchema } from "../agent/types.ts";
import {
  advertisements,
  completion,
  continuationPayload,
  messageText,
  responseBody,
  systemAndMessages,
} from "./shared.ts";
import {
  matchingContinuations,
  parseRequest,
  validateThinking,
  type CompletionProfile,
} from "./types.ts";

const part = z.union([
  z.strictObject({
    text: z.string(),
    thought: z.boolean().optional(),
    thoughtSignature: z.string().min(1).optional(),
  }),
  z.strictObject({
    functionCall: z.object({
      id: z.string().optional(),
      name: z.string(),
      args: z.record(z.string(), z.json()).optional(),
    }),
    thoughtSignature: z.string().min(1).optional(),
  }),
]);

const payloadSchema = z.strictObject({ parts: z.array(part).min(1) });

export const googleGenerateV2: CompletionProfile = {
  id: "google-generate@2",
  capabilities: {
    thinking: { mode: "budget", maxTokens: 1024 },
    stream: false,
    media: ["text/plain", "text/markdown"],
  },
  encode(raw, blobs) {
    const request = parseRequest(raw, "google-generate@2");
    validateThinking(request.thinking, this.capabilities.thinking);
    const split = systemAndMessages(request, blobs);
    const contents: { role: string; parts: unknown[] }[] = [];
    const calls = new Map<string, string>();
    for (const message of split.messages) {
      const text = messageText(message, blobs);
      const role = message.role === "assistant" ? "model" : "user";
      const envelope = matchingContinuations(
        [message],
        request.continuations ?? [],
        "google-generate@2",
      )[0];
      const replay = envelope
        ? payloadSchema.parse(continuationPayload(envelope, blobs)).parts
        : undefined;
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
        if (replay) parts.push(...replay);
        else if (text) parts.push({ text: text });
        if (message.role === "assistant")
          for (const call of message.calls ?? []) {
            calls.set(call.id, call.name);
            if (!replay)
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
      if (previous?.role === role && role !== "model") previous.parts.push(...parts);
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
          thinkingConfig: { thinkingBudget: request.thinking === "budget" ? 1024 : 0 },
          ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
          ...(request.maxOutputTokens === undefined
            ? {}
            : { maxOutputTokens: request.maxOutputTokens }),
        },
      },
    };
  },
  decode(res, request) {
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
    if (
      request?.thinking === "budget" &&
      parts.some((value) => "functionCall" in value && !value.thoughtSignature)
    )
      throw new Error("Thinking function calls require thoughtSignature");
    const decoded = completion(
      parts.flatMap((value) => ("text" in value && !value.thought ? [value.text] : [])).join(""),
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
    return {
      ...decoded,
      ...(parts.some((value) => value.thoughtSignature || ("thought" in value && value.thought))
        ? { continuationPayload: { parts } }
        : {}),
    };
  },
};
