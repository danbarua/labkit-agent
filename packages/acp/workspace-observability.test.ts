import "@logtape/testing-bun/autoload";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { AppendIdSchema, INITIAL_REVISION } from "@labkit-agent/core/session";
import { SessionIdSchema } from "@labkit-agent/core/types";
import { configure, getConfig, getConsoleSink, type LogRecord } from "@logtape/logtape";

import { workspaceDirectory } from "./workspace-directory.ts";
import { workspaceFiles } from "./workspace-files.ts";
import { workspacePersistence } from "./workspace-persistence.ts";

test("workspace diagnostics retain paths, SQLite causes, append identity and file outcomes", async () => {
  const previous = getConfig();
  const records: LogRecord[] = [];
  const consoleSink = getConsoleSink();
  await configure({
    reset: true,
    sinks: {
      capture(record) {
        records.push(record);
        if (process.env.LOGTAPE_TEST_MODE === "always") consoleSink(record);
      },
    },
    loggers: [
      { category: ["labkit"], lowestLevel: "debug", sinks: ["capture"] },
      { category: ["logtape", "meta"], lowestLevel: null },
    ],
  });
  const cwd = mkdtempSync(join(tmpdir(), "labkit-observability-"));
  try {
    const signal = new AbortController().signal;
    const sessionId = SessionIdSchema.parse("00000000-0000-4000-8000-000000000001");
    const store = workspacePersistence(cwd);
    const request = {
      sessionId,
      appendId: AppendIdSchema.parse("append-observed"),
      expectedRevision: INITIAL_REVISION,
      records: ["opaque"],
    };
    await store.append(request, signal);
    await store.load(sessionId, signal);
    await store.setScope(sessionId, [], signal);
    workspaceDirectory(cwd).list({}, signal);
    const files = await workspaceFiles(cwd);
    writeFileSync(join(cwd, "example.txt"), "FILE_BODY_NOT_A_DIAGNOSTIC");
    await Promise.all([
      files.readText("example.txt", signal, { toolCallId: "tool-read-one" }),
      files.readText("example.txt", signal, { toolCallId: "tool-read-two" }),
    ]);
    await expect(files.readText("missing.txt", signal)).rejects.toThrow();
    const aborted = new AbortController();
    aborted.abort(new Error("operator cancelled read"));
    await expect(files.readText("example.txt", aborted.signal)).rejects.toThrow(
      "operator cancelled read",
    );
    const db = new Database(join(cwd, ".labkit/sessions/store.sqlite"));
    db.exec("DROP TABLE batches");
    db.close();
    expect((await store.append(request, signal)).kind).toBe("indeterminate");
    expect((await store.load(sessionId, signal)).kind).toBe("failed");
    const events = records.map((record) => record.properties);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "workspace.storage.loaded",
        sessionId,
        revision: 1,
        batchCount: 1,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "workspace.storage.append_indeterminate",
        sessionId,
        appendId: "append-observed",
        error: expect.objectContaining({ message: expect.stringContaining("no such table") }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "workspace.file.failed",
        action: "read_text",
        path: join(await import("node:fs/promises").then((fs) => fs.realpath(cwd)), "missing.txt"),
        error: expect.objectContaining({ code: "ENOENT" }),
      }),
    );
    for (const toolCallId of ["tool-read-one", "tool-read-two"]) {
      const started = events.find(
        (event) => event.event === "workspace.file.started" && event.toolCallId === toolCallId,
      )!;
      expect(events).toContainEqual(
        expect.objectContaining({
          event: "workspace.file.completed",
          toolCallId,
          operationId: started.operationId,
        }),
      );
    }
    expect(
      new Set(
        events
          .filter((event) => event.event === "workspace.file.started" && event.toolCallId)
          .map((event) => event.operationId),
      ).size,
    ).toBe(2);
    const started = events.find((event) => event.event === "workspace.file.started")!;
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "workspace.file.completed",
        operationId: started.operationId,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "workspace.file.cancelled",
        error: expect.objectContaining({ message: "operator cancelled read" }),
      }),
    );
    expect(JSON.stringify(events)).not.toContain("FILE_BODY_NOT_A_DIAGNOSTIC");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    if (previous) await configure({ ...previous, reset: true });
  }
});
