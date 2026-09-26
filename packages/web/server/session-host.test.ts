import { getLogger } from "@logtape/logtape";
import { expect, spyOn, test } from "@logtape/testing-bun/autoload";

import { exportSession, openSession } from "./session-host.ts";

function observeLogs() {
  const records: { event: string; level: string; fields: Record<string, unknown> }[] = [];
  const logger = getLogger(["labkit", "web"]);
  const original = logger.emit.bind(logger);
  const spy = spyOn(logger, "emit").mockImplementation((record) => {
    records.push({
      event: String(record.rawMessage),
      level: record.level,
      fields: record.properties,
    });
    original(record);
  });
  return { records, close: () => spy.mockRestore() };
}

test("exportSession backs GET /api/session/:id/export.md with the session's Markdown journal", async () => {
  const { sessionId } = await openSession({});
  const capture = observeLogs();
  try {
    const result = exportSession(sessionId, "markdown");
    expect(result?.contentType).toBe("text/markdown; charset=utf-8");
    expect(result?.body).toContain(`# Session ${sessionId}`);
    expect(capture.records).toHaveLength(1);
    expect(capture.records[0]).toMatchObject({
      event: "web.export.completed",
      level: "info",
      fields: { sessionId, format: "markdown" },
    });
    expect(capture.records[0]!.fields.bytes).toBe(Buffer.byteLength(result!.body, "utf8"));
    expect(typeof capture.records[0]!.fields.durationMs).toBe("number");
  } finally {
    capture.close();
  }
});

test("exportSession backs GET /api/session/:id/export.jsonl with one JSON record per line", async () => {
  const { sessionId } = await openSession({});
  const result = exportSession(sessionId, "jsonl");
  expect(result?.contentType).toBe("application/x-ndjson; charset=utf-8");
  const lines = result!.body.trim().split("\n");
  expect(lines.length).toBeGreaterThan(0);
  expect(JSON.parse(lines[0]!).body.kind).toBe("created");
});

test("exportSession returns undefined and logs no warning for a session this host never opened", () => {
  const capture = observeLogs();
  try {
    expect(exportSession("00000000-0000-4000-8000-000000000000", "markdown")).toBeUndefined();
    expect(exportSession("00000000-0000-4000-8000-000000000000", "jsonl")).toBeUndefined();
    expect(capture.records).toEqual([
      {
        event: "web.export.not_found",
        level: "info",
        fields: {
          sessionId: "00000000-0000-4000-8000-000000000000",
          format: "markdown",
          event: "web.export.not_found",
        },
      },
      {
        event: "web.export.not_found",
        level: "info",
        fields: {
          sessionId: "00000000-0000-4000-8000-000000000000",
          format: "jsonl",
          event: "web.export.not_found",
        },
      },
    ]);
  } finally {
    capture.close();
  }
});
