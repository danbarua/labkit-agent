import { expect, test } from "@logtape/testing-bun/autoload";

import { until } from "../core/agent/test-support.ts";
import { answer, prompt } from "./testing/fixtures.ts";
import { harness, setup } from "./testing/harness.ts";

test("JSON-RPC initialization, framing, validation and baseline text/resource-link prompts", async () => {
  const seen: string[] = [];
  const { options } = setup({
    complete: (request) => {
      seen.push(JSON.stringify(request));
      return answer;
    },
  });
  const h = harness(options);
  expect((await h.request("session/new", { cwd: "/tmp", mcpServers: [] })).error?.code).toBe(
    -32002,
  );
  await h.raw("{broken\n");
  await until(() => h.messages.some((m) => m.error?.code === -32700));
  expect((await h.initialize()).result).toMatchObject({
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: false, embeddedContext: false, audio: false },
    },
  });
  expect((await h.initialize()).error?.code).toBe(-32600);
  expect((await h.request("unknown", {})).error?.code).toBe(-32601);
  expect((await h.request("session/new", { cwd: "relative", mcpServers: [] })).error?.code).toBe(
    -32602,
  );
  expect(
    (
      await h.request("session/new", {
        cwd: "/tmp",
        mcpServers: [{ name: "m", type: "http", url: "file:///invalid", headers: [] }],
      })
    ).error?.code,
  ).toBe(-32602);
  expect((await h.request("session/prompt", prompt("missing"))).error?.code).toBe(-32602);
  const id = await h.newSession();
  expect(
    (
      await h.request("session/prompt", {
        sessionId: id,
        prompt: [{ type: "image", data: "AA==", mimeType: "image/png" }],
      })
    ).error?.code,
  ).toBe(-32602);
  expect((await h.request("session/prompt", { sessionId: id, prompt: [] })).error?.code).toBe(
    -32602,
  );
  const result = await h.request("session/prompt", {
    sessionId: id,
    prompt: [
      { type: "text", text: "Read 🌍" },
      { type: "resource_link", name: "design", uri: "https://example.invalid/DESIGN.md" },
    ],
  });
  expect(result.result).toEqual({ stopReason: "end_turn" });
  expect(seen).toHaveLength(1);
  expect(seen[0]).toContain("https://example.invalid/DESIGN.md");
  expect(h.updates().map((m) => m.update)).toEqual([
    expect.objectContaining({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Done" },
    }),
  ]);
  await h.close();
});
