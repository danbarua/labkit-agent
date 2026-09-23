import { z } from "zod";

import { CompletionSchema, type ToolCall } from "../agent/types.ts";
import { CompletionRequestSchema, type CompletionRequest, type HttpResponse } from "./types.ts";

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
    return CompletionSchema.parse({ kind: "handoff", text, agent: args.agent });
  }
  return CompletionSchema.parse(
    calls.length ? { kind: "tools", text, calls } : { kind: "answer", text },
  );
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
  return response.body;
}
export function systemAndMessages(request: CompletionRequest) {
  return {
    system: request.messages
      .filter((message) => message.role === "system")
      .map((message) => message.text),
    messages: request.messages.filter((message) => message.role !== "system"),
  };
}
