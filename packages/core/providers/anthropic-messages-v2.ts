import { z } from "zod";

import type { BlobResolver } from "../agent/content.ts";
import { ToolCallSchema, type AgentMessage } from "../agent/types.ts";
import { anthropicStopReason } from "./anthropic-stop.ts";
import {
  advertisements,
  attachmentBytes,
  attachmentText,
  completion,
  continuationPayload,
  responseBody,
  systemAndMessages,
} from "./shared.ts";
import {
  matchingContinuations,
  parseRequest,
  validateThinking,
  type CompletionProfile,
} from "./types.ts";

const thinkingBlock = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("thinking"),
    thinking: z.string(),
    signature: z.string().min(1),
  }),
  z.strictObject({ type: z.literal("redacted_thinking"), data: z.string().min(1) }),
]);

const payloadSchema = z.strictObject({ blocks: z.array(thinkingBlock).min(1) });

const block = z.discriminatedUnion("type", [
  ...thinkingBlock.options,
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("tool_use"),
    id: z.string(),
    name: z.string(),
    input: z.record(z.string(), z.json()),
  }),
]);

function messageBlocks(
  message: Exclude<AgentMessage, { role: "tool" }>,
  blobs?: BlobResolver,
): unknown[] {
  if (!message.parts) return message.text ? [{ type: "text", text: message.text }] : [];
  return message.parts.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (
      part.ref.media === "image/png" ||
      part.ref.media === "image/jpeg" ||
      part.ref.media === "application/pdf"
    ) {
      if (message.role !== "user")
        throw new Error("Anthropic image/document attachments require a user message");
      return {
        type: part.ref.media === "application/pdf" ? "document" : "image",
        source: {
          type: "base64",
          media_type: part.ref.media,
          data: Buffer.from(attachmentBytes(part.ref, blobs)).toString("base64"),
        },
      };
    }
    return { type: "text", text: attachmentText(part.ref, blobs) };
  });
}

export function anthropicMessagesProfile(id: string, nativeAdaptive = false): CompletionProfile {
  return {
    id,
    capabilities: {
      thinking: nativeAdaptive ? { mode: "adaptive" } : { mode: "budget", maxTokens: 1024 },
      stream: false,
      media: ["text/plain", "text/markdown", "image/png", "image/jpeg", "application/pdf"],
    },
    encode(raw, blobs) {
      const request = parseRequest(raw, id);
      validateThinking(request.thinking, this.capabilities.thinking);
      if (
        !nativeAdaptive &&
        (request.thinking === "adaptive" || request.thinking === "budget") &&
        (request.maxOutputTokens === undefined || request.maxOutputTokens <= 1024)
      )
        throw new Error("Budget thinking requires maxOutputTokens > 1024");
      const split = systemAndMessages(request, blobs);
      const messages: { role: string; content: unknown[] }[] = [];
      for (const message of split.messages) {
        const role = message.role === "assistant" ? "assistant" : "user";
        const content: unknown[] =
          message.role === "tool"
            ? [{ type: "tool_result", tool_use_id: message.callId, content: message.text }]
            : [
                ...matchingContinuations([message], request.continuations ?? [], id).flatMap(
                  (entry) => payloadSchema.parse(continuationPayload(entry, blobs)).blocks,
                ),
                ...messageBlocks(message, blobs),
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
        if (previous?.role === role) {
          const hasThinking = (parts: unknown[]) =>
            parts.some((part) => thinkingBlock.safeParse(part).success);
          if (role === "assistant" && (hasThinking(previous.content) || hasThinking(content)))
            throw new Error(
              "Cannot merge adjacent assistant messages carrying thinking continuations",
            );
          previous.content.push(...content);
        } else messages.push({ role, content });
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
          thinking:
            request.thinking === "adaptive" || request.thinking === "budget"
              ? nativeAdaptive
                ? { type: "adaptive" }
                : { type: "enabled", budget_tokens: 1024 }
              : { type: "disabled" },
          stream: false,
          ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        },
      };
    },
    decode(res) {
      const raw = z.record(z.string(), z.unknown()).parse(responseBody(res));
      anthropicStopReason(raw.stop_reason, raw.usage);
      const body = z
        .object({
          role: z.literal("assistant"),
          stop_reason: z.enum(["end_turn", "tool_use", "stop_sequence"]),
          content: z.array(block).min(1),
        })
        .parse(raw);
      const decoded = completion(
        body.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
        body.content.flatMap((part) =>
          part.type === "tool_use"
            ? [ToolCallSchema.parse({ id: part.id, name: part.name, args: part.input })]
            : [],
        ),
      );
      const blocks = body.content.filter(
        (part) => part.type === "thinking" || part.type === "redacted_thinking",
      );
      return {
        ...decoded,
        ...(blocks.length ? { continuationPayload: payloadSchema.parse({ blocks }) } : {}),
      };
    },
  };
}

export const anthropicMessagesV2 = anthropicMessagesProfile("anthropic-messages@2");
