import { z } from "zod";

import { anthropicStopReason } from "./anthropic-stop.ts";
import type { StreamAssembler, StreamDelta, StreamEvent } from "./types.ts";

const object = z.record(z.string(), z.json());
const indexSchema = z.number().int().nonnegative();
const usageDelta = (value: unknown): StreamDelta[] =>
  value == null ? [] : [{ usage: object.parse(value) }];
function body(event: StreamEvent) {
  const value = object.parse(JSON.parse(event.data));
  if (value.error || event.event === "error" || value.type === "error")
    throw new Error("Provider stream error");
  if (event.event && value.type && event.event !== value.type)
    throw new Error("Mismatched SSE event type");
  return value;
}
function incomplete(): never {
  throw new Error("Incomplete completion stream");
}

export function chatAssembler(): StreamAssembler {
  let done = false;
  let finish: string | undefined;
  let text = "";
  const calls = new Map<
    number,
    { id: string; type: "function"; function: { name: string; arguments: string } }
  >();
  return {
    push(event) {
      if (done) throw new Error("Data after completion terminator");
      if (event.data === "[DONE]") {
        if (!finish) incomplete();
        done = true;
        return [];
      }
      const chunk = body(event);
      const choices = z
        .array(
          z.object({
            index: z.literal(0),
            delta: z.strictObject({
              role: z.literal("assistant").optional(),
              content: z.string().nullish(),
              refusal: z.string().nullish(),
              tool_calls: z
                .array(
                  z.object({
                    index: indexSchema,
                    id: z.string().optional(),
                    type: z.literal("function").optional(),
                    function: z
                      .object({ name: z.string().optional(), arguments: z.string().optional() })
                      .optional(),
                  }),
                )
                .optional(),
            }),
            finish_reason: z.enum(["stop", "tool_calls"]).nullish(),
          }),
        )
        .max(1)
        .parse(chunk.choices);
      const deltas = usageDelta(chunk.usage);
      for (const choice of choices) {
        if (finish) throw new Error("Choice after finish reason");
        if (choice.delta.refusal) throw new Error("Provider refused completion");
        if (choice.delta.content) {
          text += choice.delta.content;
          deltas.push({ text: choice.delta.content });
        }
        for (const part of choice.delta.tool_calls ?? []) {
          let call = calls.get(part.index);
          if (!call) {
            if (part.index !== calls.size) throw new Error("Out-of-order tool call index");
            call = { id: "", type: "function", function: { name: "", arguments: "" } };
            calls.set(part.index, call);
          }
          if (part.id) {
            if (call.id) throw new Error("Duplicate tool call id fragment");
            call.id = part.id;
          }
          call.function.name += part.function?.name ?? "";
          call.function.arguments += part.function?.arguments ?? "";
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
      return deltas;
    },
    finish() {
      if (!done || !finish) incomplete();
      return {
        choices: [
          {
            finish_reason: finish,
            message: {
              role: "assistant",
              content: text,
              ...(calls.size ? { tool_calls: [...calls.values()] } : {}),
            },
          },
        ],
      };
    },
  };
}

export function anthropicAssembler(): StreamAssembler {
  let message: Record<string, z.JSONType> | undefined;
  let stopped = false;
  let reason: string | undefined;
  const blocks: Record<string, z.JSONType>[] = [];
  let active: { index: number; block: Record<string, z.JSONType>; json: string } | undefined;
  return {
    push(event) {
      const item = body(event);
      if (item.type === "ping") return [];
      if (stopped) throw new Error("Data after message_stop");
      if (item.type === "message_start") {
        if (message) throw new Error("Duplicate message_start");
        message = object.parse(item.message);
        z.object({ role: z.literal("assistant"), content: z.array(z.unknown()).length(0) }).parse(
          message,
        );
        return usageDelta(message.usage);
      }
      if (!message) throw new Error("Missing message_start");
      switch (item.type) {
        case "content_block_start": {
          if (active || reason || indexSchema.parse(item.index) !== blocks.length)
            throw new Error("Invalid content block start");
          const block = object.parse(item.content_block);
          z.enum(["text", "thinking", "redacted_thinking", "tool_use"]).parse(block.type);
          active = { index: blocks.length, block, json: "" };
          return block.type === "text" && typeof block.text === "string"
            ? [{ text: block.text }]
            : block.type === "thinking" && typeof block.thinking === "string"
              ? [{ thinking: block.thinking }]
              : [];
        }
        case "content_block_delta": {
          if (!active || item.index !== active.index)
            throw new Error("Delta without active content block");
          const delta = object.parse(item.delta);
          const field =
            delta.type === "text_delta"
              ? "text"
              : delta.type === "thinking_delta"
                ? "thinking"
                : delta.type === "signature_delta"
                  ? "signature"
                  : undefined;
          if (field) {
            if (active.block.type !== (field === "text" ? "text" : "thinking"))
              throw new Error("Wrong block delta type");
            const value = z.string().parse(delta[field]);
            active.block[field] = z.string().parse(active.block[field] ?? "") + value;
            return field === "signature" ? [] : [{ [field]: value }];
          }
          if (delta.type !== "input_json_delta" || active.block.type !== "tool_use")
            throw new Error("Unsupported block delta");
          active.json += z.string().parse(delta.partial_json);
          return [];
        }
        case "content_block_stop":
          if (!active || item.index !== active.index)
            throw new Error("Stop without active content block");
          if (active.json) active.block.input = object.parse(JSON.parse(active.json));
          blocks.push(active.block);
          active = undefined;
          return [];
        case "message_delta": {
          if (active || reason) throw new Error("Invalid message_delta");
          const delta = object.parse(item.delta);
          reason = anthropicStopReason(delta.stop_reason, item.usage);
          return usageDelta(item.usage);
        }
        case "message_stop":
          if (active || !reason) incomplete();
          stopped = true;
          return [];
        default:
          throw new Error("Unsupported Anthropic stream event");
      }
    },
    finish() {
      if (!stopped || !message || !reason) incomplete();
      return { ...message, content: blocks, stop_reason: reason };
    },
  };
}

export function responsesAssembler(): StreamAssembler {
  let started = false;
  let completed: Record<string, z.JSONType> | undefined;
  let responseId: string | undefined;
  let sequence = -1;
  return {
    push(event) {
      const item = body(event);
      if (completed) throw new Error("Data after response.completed");
      if (item.sequence_number !== undefined) {
        const next = indexSchema.parse(item.sequence_number);
        if (next <= sequence) throw new Error("Out-of-order response event");
        sequence = next;
      }
      if (item.type === "response.created") {
        if (started) throw new Error("Duplicate response.created");
        const response = object.parse(item.response);
        responseId = z.string().parse(response.id);
        started = true;
        return [];
      }
      if (!started) throw new Error("Missing response.created");
      switch (item.type) {
        case "response.completed": {
          const response = object.parse(item.response);
          if (response.id !== responseId || response.status !== "completed")
            throw new Error("Invalid completed response");
          completed = response;
          return usageDelta(response.usage);
        }
        case "response.output_text.delta":
          return [{ text: z.string().parse(item.delta) }];
        case "response.reasoning_summary_text.delta":
        case "response.reasoning_text.delta":
          return [{ thinking: z.string().parse(item.delta) }];
        case "response.in_progress":
        case "response.output_item.added":
        case "response.output_item.done":
        case "response.content_part.added":
        case "response.content_part.done":
        case "response.output_text.done":
        case "response.function_call_arguments.delta":
        case "response.function_call_arguments.done":
        case "response.reasoning_summary_part.added":
        case "response.reasoning_summary_part.done":
        case "response.reasoning_summary_text.done":
        case "response.reasoning_text.done":
          return [];
        default:
          throw new Error("Unsupported or failed Responses stream event");
      }
    },
    finish() {
      return completed ?? incomplete();
    },
  };
}

export function googleAssembler(): StreamAssembler {
  let finished = false;
  const parts: Record<string, z.JSONType>[] = [];
  return {
    push(event) {
      const chunk = body(event);
      const deltas = usageDelta(chunk.usageMetadata);
      if (chunk.promptFeedback) {
        const feedback = object.parse(chunk.promptFeedback);
        if (feedback.blockReason && feedback.blockReason !== "BLOCK_REASON_UNSPECIFIED")
          throw new Error("Blocked Google stream");
      }
      const candidates = z
        .array(
          z.object({
            index: z.literal(0).optional(),
            finishReason: z.literal("STOP").optional(),
            content: z
              .object({ role: z.literal("model").optional(), parts: z.array(object) })
              .optional(),
          }),
        )
        .max(1)
        .parse(chunk.candidates ?? []);
      for (const candidate of candidates) {
        if (finished) throw new Error("Candidate after finish reason");
        for (const part of candidate.content?.parts ?? []) {
          // A trailing signature-only fragment belongs to the preceding streamed part.
          if (Object.keys(part).length === 1 && typeof part.thoughtSignature === "string") {
            const previous = parts.at(-1);
            if (!previous || previous.thoughtSignature) throw new Error("Orphan thought signature");
            previous.thoughtSignature = part.thoughtSignature;
          } else parts.push(part);
          if (typeof part.text === "string")
            deltas.push(part.thought === true ? { thinking: part.text } : { text: part.text });
        }
        if (candidate.finishReason) finished = true;
      }
      return deltas;
    },
    finish() {
      if (!finished) incomplete();
      return { candidates: [{ finishReason: "STOP", content: { role: "model", parts } }] };
    },
  };
}
