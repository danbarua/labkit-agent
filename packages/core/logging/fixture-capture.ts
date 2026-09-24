// Bun/Node fixture infrastructure only. Never imported by the browser-compatible index.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getConfig, getLogger, withConfig, type LogRecord } from "@logtape/logtape";

import { redactDiagnostics, type DiagnosticFields } from "./index.ts";

/** Capture real fixture diagnostics without replacing global or parent-test routing. */
export async function withFixtureDiagnostics<T>(
  directory: string,
  fields: DiagnosticFields,
  callback: () => T,
): Promise<Awaited<T>> {
  const storage = getConfig()?.contextLocalStorage;
  if (!storage) {
    throw new Error(
      "Fixture diagnostic capture requires LogTape contextLocalStorage configuration",
    );
  }
  const parentContext = storage.getStore() ?? {};
  mkdirSync(directory, { recursive: true });
  const jsonPath = join(directory, "diagnostics.jsonl");
  const textPath = join(directory, "diagnostics.log");
  writeFileSync(jsonPath, "");
  writeFileSync(textPath, "");
  const failures: unknown[] = [];
  let writeFailed = false;
  const capture = (record: LogRecord): void => {
    const captured = redactDiagnostics({
      ...record,
      properties: { ...fields, ...record.properties },
    }) as LogRecord;
    if (!writeFailed) {
      try {
        appendFileSync(
          jsonPath,
          `${JSON.stringify({
            timestamp: new Date(captured.timestamp).toISOString(),
            level: captured.level,
            category: captured.category,
            event: captured.rawMessage,
            ...captured.properties,
          })}\n`,
        );
        const properties = Object.entries(captured.properties)
          .filter(([key, value]) => key !== "event" && value !== undefined)
          .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
          .join(" ");
        const event = captured.properties.event ?? captured.message.join("");
        appendFileSync(
          textPath,
          `${new Date(captured.timestamp).toISOString()} ${captured.level.toUpperCase()} ${captured.category.join(".")} ${event}${properties ? ` ${properties}` : ""}\n`,
        );
      } catch (error) {
        // diagnostic() isolates sink failures. Surface them after scenario cleanup instead.
        writeFailed = true;
        failures.push(error);
      }
    }
    storage.run(parentContext, () => getLogger(record.category).emit(record));
  };
  let result: Awaited<T> | undefined;
  try {
    result = await withConfig(
      {
        sinks: { fixture: capture },
        loggers: [
          { category: ["logtape", "meta"], lowestLevel: "warning", sinks: ["fixture"] },
          { category: ["labkit"], lowestLevel: "debug", sinks: ["fixture"] },
        ],
      },
      callback,
    );
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "Fixture execution and logging failed");
  return result as Awaited<T>;
}
