import { defineTool } from "@labkit-agent/core";
import { getLogger } from "@logtape/logtape";
import { expect, spyOn, test } from "@logtape/testing-bun/autoload";
import { z } from "zod";

import { until } from "../core/agent/test-support.ts";
import { prompt, tools } from "./testing/fixtures.ts";
import { harness, setup } from "./testing/harness.ts";

test("ACP diagnostics correlate permission waits, turn outcomes and failed session restores", async () => {
  const emitted = spyOn(getLogger(["labkit", "acp"]), "emit");
  const { options } = setup({
    complete: () => tools,
    tools: new Map([
      [
        "echo",
        defineTool({
          input: z.object({ text: z.string() }),
          kind: "read",
          locations: () => [{ path: "/workspace/README.md" }],
          run: () => "not run",
        }),
      ],
    ]),
  });
  const h = harness(options);
  try {
    await h.initialize();
    const sessionId = await h.newSession();
    const requestId = await h.start("session/prompt", prompt(sessionId));
    await until(() =>
      h.messages.some((message) => message.method === "session/request_permission"),
    );
    const permission = h.messages.find(
      (message) => message.method === "session/request_permission",
    )!;
    const waiting = emitted.mock.calls
      .map((call) => call[0].properties)
      .find((record) => record.event === "acp.permission.waiting");
    expect(waiting).toMatchObject({
      sessionId,
      paths: ["/workspace/README.md"],
      rpcRequestId: String(requestId),
      toolCallId: expect.any(String),
      reason: "client_decision",
    });
    await h.send({
      jsonrpc: "2.0",
      id: permission.id,
      result: { outcome: { outcome: "selected", optionId: "reject-once" } },
    });
    expect((await h.response(requestId)).result.stopReason).toBe("refusal");
    const records = emitted.mock.calls.map((call) => call[0].properties);
    expect(records).toContainEqual(
      expect.objectContaining({
        event: "acp.prompt.received",
        sessionId,
        rpcRequestId: String(requestId),
        connectionId: waiting!.connectionId,
      }),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        event: "acp.permission.resolved",
        sessionId,
        durationMs: expect.any(Number),
        response: { outcome: { outcome: "selected", optionId: "reject-once" } },
      }),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        event: "acp.prompt.settled",
        sessionId,
        turnId: expect.any(String),
        outcome: "failed",
      }),
    );
    const missing = await h.request("session/load", {
      sessionId: "missing-session",
      cwd: "/tmp",
      mcpServers: [],
    });
    expect(missing.error).toBeDefined();
    expect(emitted.mock.calls.map((call) => call[0].properties)).toContainEqual(
      expect.objectContaining({
        event: "acp.session.open.failed",
        sessionId: "missing-session",
        error: expect.objectContaining({ message: expect.any(String) }),
        durationMs: expect.any(Number),
      }),
    );
    expect(JSON.stringify(records)).not.toContain('"text":"Go"');
  } finally {
    await h.close();
    emitted.mockRestore();
  }
});
