import { getLogger, type LogLevel } from "@logtape/logtape";

// Configuration and sink lifetime belong to the environment, never to a session.
export {
  configure,
  reset,
  getConsoleSink,
  getStreamSink,
  getJsonLinesFormatter,
  fromAsyncSink,
  type LogLevel,
  type LogRecord,
  type Sink,
} from "@logtape/logtape";

export type DiagnosticFields = Readonly<Record<string, unknown>>;

const secretField =
  /^(?:api[-_]?key|x[-_]api[-_]key|authorization|proxy[-_]authorization|password|client[-_]?secret|access[-_]?token|refresh[-_]?token|id[-_]?token|cookie|set-cookie)$/i;

function redactText(value: string, secrets: readonly string[]): string {
  let text = value;
  for (const secret of secrets) {
    if (secret) text = text.replaceAll(secret, "[REDACTED]");
  }
  return text
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=~-]+/gi, "[REDACTED authorization]")
    .replace(/\bsk-(?:ant-)?[A-Za-z0-9_-]{8,}/g, "[REDACTED API key]")
    .replace(/\bAIza[A-Za-z0-9_-]{20,}/g, "[REDACTED API key]")
    .replace(
      /((?:api[_-]?key|access_token|refresh_token|client_secret|password)[=\s:]+)[^\s&;,"']+/gi,
      "$1[REDACTED]",
    );
}

/** Preserve operational data; replace credential fields and recognizable credential text. */
export function redactDiagnostics(value: unknown, secrets: readonly string[] = []): unknown {
  const seen = new WeakSet<object>();
  function visit(input: unknown): unknown {
    if (typeof input === "string") return redactText(input, secrets);
    if (typeof input === "bigint") return input.toString();
    if (input === null || typeof input !== "object") return input;
    if (seen.has(input)) return "[Circular]";
    seen.add(input);
    try {
      if (input instanceof Date) return input.toISOString();
      if (Array.isArray(input)) return input.map(visit);
      const entries = input instanceof Headers ? [...input.entries()] : Object.entries(input);
      const output: Record<string, unknown> = {};
      if (input instanceof Error) {
        output.name = input.name;
        output.message = redactText(input.message, secrets);
        if (input.stack) output.stack = redactText(input.stack, secrets);
        if (input.cause !== undefined) output.cause = visit(input.cause);
        // Zod keeps field-level issues non-enumerable; preserve them as data, not just prose.
        if ("issues" in input && Array.isArray(input.issues)) output.issues = visit(input.issues);
      }
      for (const [key, item] of entries) {
        output[key] = secretField.test(key) ? "[REDACTED]" : visit(item);
      }
      return output;
    } finally {
      seen.delete(input);
    }
  }
  return visit(value);
}

/** Retain error identity, stack, nested causes, code and provider metadata. */
export function diagnosticError(
  error: unknown,
  secrets: readonly string[] = [],
): Record<string, unknown> {
  const detail = redactDiagnostics(error, secrets);
  return detail !== null && typeof detail === "object" && !Array.isArray(detail)
    ? (detail as Record<string, unknown>)
    : { message: detail };
}

/** Best-effort diagnostics cannot change actor execution or durable decisions. */
export function diagnostic(
  category: string,
  level: LogLevel,
  event: string,
  fields: DiagnosticFields = {},
): void {
  try {
    const properties = redactDiagnostics({ ...fields, event }) as Record<string, unknown>;
    const detail = Object.entries(properties)
      .filter(([key, value]) => key !== "event" && value !== undefined)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(" ");
    getLogger(["labkit", category]).emit({
      level,
      timestamp: Date.now(),
      rawMessage: event,
      message: [detail ? `${event} ${detail}` : event],
      properties,
    });
  } catch {
    // A failing synchronous sink must not become an operation failure.
    // Async sinks must use LogTape's fromAsyncSink (which handles rejections).
  }
}

/** Immutable explicit context; safe for concurrent sessions and browser runtimes. */
export function diagnosticContext(category: string, context: DiagnosticFields) {
  const bound = { ...context };
  return (level: LogLevel, event: string, fields: DiagnosticFields = {}): void =>
    diagnostic(category, level, event, { ...bound, ...fields });
}
