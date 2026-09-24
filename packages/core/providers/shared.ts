import { z } from "zod";

import { hashBlob, type BlobRef, type BlobResolver } from "../agent/content.ts";
import { CompletionSchema, type AgentMessage, type ToolCall } from "../agent/types.ts";
import { rejectStoppedResponse } from "./stops.ts";
import {
  CompletionRequestSchema,
  type CompletionRequest,
  type Continuation,
  type HttpResponse,
} from "./types.ts";

export const HANDOFF_TOOL = "handoff_to";
export function advertisements(request: CompletionRequest) {
  CompletionRequestSchema.parse(request);
  if (request.tools.some((tool) => tool.name === HANDOFF_TOOL))
    throw new Error("Reserved handoff tool name");
  return [
    ...request.tools,
    ...(request.successors.length
      ? [
          {
            name: HANDOFF_TOOL,
            description: "Transfer the conversation to an allowed successor agent.",
            parameters: {
              type: "object",
              properties: { agent: { type: "string", enum: [...request.successors] } },
              required: ["agent"],
              additionalProperties: false,
            },
          },
        ]
      : []),
  ];
}
export function completion(text: string, calls: readonly ToolCall[]) {
  const handoffs = calls.filter((call) => call.name === HANDOFF_TOOL);
  if (handoffs.length) {
    if (calls.length !== 1) throw new Error("Handoff cannot be mixed with other calls");
    const args = z.strictObject({ agent: z.string().min(1) }).parse(handoffs[0]!.args);
    return { completion: CompletionSchema.parse({ kind: "handoff", text, agent: args.agent }) };
  }
  return {
    completion: CompletionSchema.parse(
      calls.length ? { kind: "tools", text, calls } : { kind: "answer", text },
    ),
  };
}
export function jsonArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON tool arguments");
  }
}
export function responseBody(response: HttpResponse): unknown {
  if (response.status < 200 || response.status >= 300)
    throw new Error(`Completion HTTP failure (${response.status})`);
  rejectStoppedResponse(response.body);
  return response.body;
}
export function systemAndMessages(request: CompletionRequest, blobs?: BlobResolver) {
  return {
    system: request.messages
      .filter((message) => message.role === "system")
      .map((message) => messageText(message, blobs)),
    messages: request.messages.filter((message) => message.role !== "system"),
  };
}

/** Deterministic text projection; refs remain on the canonical request. */
export function attachmentText(ref: BlobRef, blobs?: BlobResolver): string {
  if (ref.media !== "text/plain" && ref.media !== "text/markdown")
    throw new Error(`Cannot inline attachment media as text: ${ref.media}`);
  const bytes = attachmentBytes(ref, blobs);
  return bytes.byteLength <= 65536
    ? new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    : `[attached: ${ref.name ?? ref.media} sha256:${ref.id}]`;
}
export function attachmentBytes(ref: BlobRef, blobs?: BlobResolver): Uint8Array {
  if (!blobs) throw new Error(`Missing blob resolver: ${ref.id}`);
  const bytes = blobs(ref.id);
  if (bytes.byteLength !== ref.bytes || hashBlob(bytes) !== ref.id)
    throw new Error(`Attachment bytes do not match ref: ${ref.id}`);
  return bytes;
}
export function messageText(message: AgentMessage, blobs?: BlobResolver): string {
  if (message.role === "tool" || !message.parts) return message.text;
  const segments: string[] = [];
  let previousWasText = false;
  for (const part of message.parts) {
    if (part.type === "text" && previousWasText) segments[segments.length - 1] += part.text;
    else segments.push(part.type === "text" ? part.text : attachmentText(part.ref, blobs));
    previousWasText = part.type === "text";
  }
  return segments.join("\n");
}

/** Resolve opaque JSON only while encoding inside the completion operation. */
export function continuationPayload(entry: Continuation, blobs?: BlobResolver): unknown {
  if (!entry.payloadBlob) return entry.payload;
  return z
    .json()
    .parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(attachmentBytes(entry.payloadBlob, blobs)),
      ),
    );
}
