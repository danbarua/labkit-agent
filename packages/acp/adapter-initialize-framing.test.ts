import { getLogger } from "@logtape/logtape";
import { expect, spyOn, test } from "@logtape/testing-bun/autoload";

import { until } from "../core/agent/test-support.ts";
import { answer, prompt } from "./testing/fixtures.ts";
import { harness, setup } from "./testing/harness.ts";

const consequence =
  "The SDK answers -32601 Method not found for requests and drops notifications; the client or host expects a method this agent does not implement";

/** Runs `scenario` against a fresh adapter and returns the ACP diagnostics it emitted. */
async function diagnostics(
  scenario: (h: ReturnType<typeof harness>) => Promise<void>,
  options = setup().options,
) {
  const emitted = spyOn(getLogger(["labkit", "acp"]), "emit");
  const h = harness(options);
  try {
    await scenario(h);
    return emitted.mock.calls.map((call) => call[0].properties);
  } finally {
    await h.close();
    emitted.mockRestore();
  }
}

test("an unknown request gets -32601 and one acp.method.unknown warning", async () => {
  const records = await diagnostics(async (h) => {
    await h.initialize();
    // providers/list is a v1 agent method in the SDK; this agent does not register it.
    for (const method of ["providers/list", "session/set_model", "labkit/frobnicate"])
      expect((await h.request(method, { sessionId: "s" })).error?.code).toBe(-32601);
  });
  const unknown = records.filter((record) => record.event === "acp.method.unknown");
  expect(unknown).toEqual([
    {
      event: "acp.method.unknown",
      connectionId: expect.any(String),
      method: "providers/list",
      kind: "request",
      rpcRequestId: "2",
      specMethod: true,
      consequence,
    },
    expect.objectContaining({ method: "session/set_model", rpcRequestId: "3", specMethod: false }),
    expect.objectContaining({ method: "labkit/frobnicate", rpcRequestId: "4", specMethod: false }),
  ]);
});

test("an unknown notification is logged and gets no response", async () => {
  const records = await diagnostics(async (h) => {
    await h.send({ jsonrpc: "2.0", method: "document/didOpen", params: {} });
    await h.initialize();
    expect(h.messages.map((message) => message.id)).toEqual([1]);
  });
  expect(records.filter((record) => record.event === "acp.method.unknown")).toEqual([
    {
      event: "acp.method.unknown",
      connectionId: expect.any(String),
      method: "document/didOpen",
      kind: "notification",
      specMethod: true,
      consequence,
    },
  ]);
});

test("a normal session flow logs no acp.method.unknown", async () => {
  const records = await diagnostics(async (h) => {
    await h.initialize();
    const sessionId = await h.newSession();
    expect((await h.request("session/prompt", prompt(sessionId))).result).toEqual({
      stopReason: "end_turn",
    });
    await h.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
    await h.send({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: 99 } });
    expect((await h.request("session/close", { sessionId })).result).toEqual({});
  });
  expect(records.map((record) => record.event)).toContain("acp.prompt.cancel.requested");
  expect(records.filter((record) => record.event === "acp.method.unknown")).toEqual([]);
});

test("an unadvertised conditional method logs acp.method.not_advertised, not unknown", async () => {
  const records = await diagnostics(
    async (h) => {
      await h.initialize();
      const response = await h.request("session/load", {
        sessionId: "saved",
        cwd: "/tmp",
        mcpServers: [],
      });
      expect(response.error?.code).toBe(-32601);
    },
    { ...setup().options, loadSession: false },
  );
  expect(records.filter((record) => record.event === "acp.method.not_advertised")).toEqual([
    expect.objectContaining({ method: "session/load" }),
  ]);
  expect(records.filter((record) => record.event === "acp.method.unknown")).toEqual([]);
});

test("JSON-RPC initialization, framing, validation and baseline text/resource-link prompts", async () => {
  const seen: string[] = [];
  const { options } = setup({
    complete: (request) => {
      seen.push(JSON.stringify(request));
      return answer;
    },
  });
  const h = harness(options);
  expect((await h.request("session/new", { cwd: "/tmp", mcpServers: [] })).error).toMatchObject({
    code: -32600,
    data: { reason: "not_initialized" },
  });
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
