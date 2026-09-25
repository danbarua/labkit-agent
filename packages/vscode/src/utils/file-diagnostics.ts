import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { rotatingFileSink } from "../../../acp/launcher-logging.ts";
import { redactDiagnostics } from "../../../core/logging/index.ts";

/** One bounded log set per extension storage directory, across restarts. */
export function fileDiagnostics(
  directory: string,
  secrets: readonly string[] = [],
  maxBytes = 10 * 1024 * 1024,
) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "client.jsonl");
  const sink = rotatingFileSink(path, maxBytes, 4);
  return {
    path,
    write(
      level: "debug" | "info" | "warning" | "error",
      event: string,
      fields: Record<string, unknown> = {},
    ) {
      const record = redactDiagnostics(
        { timestamp: new Date().toISOString(), level, event, ...fields },
        secrets,
      );
      sink.write(`${JSON.stringify(record)}\n`);
      return record;
    },
    close: () => sink.close(),
  };
}
