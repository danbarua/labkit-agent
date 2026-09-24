import type { AgentContext } from "@agentclientprotocol/sdk";
import { getLogger } from "@logtape/logtape";
import { expect, spyOn, test } from "@logtape/testing-bun/autoload";

import { clientTerminal } from "./client-terminal.ts";

test("terminal diagnostics link creation, wait, exit and release to the tool without output", async () => {
  const emitted = spyOn(getLogger(["labkit", "acp"]), "emit");
  try {
    const client = {
      request: async (method: string) => {
        if (method === "terminal/create") return { terminalId: "terminal-1" };
        if (method === "terminal/wait_for_exit") return { exitCode: 2 };
        if (method === "terminal/output") return { output: "PRIVATE_OUTPUT", truncated: false };
        return {};
      },
    } as unknown as AgentContext;
    const signal = new AbortController().signal;
    const result = await clientTerminal(client, () => "terminal-session", "/workspace", signal).run(
      "check",
      [],
      signal,
      { toolCallId: "tool-1" },
    );
    expect(result.exitCode).toBe(2);
    const records = emitted.mock.calls.map((call) => call[0].properties);
    for (const event of [
      "client_terminal.requested",
      "client_terminal.waiting_for_exit",
      "client_terminal.exited",
      "client_terminal.released",
    ])
      expect(records).toContainEqual(
        expect.objectContaining({ event, sessionId: "terminal-session", toolCallId: "tool-1" }),
      );
    expect(records).toContainEqual(
      expect.objectContaining({
        event: "client_terminal.exited",
        exitCode: 2,
        terminalId: "terminal-1",
        bytes: 14,
      }),
    );
    expect(JSON.stringify(records)).not.toContain("PRIVATE_OUTPUT");
  } finally {
    emitted.mockRestore();
  }
});

test("terminal cleanup records kill failure and still releases after execution failure", async () => {
  const emitted = spyOn(getLogger(["labkit", "acp"]), "emit");
  try {
    const client = {
      request: async (method: string) => {
        if (method === "terminal/create") return { terminalId: "terminal-failed" };
        if (method === "terminal/wait_for_exit")
          throw new Error("Client terminal disconnected while waiting for exit");
        if (method === "terminal/kill") throw new Error("Process is already dead");
        return {};
      },
    } as unknown as AgentContext;
    const signal = new AbortController().signal;
    await expect(
      clientTerminal(client, () => "terminal-session", "/workspace", signal).run(
        "check",
        [],
        signal,
        { toolCallId: "tool-failed" },
      ),
    ).rejects.toThrow("disconnected");
    const records = emitted.mock.calls.map((call) => call[0].properties);
    expect(records).toContainEqual(
      expect.objectContaining({
        event: "client_terminal.failed",
        terminalId: "terminal-failed",
        toolCallId: "tool-failed",
        error: expect.objectContaining({ message: expect.stringContaining("disconnected") }),
      }),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        event: "client_terminal.kill_failed",
        error: expect.objectContaining({ message: "Process is already dead" }),
      }),
    );
    expect(records).toContainEqual(
      expect.objectContaining({ event: "client_terminal.released", terminalId: "terminal-failed" }),
    );
  } finally {
    emitted.mockRestore();
  }
});
