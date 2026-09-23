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

type Category = "session" | "host" | "persistence" | "provider";
/** Explicit metadata only: never pass snapshots, requests, results, or errors. */
type Fields = Readonly<{
  sessionId?: string;
  turnId?: string;
  childId?: string;
  appendId?: string;
  requestId?: string;
  batchId?: string;
  callId?: string;
  revision?: number;
  expectedRevision?: number;
  operation?: string;
  outcome?: string;
  status?: string;
  count?: number;
}>;

/** Best-effort diagnostics cannot change actor execution or durable decisions. */
export function diagnostic(
  category: Category,
  level: LogLevel,
  event: string,
  fields: Fields = {},
): void {
  try {
    getLogger(["labkit", category])[level](event, { ...fields });
  } catch {
    // A failing synchronous sink must not become an operation failure.
    // Async sinks must use LogTape's fromAsyncSink (which handles rejections).
  }
}
