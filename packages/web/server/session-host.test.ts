import { expect, test } from "@logtape/testing-bun/autoload";

import { exportSession, openSession } from "./session-host.ts";

test("exportSession backs GET /api/session/:id/export.md with the session's Markdown journal", async () => {
  const { sessionId } = await openSession({});
  const result = exportSession(sessionId, "markdown");
  expect(result?.contentType).toBe("text/markdown; charset=utf-8");
  expect(result?.body).toContain(`# Session ${sessionId}`);
});

test("exportSession backs GET /api/session/:id/export.jsonl with one JSON record per line", async () => {
  const { sessionId } = await openSession({});
  const result = exportSession(sessionId, "jsonl");
  expect(result?.contentType).toBe("application/x-ndjson; charset=utf-8");
  const lines = result!.body.trim().split("\n");
  expect(lines.length).toBeGreaterThan(0);
  expect(JSON.parse(lines[0]!).body.kind).toBe("created");
});

test("exportSession returns undefined for a session this host never opened", () => {
  expect(exportSession("00000000-0000-4000-8000-000000000000", "markdown")).toBeUndefined();
  expect(exportSession("00000000-0000-4000-8000-000000000000", "jsonl")).toBeUndefined();
});
