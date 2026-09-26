import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@logtape/testing-bun/autoload";

import { withFixtureDiagnostics } from "../core/logging/fixture-capture.ts";
import { harness, setup } from "./testing/harness.ts";

test("/export writes the session's Markdown journal locally and never dispatches a completion", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "labkit-acp-export-"));
  let completions = 0;
  const base = setup({
    complete: () => {
      completions++;
      return { kind: "answer", text: "should never be requested" };
    },
  });
  const h = harness(base.options);
  try {
    await h.initialize();
    const opened = await h.request("session/new", { cwd, mcpServers: [] });
    const sessionId = opened.result.sessionId as string;
    expect(
      h.updates().find((message) => message.update.sessionUpdate === "available_commands_update")
        ?.update,
    ).toEqual({
      sessionUpdate: "available_commands_update",
      availableCommands: [
        {
          name: "export",
          description:
            "Write this session's history to a Markdown file under .labkit/exports and reply with its path.",
        },
      ],
    });

    const response = await h.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "/export" }],
    });
    expect(response.error).toBeUndefined();
    expect(response.result.stopReason).toBe("end_turn");
    expect(completions).toBe(0);

    const exportPath = join(cwd, ".labkit", "exports", `${sessionId}.md`);
    const content = await readFile(exportPath, "utf8");
    expect(content).toContain(`# Session ${sessionId}`);

    const chunk = h
      .updates()
      .map(({ update }) => update)
      .find((update) => update.sessionUpdate === "agent_message_chunk") as
      { messageId: string; content: { type: string; text: string } } | undefined;
    expect(chunk?.content).toEqual({
      type: "text",
      text: `Exported session history to \`${exportPath}\`.`,
    });

    // A second /export in the same session must not reuse the first request's messageId.
    const second = await h.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "/export" }],
    });
    expect(second.result.stopReason).toBe("end_turn");
    const exportChunks = h
      .updates()
      .map(({ update }) => update)
      .filter((update) => update.sessionUpdate === "agent_message_chunk") as {
      messageId: string;
    }[];
    expect(exportChunks).toHaveLength(2);
    expect(exportChunks[0]!.messageId).not.toBe(exportChunks[1]!.messageId);

    // A normal prompt afterward still dispatches the model, proving /export did not consume the turn.
    const followUp = await h.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "Hello" }],
    });
    expect(followUp.result.stopReason).toBe("end_turn");
    expect(completions).toBe(1);
  } finally {
    await h.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("/export with trailing text still runs locally and does not leak into a model prompt", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "labkit-acp-export-"));
  let requestedText: string | undefined;
  const base = setup({
    complete: (request) => {
      requestedText = request.messages.at(-1)!.content;
      return { kind: "answer", text: "Done" };
    },
  });
  const h = harness(base.options);
  try {
    await h.initialize();
    const opened = await h.request("session/new", { cwd, mcpServers: [] });
    const sessionId = opened.result.sessionId as string;
    const response = await h.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "/export please" }],
    });
    expect(response.result.stopReason).toBe("end_turn");
    expect(requestedText).toBeUndefined();
    const exportPath = join(cwd, ".labkit", "exports", `${sessionId}.md`);
    expect(await readFile(exportPath, "utf8")).toContain(`# Session ${sessionId}`);
  } finally {
    await h.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("/export completion logs acp.prompt.export.completed with connectionId, sessionId and path", async () => {
  const directory = `.session-artifacts/acp-export/${crypto.randomUUID()}`;
  const cwd = await mkdtemp(join(tmpdir(), "labkit-acp-export-"));
  let exportPath = "";
  try {
    await withFixtureDiagnostics(directory, {}, async () => {
      const base = setup();
      const h = harness(base.options);
      try {
        await h.initialize();
        const opened = await h.request("session/new", { cwd, mcpServers: [] });
        const sessionId = opened.result.sessionId as string;
        exportPath = join(cwd, ".labkit", "exports", `${sessionId}.md`);
        const response = await h.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: "/export" }],
        });
        expect(response.result.stopReason).toBe("end_turn");
      } finally {
        await h.close();
      }
    });
    const records = (await Bun.file(`${directory}/diagnostics.jsonl`).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const completed = records.filter((record) => record.event === "acp.prompt.export.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      level: "info",
      method: "session/prompt",
      path: exportPath,
    });
    expect(completed[0].connectionId).toBeString();
    expect(completed[0].sessionId).toBeString();
    expect(records.filter((record) => record.level === "warning")).toEqual([]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("/export failure logs acp.prompt.export.failed with the cause and the client gets a clear error", async () => {
  const directory = `.session-artifacts/acp-export/${crypto.randomUUID()}`;
  const cwd = await mkdtemp(join(tmpdir(), "labkit-acp-export-"));
  try {
    // Make .labkit read-only so mkdir("<cwd>/.labkit/exports") fails and /export cannot write.
    await mkdir(join(cwd, ".labkit"));
    await chmod(join(cwd, ".labkit"), 0o500);
    await withFixtureDiagnostics(directory, {}, async () => {
      const base = setup();
      const h = harness(base.options);
      try {
        await h.initialize();
        const opened = await h.request("session/new", { cwd, mcpServers: [] });
        const sessionId = opened.result.sessionId as string;
        const response = await h.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: "/export" }],
        });
        expect(response.result).toBeUndefined();
        expect(response.error?.code).toBe(-32000);
        expect(response.error?.message).toContain("Session export failed");
      } finally {
        await h.close();
      }
    });
    const records = (await Bun.file(`${directory}/diagnostics.jsonl`).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const failed = records.filter((record) => record.event === "acp.prompt.export.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].level).toBe("error");
    expect(failed[0].connectionId).toBeString();
    expect(failed[0].sessionId).toBeString();
    expect(failed[0].error).toBeObject();
  } finally {
    await chmod(join(cwd, ".labkit"), 0o700);
    await rm(cwd, { recursive: true, force: true });
  }
});
