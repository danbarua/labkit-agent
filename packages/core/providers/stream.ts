import { notify } from "../host/notifications.ts";
import { diagnostic, diagnosticError } from "../logging/index.ts";
import type { ProviderDiagnosticContext } from "./transport.ts";
import type { StreamAssembler, StreamDeltaSink, StreamEvent } from "./types.ts";

/** SSE framing is transport-owned; dialect assembly is an operation-local profile resource. */
export async function assembleStream(
  response: Response,
  assembler: StreamAssembler,
  signal: AbortSignal,
  sink?: StreamDeltaSink,
  context: ProviderDiagnosticContext = {},
  secrets: readonly string[] = [],
): Promise<unknown> {
  if (
    !response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream") ||
    !response.body
  ) {
    void response.body?.cancel().catch(() => {});
    throw new Error("Expected an SSE completion body");
  }
  const started = performance.now();
  let bytes = 0;
  let frames = 0;
  let deltas = 0;
  const usage: Record<string, number> = {};
  let lastEvent: string | undefined;
  const terminalEvidence: Record<string, unknown> = {};
  diagnostic("provider", "debug", "provider.stream.started", context);
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
        frames++;
        lastEvent = event;
        // Read only terminal metadata, including frames rejected by the dialect parser.
        try {
          const value = JSON.parse(frame.data);
          if (value && typeof value === "object") {
            const snapshot =
              value.usage ?? value.usageMetadata ?? value.message?.usage ?? value.response?.usage;
            if (snapshot && typeof snapshot === "object")
              for (const [key, count] of Object.entries(snapshot))
                if (typeof count === "number") usage[key] = count;
            const evidence = {
              eventType: value.type,
              stopReason: value.stop_reason ?? value.delta?.stop_reason,
              finishReasons: Array.isArray(value.choices)
                ? value.choices.map((choice: { finish_reason?: unknown }) => choice?.finish_reason)
                : Array.isArray(value.candidates)
                  ? value.candidates.map(
                      (candidate: { finishReason?: unknown }) => candidate?.finishReason,
                    )
                  : undefined,
            };
            for (const [key, value] of Object.entries(evidence)) {
              if (value == null) continue;
              if (Array.isArray(value)) {
                const reasons = value.filter((reason) => reason != null);
                if (reasons.length) terminalEvidence[key] = reasons;
              } else terminalEvidence[key] = value;
            }
          }
        } catch {
          /* The assembler reports malformed JSON with its original cause. */
        }
        for (const delta of assembler.push(frame)) {
          deltas++;
          if (delta.usage)
            for (const [key, value] of Object.entries(delta.usage))
              if (typeof value === "number") usage[key] = value;
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
      if (chunk.value) bytes += chunk.value.byteLength;
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
    const body = assembler.finish();
    diagnostic("provider", "debug", "provider.stream.completed", {
      ...context,
      bytes,
      frames,
      deltas,
      lastEvent,
      usage,
      ...terminalEvidence,
      durationMs: Math.round(performance.now() - started),
    });
    return body;
  } catch (error) {
    diagnostic(
      "provider",
      signal.aborted ? "info" : "warning",
      signal.aborted ? "provider.stream.cancelled" : "provider.stream.failed",
      {
        ...context,
        bytes,
        frames,
        deltas,
        lastEvent,
        usage,
        ...terminalEvidence,
        bufferedCharacters: buffer.length,
        durationMs: Math.round(performance.now() - started),
        error: diagnosticError(error, secrets),
      },
    );
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
