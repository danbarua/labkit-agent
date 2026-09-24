import { notify } from "../host/notifications.ts";
import type { StreamAssembler, StreamDeltaSink, StreamEvent } from "./types.ts";

/** SSE framing is transport-owned; dialect assembly is an operation-local profile resource. */
export async function assembleStream(
  response: Response,
  assembler: StreamAssembler,
  signal: AbortSignal,
  sink?: StreamDeltaSink,
): Promise<unknown> {
  if (
    !response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream") ||
    !response.body
  ) {
    void response.body?.cancel().catch(() => {});
    throw new Error("Expected an SSE completion body");
  }
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let data: string[] = [];
  let event: string | undefined;
  const line = (value: string) => {
    if (!value) {
      if (data.length) {
        const frame: StreamEvent = { ...(event ? { event } : {}), data: data.join("\n") };
        if (frame.data.length > 16 * 1024 * 1024)
          throw new Error("Completion SSE frame exceeds 16 MiB");
        for (const delta of assembler.push(frame)) {
          signal.throwIfAborted();
          notify(sink, delta);
        }
      }
      data = [];
      event = undefined;
      return;
    }
    if (value.startsWith(":")) return;
    const colon = value.indexOf(":");
    const field = colon < 0 ? value : value.slice(0, colon);
    const raw = colon < 0 ? "" : value.slice(colon + 1);
    const content = raw.startsWith(" ") ? raw.slice(1) : raw;
    if (field === "data") data.push(content);
    if (field === "event") event = content;
  };
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      for (;;) {
        const index = buffer.search(/[\r\n]/);
        if (index < 0 || (!chunk.done && buffer[index] === "\r" && index === buffer.length - 1))
          break;
        const width = buffer[index] === "\r" && buffer[index + 1] === "\n" ? 2 : 1;
        line(buffer.slice(0, index));
        buffer = buffer.slice(index + width);
      }
      if (buffer.length + data.reduce((sum, item) => sum + item.length, 0) > 16 * 1024 * 1024)
        throw new Error("Completion SSE frame exceeds 16 MiB");
      if (chunk.done) break;
    }
    if (buffer || data.length) throw new Error("Incomplete completion SSE frame");
    signal.throwIfAborted();
    return assembler.finish();
  } finally {
    signal.removeEventListener("abort", cancel);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
