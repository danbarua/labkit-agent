import { methods, type AnyMessage, type Stream } from "@agentclientprotocol/sdk";
import { diagnostic } from "@labkit-agent/core/logging";

const specMethods = new Set<string>(
  Object.values(methods.agent).flatMap((value) =>
    typeof value === "string" ? [value] : Object.values(value),
  ),
);

/**
 * Passes every incoming message through unchanged and logs `acp.method.unknown` for each request
 * or notification whose method no handler registered in `known`.
 */
export function watchUnknownMethods(
  stream: Stream,
  known: ReadonlySet<string>,
  connectionId: string,
): Stream {
  const watch = (message: unknown) => {
    if (typeof message !== "object" || message === null || !("method" in message)) return;
    const method = message.method;
    if (typeof method !== "string" || known.has(method)) return;
    const request = "id" in message;
    diagnostic("acp", "warning", "acp.method.unknown", {
      connectionId,
      method,
      kind: request ? "request" : "notification",
      ...(request ? { rpcRequestId: String(message.id) } : {}),
      specMethod: specMethods.has(method),
      consequence:
        "The SDK answers -32601 Method not found for requests and drops notifications; the client or host expects a method this agent does not implement",
    });
  };
  return {
    writable: stream.writable,
    readable: stream.readable.pipeThrough(
      new TransformStream<AnyMessage, AnyMessage>({
        transform(message, controller) {
          const batch: readonly unknown[] = Array.isArray(message) ? message : [message];
          batch.forEach(watch);
          controller.enqueue(message);
        },
      }),
    ),
  };
}
