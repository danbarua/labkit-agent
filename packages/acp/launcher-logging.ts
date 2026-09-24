import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { configure, reset, type LogLevel, type LogRecord } from "@logtape/logtape";

import { redactDiagnostics } from "../core/logging/index.ts";

const LEVELS = ["trace", "debug", "info", "warning", "error", "fatal"] as const;

/** Synchronous writes keep the queue bounded and preserve records before a crash. */
export function rotatingFileSink(path: string, maxBytes: number, backups: number) {
  let bytes = existsSync(path) ? statSync(path).size : 0;
  let descriptor = openSync(path, "a", 0o600);
  let closed = false;
  return {
    write(line: string) {
      if (closed) throw new Error("Diagnostic sink is closed");
      const size = Buffer.byteLength(line);
      if (bytes > 0 && bytes + size > maxBytes) {
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = -1;
        for (let index = backups; index >= 1; index--) {
          const source = index === 1 ? path : `${path}.${index - 1}`;
          const destination = `${path}.${index}`;
          if (existsSync(source)) renameSync(source, destination);
        }
        descriptor = openSync(path, "a", 0o600);
        bytes = 0;
      }
      appendFileSync(descriptor, line);
      bytes += size;
    },
    close() {
      if (closed) return;
      closed = true;
      if (descriptor >= 0) {
        try {
          fsyncSync(descriptor);
        } finally {
          closeSync(descriptor);
        }
      }
    },
  };
}

function positive(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error(`${name} must be a positive integer`);
  return number;
}

/** Retain the newest 20 stopped launches, never remove a live process's logs. */
function prune(directory: string) {
  const files = readdirSync(directory).filter((name) => /^acp-\d+-[a-f0-9-]+\.jsonl$/.test(name));
  const stopped = files
    .filter((name) => {
      const pid = Number(name.split("-")[1]);
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    })
    .sort((a, b) => statSync(join(directory, b)).mtimeMs - statSync(join(directory, a)).mtimeMs);
  for (const name of stopped.slice(20)) {
    for (const candidate of readdirSync(directory)) {
      if (candidate === name || candidate.startsWith(`${name}.`))
        unlinkSync(join(directory, candidate));
    }
  }
}

export async function startLauncherLogging(env: NodeJS.ProcessEnv = process.env) {
  const launcherId = crypto.randomUUID();
  const secrets = Object.entries(env)
    .filter(([name, value]) => value && /(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name))
    .map(([, value]) => value!);
  const directory = resolve(env.LABKIT_ACP_LOG_DIR ?? join(homedir(), ".labkit", "logs"));
  const path = join(directory, `acp-${process.pid}-${launcherId}.jsonl`);
  let destination: ReturnType<typeof rotatingFileSink> | undefined;
  let failed = false;
  const fallback = (error: unknown) => {
    if (!failed)
      process.stderr.write(
        `Labkit diagnostic file failure (${path}): ${JSON.stringify(redactDiagnostics(error, secrets))}; using stderr.\n`,
      );
    failed = true;
  };
  const maxBytes = positive(
    env.LABKIT_ACP_LOG_MAX_BYTES,
    10 * 1024 * 1024,
    "LABKIT_ACP_LOG_MAX_BYTES",
  );
  if (maxBytes < 1024) throw new Error("LABKIT_ACP_LOG_MAX_BYTES must be at least 1024");
  const backups = positive(env.LABKIT_ACP_LOG_BACKUPS, 4, "LABKIT_ACP_LOG_BACKUPS");
  const level = env.LABKIT_ACP_LOG_LEVEL ?? "debug";
  if (!LEVELS.includes(level as LogLevel))
    throw new Error(`Invalid LABKIT_ACP_LOG_LEVEL: ${level}`);
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    prune(directory);
    destination = rotatingFileSink(path, maxBytes, backups);
  } catch (error) {
    fallback(error);
  }
  const sink = (record: LogRecord) => {
    const line = `${JSON.stringify(
      redactDiagnostics(
        {
          timestamp: new Date(record.timestamp).toISOString(),
          level: record.level,
          category: record.category,
          event: record.rawMessage,
          processId: process.pid,
          launcherId,
          ...record.properties,
        },
        secrets,
      ),
    )}\n`;
    // Preserve oversized records as reconstructable fragments, never silently truncate a cause.
    const chunkSize = Math.floor(maxBytes / 12);
    const recordId = crypto.randomUUID();
    const total = Math.ceil(line.length / chunkSize);
    const lines =
      Buffer.byteLength(line) <= maxBytes
        ? [line]
        : Array.from(
            { length: total },
            (_, index) =>
              `${JSON.stringify({
                timestamp: new Date(record.timestamp).toISOString(),
                level: record.level,
                event: "diagnostic.record_chunk",
                processId: process.pid,
                launcherId,
                recordId,
                index,
                total,
                serializedFragment: line.slice(index * chunkSize, (index + 1) * chunkSize),
              })}\n`,
          );
    for (const entry of lines) {
      if (!failed && destination) {
        try {
          destination.write(entry);
          continue;
        } catch (error) {
          fallback(error);
        }
      }
      process.stderr.write(entry);
    }
  };
  await configure({
    reset: true,
    sinks: { diagnostic: sink },
    loggers: [
      { category: ["labkit"], lowestLevel: level as LogLevel, sinks: ["diagnostic"] },
      { category: ["logtape", "meta"], lowestLevel: "warning", sinks: ["diagnostic"] },
    ],
  });
  process.stderr.write(
    `Labkit diagnostics: ${path} (level=${level}; ${maxBytes} bytes/file; ${backups} backups)\n`,
  );
  return {
    path,
    launcherId,
    async close() {
      await reset();
      try {
        destination?.close();
      } catch (error) {
        fallback(error);
      }
    },
  };
}
