import { appendFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { redactDiagnostics } from "../logging/index.ts";
import type { ProviderCapture } from "../providers/transport.ts";

/** One caller-owned capture run: retained evidence directory plus its capture sink. */
export type ProviderCaptureRun = Readonly<{
  runId: string;
  directory: string;
  capture: ProviderCapture;
  flush: () => Promise<void>;
}>;

/** A run directory this module created: an optional embedded creator PID, then a UUID. */
const RUN_NAME = /^(?:(\d+)-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True once `pid` no longer exists; mirrors the ACP launcher's own log retention check. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH: no such process. Any other error (for example EPERM) means it still exists.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * True when `name` is a directory this module created for a capture run: its name matches
 * {@link RUN_NAME} and it holds a manifest (`manifest.json` from {@link createProviderCapture} or
 * `manifest.jsonl` from {@link openHttpTrace}). Anything else under `root` — unrelated files,
 * other directories, a run whose manifest write raced with a crash — is never touched.
 */
async function isCaptureRun(root: string, name: string): Promise<boolean> {
  if (!RUN_NAME.test(name)) return false;
  try {
    if (!(await stat(join(root, name))).isDirectory()) return false;
  } catch {
    return false;
  }
  for (const manifest of ["manifest.json", "manifest.jsonl"]) {
    try {
      await stat(join(root, name, manifest));
      return true;
    } catch {
      // Try the other manifest name.
    }
  }
  return false;
}

/**
 * Removes recognized capture run directories under `root` beyond the `keep` most recently
 * modified. Only entries {@link isCaptureRun} recognizes are ever candidates; every other file or
 * directory under `root` is left exactly as found. A run whose name embeds a still-alive process
 * ID (see {@link openHttpTrace}) is never removed, regardless of age, so a long-running launcher's
 * own active run survives a concurrent launcher's prune. A run that fails to stat is treated as
 * newest and kept, so a write in progress is never pruned mid-flight.
 */
export async function pruneProviderCaptures(root: string, keep: number): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return;
  }
  const runs = (
    await Promise.all(entries.map(async (name) => ((await isCaptureRun(root, name)) ? name : null)))
  ).filter((name): name is string => name !== null);
  const withAge = await Promise.all(
    runs.map(async (name) => {
      const pid = Number(RUN_NAME.exec(name)?.[1]);
      if (Number.isFinite(pid) && isProcessAlive(pid)) return null;
      try {
        return { name, mtimeMs: (await stat(join(root, name))).mtimeMs };
      } catch {
        return { name, mtimeMs: Infinity };
      }
    }),
  );
  const stale = withAge
    .filter((entry): entry is { name: string; mtimeMs: number } => entry !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(keep);
  for (const { name } of stale) await rm(join(root, name), { recursive: true, force: true });
}

/** Options for {@link openHttpTrace}. */
export type HttpTraceOptions = Readonly<{
  /** Retain the newest N run directories across process restarts; default 20. */
  keep?: number;
  /** Rotate to a new run after this many distinct HTTP calls are recorded; default 2000. */
  maxCalls?: number;
  /** Rotate to a new run once its manifest file would exceed this many bytes; default 64 MiB. */
  maxBytes?: number;
}>;

/** A bounded, rotated side-car HTTP trace opened by {@link openHttpTrace}. */
export type HttpTrace = Readonly<{
  /** Absolute directory of the run currently accepting writes; changes across rotation. */
  directory: () => string;
  capture: ProviderCapture;
  /** Waits for outstanding writes; does not stop the trace from accepting more. */
  close: () => Promise<void>;
}>;

const DEFAULT_HTTP_TRACE_MAX_CALLS = 2000;
const DEFAULT_HTTP_TRACE_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Opens a bounded, rotated side-car HTTP trace for a long-running launcher process: full
 * request/response bodies, credential-redacted, for every provider call bound to it. Bind the
 * returned `capture` to every provider's `transport.capture` for this process's lifetime.
 *
 * `root` must be an absolute path (never a relative path resolved against an arbitrary current
 * directory); it is also `resolve()`d. Prunes run directories from earlier process generations
 * before starting (never one a live process still owns, and never anything under `root` that
 * is not a recognized capture run), then rotates to a fresh run directory once the current one
 * has recorded `maxCalls` calls or its manifest would exceed `maxBytes`. Each call's events are
 * appended as one JSONL line to the current run's `manifest.jsonl`, never rewritten, so recording
 * a call costs one append rather than a rewrite of every call recorded so far.
 */
export async function openHttpTrace(
  root: string,
  options: HttpTraceOptions = {},
): Promise<HttpTrace> {
  if (!isAbsolute(root))
    throw new Error(`HTTP trace directory must be an absolute path, got: ${root}`);
  const base = resolve(root);
  const keep = options.keep ?? 20;
  const maxCalls = options.maxCalls ?? DEFAULT_HTTP_TRACE_MAX_CALLS;
  const maxBytes = options.maxBytes ?? DEFAULT_HTTP_TRACE_MAX_BYTES;
  await pruneProviderCaptures(base, keep);

  let directory = "";
  let manifestPath = "";
  let bytes = 0;
  let calls = 0;
  let seenCalls = new Set<string>();

  const rotate = async () => {
    directory = join(base, `${process.pid}-${crypto.randomUUID()}`);
    manifestPath = join(directory, "manifest.jsonl");
    await mkdir(directory, { recursive: true });
    bytes = 0;
    calls = 0;
    seenCalls = new Set();
    await pruneProviderCaptures(base, keep);
  };
  await rotate();

  let writes = Promise.resolve();
  const capture: ProviderCapture = (event) => {
    writes = writes.then(async () => {
      const isNewCall = !seenCalls.has(event.httpRequestId);
      // Only rotate between calls; never split one call's own request/response across two runs.
      if (isNewCall && (bytes >= maxBytes || calls >= maxCalls)) await rotate();
      if (isNewCall) {
        seenCalls.add(event.httpRequestId);
        calls++;
      }
      const line = `${JSON.stringify(redactDiagnostics({ timestamp: new Date().toISOString(), ...event }))}\n`;
      await appendFile(manifestPath, line, "utf8");
      bytes += Buffer.byteLength(line);
    });
    return writes;
  };

  return { directory: () => directory, capture, close: () => writes };
}

/** One caller-owned run. Files are written as evidence arrives, including failed/partial calls. */
export async function createProviderCapture(root: string): Promise<ProviderCaptureRun> {
  const runId = crypto.randomUUID();
  const directory = join(root, runId);
  await mkdir(directory, { recursive: true });

  const writeEvidence = async (name: string, text: string) => {
    const target = join(directory, name);
    const temporary = `${target}.pending`;
    await Bun.write(temporary, text);
    await rename(temporary, target);
  };

  const calls = new Map<string, Record<string, unknown>>();
  let writes = Promise.resolve();
  const capture: ProviderCapture = (event) => {
    writes = writes.then(async () => {
      const id = event.httpRequestId;
      const fileId = encodeURIComponent(id);
      const row = calls.get(id) ?? { httpRequestId: id, evidence: "completion_validation" };
      if (event.kind === "http_request") row.evidence = "actual_http";
      const { body, ...metadata } = event;
      Object.assign(row, redactDiagnostics(metadata));
      if (event.kind === "http_response") row.transportPhase = event.phase;
      if (event.kind === "completion") row.completionPhase = event.phase;
      if (typeof body === "string") {
        const name = `${fileId}.${event.kind === "http_request" ? "request" : "response"}.txt`;
        await writeEvidence(name, body);
        row[event.kind === "http_request" ? "requestFile" : "responseFile"] = name;
        row[event.kind === "http_request" ? "requestBytes" : "responseBytes"] =
          new TextEncoder().encode(body).byteLength;
        if (event.kind === "http_request") {
          try {
            const parsed = JSON.parse(body);
            const messages = parsed.messages ?? parsed.input ?? parsed.contents ?? [];
            row.messageCount = Array.isArray(messages) ? messages.length : 0;
            const texts = Array.isArray(messages)
              ? messages.map((value: unknown) => JSON.stringify(value))
              : [];
            row.repeatedMessageBytes = texts.reduce(
              (sum: number, text: string, index: number) =>
                sum + (texts.indexOf(text) < index ? new TextEncoder().encode(text).byteLength : 0),
              0,
            );
          } catch {
            /* Exact body remains available. */
          }
        }
      }
      calls.set(id, row);
      await writeEvidence(
        "manifest.json",
        JSON.stringify({ runId, calls: [...calls.values()] }, null, 2),
      );
      await writeEvidence(
        "README.md",
        [
          `# Provider traffic: ${runId}`,
          "",
          "Actual HTTP bodies are retained separately. Scripted completion ports are not HTTP traffic. Repeated bytes count identical messages within each request; independent requests are reported separately.",
          "",
          "| Call | Model | Messages | Request bytes | Response bytes | Repeated message bytes | Outcome / stage |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          ...[...calls.values()].map(
            (call) =>
              `| ${call.httpRequestId} | ${call.model ?? ""} / ${call.wireModel ?? call.model ?? ""} | ${call.messageCount ?? ""} | [${call.requestBytes ?? ""}](${call.requestFile ?? ""}) | [${call.responseBytes ?? ""}](${call.responseFile ?? ""}) | ${call.repeatedMessageBytes ?? ""} | ${call.outcome ?? (call.error ? "failed" : "pending")} / ${call.completionPhase ?? ""}/${call.transportPhase ?? call.phase ?? ""} |`,
          ),
          "",
        ].join("\n"),
      );
    });
    return writes;
  };
  await writeEvidence("manifest.json", JSON.stringify({ runId, calls: [] }));
  return { runId, directory, capture, flush: () => writes };
}
