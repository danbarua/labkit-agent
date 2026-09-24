import type { AgentContext } from "@agentclientprotocol/sdk";
import { getLogger } from "@logtape/logtape";
import { expect, spyOn, test } from "@logtape/testing-bun/autoload";

import { clientFiles } from "./client-files.ts";

test("client file diagnostics identify targets, completion size, and client failure without contents", async () => {
  const logger = getLogger(["labkit", "acp"]);
  const emitted = spyOn(logger, "emit");
  try {
    const client = {
      request: async (method: string) => {
        if (method === "fs/write_text_file")
          throw new Error("Editor refused write: document is read-only");
        return { content: "PRIVATE_FILE_CONTENT" };
      },
    } as unknown as AgentContext;
    const signal = new AbortController().signal;
    const files = clientFiles(
      client,
      { fs: { readTextFile: true, writeTextFile: true } },
      () => "session-files",
      signal,
    );
    expect(await files.readText!("/workspace/file.ts", signal)).toBe("PRIVATE_FILE_CONTENT");
    await expect(
      files.write!("/workspace/file.ts", "PRIVATE_WRITE_CONTENT", signal),
    ).rejects.toThrow("read-only");
    const records = emitted.mock.calls.map((call) => call[0].properties);
    expect(records).toContainEqual(
      expect.objectContaining({
        event: "client_file.completed",
        sessionId: "session-files",
        path: "/workspace/file.ts",
        bytes: 20,
        durationMs: expect.any(Number),
        operationId: expect.any(String),
      }),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        event: "client_file.failed",
        operation: "fs/write_text_file",
        error: expect.objectContaining({ message: expect.stringContaining("read-only") }),
      }),
    );
    expect(JSON.stringify(records)).not.toContain("PRIVATE_");
  } finally {
    emitted.mockRestore();
  }
});

test("cancelled client file waits retain target and cancellation reason", async () => {
  const emitted = spyOn(getLogger(["labkit", "acp"]), "emit");
  try {
    const client = { request: () => new Promise(() => {}) } as unknown as AgentContext;
    const controller = new AbortController();
    const files = clientFiles(
      client,
      { fs: { readTextFile: true } },
      () => "cancel-session",
      new AbortController().signal,
    );
    const result = files.readText!("/workspace/stalled.ts", controller.signal).catch(
      (error) => error,
    );
    controller.abort(new Error("User cancelled editor read"));
    expect((await result).message).toContain("User cancelled");
    expect(emitted.mock.calls.map((call) => call[0].properties)).toContainEqual(
      expect.objectContaining({
        event: "client_file.cancelled",
        outcome: "cancelled",
        path: "/workspace/stalled.ts",
        error: expect.objectContaining({ message: "User cancelled editor read" }),
      }),
    );
  } finally {
    emitted.mockRestore();
  }
});

test("client file deadline is a timed-out failure rather than user cancellation", async () => {
  const emitted = spyOn(getLogger(["labkit", "acp"]), "emit");
  try {
    const client = {
      request: async () => {
        throw new DOMException("Editor request exceeded deadline", "TimeoutError");
      },
    } as unknown as AgentContext;
    const signal = new AbortController().signal;
    const files = clientFiles(
      client,
      { fs: { readTextFile: true } },
      () => "timeout-session",
      signal,
    );
    await expect(files.readText!("/workspace/stalled.ts", signal)).rejects.toThrow("deadline");
    expect(
      emitted.mock.calls.map((call) => ({ level: call[0].level, ...call[0].properties })),
    ).toContainEqual(
      expect.objectContaining({
        event: "client_file.failed",
        level: "warning",
        outcome: "timed_out",
        timeoutMs: 60000,
        error: expect.objectContaining({ name: "TimeoutError" }),
      }),
    );
  } finally {
    emitted.mockRestore();
  }
});
