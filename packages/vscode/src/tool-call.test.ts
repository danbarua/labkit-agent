import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, mock, test } from "bun:test";

import { mergeToolCall } from "./tool-call.ts";

mock.module("vscode", () => ({
  window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) },
  workspace: { getConfiguration: () => ({ get: (_name: string, fallback: unknown) => fallback }) },
}));

const { SessionUpdateHandler } = await import("./handlers/SessionUpdateHandler.ts");

const logger = await import("./utils/Logger.ts");

test("tool projection preserves raw falsy values, null patch semantics and explicit empty replacements", () => {
  const first = mergeToolCall(undefined, {
    toolCallId: "call",
    title: "Read file",
    name: "read_file",
    rawInput: false,
    rawOutput: 0,
    locations: [{ path: "/file" }],
  });
  const second = mergeToolCall(first, {
    toolCallId: "call",
    name: null,
    rawInput: null,
    rawOutput: null,
  });
  expect(second).toEqual(first);
  const third = mergeToolCall(second, {
    toolCallId: "call",
    name: "corrected_name",
    locations: [],
    rawInput: "",
    rawOutput: [],
  });
  expect(third).toMatchObject({
    name: "corrected_name",
    locations: [],
    rawInput: "",
    rawOutput: [],
  });
  expect(first).toMatchObject({
    name: "read_file",
    locations: [{ path: "/file" }],
    rawInput: false,
    rawOutput: 0,
  });
});

test("session-scoped tool state and its runtime logs retain inspectability without copying payloads into lifecycle events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "labkit-tool-state-"));
  const handler = new SessionUpdateHandler();
  logger.configureDiagnostics(directory, []);
  try {
    handler.handleUpdate({
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "same",
        title: "Read /workspace/report",
        name: "read_file",
        kind: "read",
        rawInput: "PRIVATE_INPUT",
        status: "in_progress",
        locations: [{ path: "/workspace/report" }],
      },
    });
    handler.handleUpdate({
      sessionId: "other",
      update: { sessionUpdate: "tool_call", toolCallId: "same", title: "Other call" },
    });
    handler.handleUpdate({
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "same",
        status: "completed",
        rawOutput: false,
      },
    });
    expect(handler.getToolCall("s", "same")).toMatchObject({
      name: "read_file",
      status: "completed",
      rawInput: "PRIVATE_INPUT",
      rawOutput: false,
      locations: [{ path: "/workspace/report" }],
    });
    expect(handler.getToolCall("other", "same")?.title).toBe("Other call");
    const text = await readFile(join(directory, "client.jsonl"), "utf8");
    const records = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.findLast((record) => record.event === "vscode.tool.updated")).toMatchObject({
      sessionId: "s",
      toolCallId: "same",
      name: "read_file",
      status: "completed",
      hasInput: true,
      hasOutput: true,
      locationCount: 1,
    });
    expect(text).not.toContain("PRIVATE_INPUT");
    expect(text).not.toContain('"level":"warning"');
    expect(text).not.toContain('"level":"error"');
    handler.handleUpdate({
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "same",
        status: "failed",
        rawOutput: { code: "ENOENT", path: "/workspace/report" },
      },
    });
    const failureText = await readFile(join(directory, "client.jsonl"), "utf8");
    const failure = failureText
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((record) => record.level === "warning");
    expect(failure).toMatchObject({
      event: "vscode.tool.failed",
      title: "Read /workspace/report",
      name: "read_file",
      sessionId: "s",
      toolCallId: "same",
      reportedOutput: { code: "ENOENT", path: "/workspace/report" },
    });
    const artifact = `.session-artifacts/vscode-tool-state/${crypto.randomUUID()}`;
    await mkdir(artifact, { recursive: true });
    await Bun.write(join(artifact, "diagnostics.jsonl"), failureText);
  } finally {
    handler.dispose();
    logger.disposeChannels();
    await rm(directory, { recursive: true, force: true });
  }
});
