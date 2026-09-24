import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";

import { redactDiagnostics } from "../logging/index.ts";
import type { ProviderCapture } from "../providers/transport.ts";

/** One caller-owned run. Files are written as evidence arrives, including failed/partial calls. */
export async function createProviderCapture(root: string) {
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
