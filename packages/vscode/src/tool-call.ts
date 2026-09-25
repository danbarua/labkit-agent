import type { ToolCall, ToolCallUpdate } from "@agentclientprotocol/sdk";

/** ACP updates replace supplied fields; null and omission do not erase prior values. */
export function mergeToolCall(previous: ToolCall | undefined, update: ToolCallUpdate): ToolCall {
  return {
    toolCallId: update.toolCallId,
    title: update.title ?? previous?.title ?? `Tool ${update.toolCallId}`,
    name: update.name ?? previous?.name,
    kind: update.kind ?? previous?.kind ?? "other",
    status: update.status ?? previous?.status ?? "pending",
    content: update.content ?? previous?.content ?? [],
    locations: update.locations ?? previous?.locations ?? [],
    rawInput: update.rawInput ?? previous?.rawInput,
    rawOutput: update.rawOutput ?? previous?.rawOutput,
    _meta: update._meta ?? previous?._meta,
  };
}
