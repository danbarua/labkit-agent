import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@logtape/testing-bun/autoload";

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
      { content: { type: string; text: string } } | undefined;
    expect(chunk?.content).toEqual({
      type: "text",
      text: `Exported session history to \`${exportPath}\`.`,
    });

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
