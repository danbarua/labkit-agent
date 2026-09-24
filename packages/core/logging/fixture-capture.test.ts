import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getLogger, withConfig, type LogRecord } from "@logtape/logtape";
import { expect, test } from "@logtape/testing-bun/autoload";

import { withFixtureDiagnostics } from "./fixture-capture.ts";
import { diagnostic } from "./index.ts";

test("fixture artifacts capture real correlated diagnostics and preserve parent routing", async () => {
  const root = await mkdtemp(join(tmpdir(), "labkit-fixture-logs-"));
  const parent: LogRecord[] = [];
  try {
    await withConfig(
      {
        sinks: {
          parent: (record) => {
            parent.push(record);
          },
        },
        loggers: [{ category: ["labkit"], lowestLevel: "info", sinks: ["parent"] }],
      },
      async () => {
        await Promise.all(
          ["first", "second"].map(async (scenario) => {
            await withFixtureDiagnostics(
              join(root, scenario),
              { scenario, runId: "run-7" },
              async () => {
                diagnostic("host", "debug", "tool.waiting", {
                  sessionId: scenario,
                  toolCallId: `${scenario}/tool-1`,
                  reason: "Awaiting permission",
                  path: "/workspace/core.ts",
                  apiKey: "secret-key",
                });
                await new Promise((resolve) => setTimeout(resolve, scenario === "first" ? 5 : 1));
                diagnostic("host", "info", "tool.completed", {
                  sessionId: scenario,
                  durationMs: 12,
                });
              },
            );
          }),
        );
        getLogger(["labkit", "host"]).info("parent unaffected");
      },
    );
    for (const scenario of ["first", "second"]) {
      const json = await readFile(join(root, scenario, "diagnostics.jsonl"), "utf8");
      const records = json
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records).toHaveLength(2);
      expect(records[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(records[0].event).toBe("tool.waiting");
      expect(records[0].category).toEqual(["labkit", "host"]);
      expect(records[0].properties).toBeUndefined();
      expect(records.every((record) => record.sessionId === scenario)).toBe(true);
      expect(
        records.every((record) => record.scenario === scenario && record.runId === "run-7"),
      ).toBe(true);
      expect(json).not.toContain("secret-key");
      const text = await readFile(join(root, scenario, "diagnostics.log"), "utf8");
      for (const detail of [
        "tool.waiting",
        "Awaiting permission",
        "/workspace/core.ts",
        scenario,
        "run-7",
      ])
        expect(text).toContain(detail);
    }
    expect(parent.map((record) => record.rawMessage)).toEqual([
      "tool.completed",
      "tool.completed",
      "parent unaffected",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed fixture retains diagnostic files and original failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "labkit-failed-fixture-"));
  try {
    const failure = new Error("fixture failed");
    await expect(
      withFixtureDiagnostics(directory, { scenario: "failed" }, () => {
        diagnostic("provider", "warning", "request.failed", {
          sessionId: "session-9",
          reason: "Provider HTTP 400",
          providerRequestId: "req-99",
        });
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(await readFile(join(directory, "diagnostics.log"), "utf8")).toContain("req-99");
    expect(await readFile(join(directory, "diagnostics.jsonl"), "utf8")).toContain(
      "Provider HTTP 400",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
