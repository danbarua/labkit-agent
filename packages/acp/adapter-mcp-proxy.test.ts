import { expect, test } from "@logtape/testing-bun/autoload";

import { until } from "../core/agent/test-support.ts";
import { answer, prompt, proxiedMcpPeer } from "./testing/fixtures.ts";
import { harness, setup } from "./testing/harness.ts";

for (const decision of ["allow_once", "reject_once", "invalid_args"] as const) {
  test(`MCP ${decision}: ACP permission gate, journaled results, reconnect and process cleanup`, async () => {
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { mcpToolName } = await import("./mcp.ts");
    const { SessionIdSchema } = await import("@labkit-agent/core/types");
    const cwd = await mkdtemp(join(tmpdir(), "labkit-acp-mcp-"));
    const log = join(cwd, "events");
    const mcpServers = [
      {
        name: "fixture",
        command: process.execPath,
        args: [new URL("./testing/mcp-server.ts", import.meta.url).pathname],
        env: [
          { name: "MCP_TEST_LOG", value: log },
          { name: "MCP_TEST_TOKEN", value: "MCP_PRIVATE_SENTINEL" },
        ],
      },
    ];
    const name = mcpToolName("fixture", "echo");
    let completions = 0;
    const { options, persistence } = setup({
      complete: (request) => {
        completions++;
        expect(request.tools?.some((tool) => tool.function.name === name)).toBe(true);
        return completions === 1
          ? {
              kind: "tools",
              text: "MCP echo",
              calls: [
                { id: "remote", name, args: { text: decision === "invalid_args" ? 42 : "hello" } },
              ],
            }
          : answer;
      },
    });
    const events = async () =>
      (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    let h = harness(options);
    try {
      await h.initialize();
      const opened = await h.request("session/new", { cwd, mcpServers });
      expect(opened.error).toBeUndefined();
      const sessionId = opened.result.sessionId;
      const turn = await h.start("session/prompt", prompt(sessionId));
      if (decision === "invalid_args") {
        expect((await h.response(turn)).error?.code).toBe(-32000);
        expect(h.messages.some((message) => message.method === "session/request_permission")).toBe(
          false,
        );
      } else {
        await until(() =>
          h.messages.some((message) => message.method === "session/request_permission"),
        );
        const permission = h.messages.find(
          (message) => message.method === "session/request_permission",
        )!;
        expect(permission.params.toolCall.kind).toBe("read");
        expect((await events()).some((event) => event.method === "tools/call")).toBe(false);
        const option = permission.params.options.find((option: any) => option.kind === decision);
        await h.send({
          jsonrpc: "2.0",
          id: permission.id,
          result: { outcome: { outcome: "selected", optionId: option.optionId } },
        });
        expect((await h.response(turn)).result.stopReason).toBe(
          decision === "allow_once" ? "end_turn" : "refusal",
        );
      }
      expect((await events()).filter((event) => event.method === "tools/call")).toHaveLength(
        decision === "allow_once" ? 1 : 0,
      );
      if (decision === "allow_once") {
        const completed = h
          .updates()
          .map(({ update }) => update)
          .find(
            (update) =>
              update.sessionUpdate === "tool_call_update" && update.status === "completed",
          );
        expect(completed).toMatchObject({
          content: [{ type: "content", content: { type: "text", text: "hello" } }],
        });
      }
      const loaded = await persistence.load(
        SessionIdSchema.parse(sessionId),
        new AbortController().signal,
      );
      expect(JSON.stringify(loaded)).not.toContain("MCP_PRIVATE_SENTINEL");
      await h.close();
      expect((await events()).at(-1).method).toBe("closed");
      h = harness(options);
      await h.initialize();
      expect(
        (await h.request("session/load", { cwd, sessionId, mcpServers })).error,
      ).toBeUndefined();
      expect((await events()).filter((event) => event.method === "tools/call")).toHaveLength(
        decision === "allow_once" ? 1 : 0,
      );
      if (decision === "allow_once") {
        expect(
          h
            .updates()
            .map(({ update }) => update)
            .find(
              (update) =>
                update.sessionUpdate === "tool_call_update" && update.status === "completed",
            ),
        ).toMatchObject({
          content: [{ type: "content", content: { type: "text", text: "hello" } }],
          _meta: { "labkit.dev/reconstructed": true },
        });
      }
      await h.close();
      expect((await events()).filter((event) => event.method === "closed")).toHaveLength(2);
    } finally {
      await h.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

test("MCP resources close when a session factory fails after discovery", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const cwd = await mkdtemp(join(tmpdir(), "labkit-acp-mcp-failure-"));
  const log = join(cwd, "events");
  const h = harness({
    sessionOptions: () => {
      throw new Error("Factory failed");
    },
  });
  try {
    await h.initialize();
    const result = await h.request("session/new", {
      cwd,
      mcpServers: [
        {
          name: "fixture",
          command: process.execPath,
          args: [new URL("./testing/mcp-server.ts", import.meta.url).pathname],
          env: [{ name: "MCP_TEST_LOG", value: log }],
        },
      ],
    });
    expect(result.error).toBeDefined();
    expect(
      (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .at(-1).method,
    ).toBe("closed");
  } finally {
    await h.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("disconnect while MCP initialization is pending stops the server before connection close resolves", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const cwd = await mkdtemp(join(tmpdir(), "labkit-acp-mcp-opening-"));
  const log = join(cwd, "events");
  let factories = 0;
  const base = setup();
  const h = harness({
    ...base.options,
    sessionOptions: (context) => {
      factories++;
      return base.options.sessionOptions(context);
    },
  });
  try {
    await h.initialize();
    await h.start("session/new", {
      cwd,
      mcpServers: [
        {
          name: "fixture",
          command: process.execPath,
          args: [new URL("./testing/mcp-server.ts", import.meta.url).pathname],
          env: [
            { name: "MCP_TEST_LOG", value: log },
            { name: "MCP_TEST_MODE", value: "hang" },
          ],
        },
      ],
    });
    let initialized = false;
    for (let i = 0; i < 100 && !initialized; i++) {
      try {
        initialized = (await readFile(log, "utf8")).includes("initialize");
      } catch {}
      if (!initialized) await Bun.sleep(2);
    }
    expect(initialized).toBe(true);
    await h.close();
    expect(factories).toBe(0);
    expect(
      (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .at(-1).method,
    ).toBe("closed");
  } finally {
    await h.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

for (const type of ["http", "sse"] as const) {
  test(`${type} MCP through ACP preserves permission gating and excludes headers from journals`, async () => {
    const { mcpHttpFixture } = await import("./testing/mcp-http.ts");
    const { mcpToolName } = await import("./mcp.ts");
    const { SessionIdSchema } = await import("@labkit-agent/core/types");
    const peer = mcpHttpFixture(type);
    const name = mcpToolName("remote", "echo");
    let completions = 0;
    const { options, persistence } = setup({
      complete: (request) => {
        expect(request.tools?.some((tool) => tool.function.name === name)).toBe(true);
        return ++completions === 1
          ? {
              kind: "tools",
              text: "Remote echo",
              calls: [{ id: "remote", name, args: { text: "hello" } }],
            }
          : answer;
      },
    });
    const h = harness(options);
    try {
      const initialized = await h.initialize();
      expect(initialized.result.agentCapabilities.mcpCapabilities).toEqual({
        http: true,
        sse: true,
        acp: true,
      });
      const opened = await h.request("session/new", {
        cwd: "/tmp",
        mcpServers: [{ type, name: "remote", url: peer.url, headers: peer.headers }],
      });
      expect(opened.error).toBeUndefined();
      const sessionId = opened.result.sessionId;
      const turn = await h.start("session/prompt", prompt(sessionId));
      await until(() =>
        h.messages.some((message) => message.method === "session/request_permission"),
      );
      const permission = h.messages.find(
        (message) => message.method === "session/request_permission",
      )!;
      expect(peer.events.some((event) => event.method === "tools/call")).toBe(false);
      const decision = type === "http" ? "allow_once" : "reject_once";
      const option = permission.params.options.find((option: any) => option.kind === decision);
      await h.send({
        jsonrpc: "2.0",
        id: permission.id,
        result: { outcome: { outcome: "selected", optionId: option.optionId } },
      });
      expect((await h.response(turn)).result.stopReason).toBe(
        type === "http" ? "end_turn" : "refusal",
      );
      expect(peer.events.filter((event) => event.method === "tools/call")).toHaveLength(
        type === "http" ? 1 : 0,
      );
      const journal = await persistence.load(
        SessionIdSchema.parse(sessionId),
        new AbortController().signal,
      );
      expect(JSON.stringify(journal)).not.toContain("mcp-test-secret");
      await h.close();
      if (type === "http") expect(peer.deleted).toBe(1);
      await until(() => peer.streams === 0);
    } finally {
      await h.close();
      await peer.close();
    }
  });
}

test("ACP-proxied MCP connects, gates calls with permissions, routes reverse requests, and disconnects", async () => {
  const { mcpToolName } = await import("./mcp.ts");
  let completions = 0;
  const base = setup({
    complete: (request) => {
      if (++completions === 1)
        return {
          kind: "tools",
          text: "Calling host tool",
          calls: [
            { id: "proxy-call", name: mcpToolName("host", "echo"), args: { text: "hello proxy" } },
          ],
        };
      expect(JSON.stringify(request)).toContain("proxy result");
      return answer;
    },
  });
  const h = harness(base.options);
  const peer = proxiedMcpPeer(h);
  try {
    expect((await h.initialize()).result.agentCapabilities.mcpCapabilities.acp).toBe(true);
    const id = await peer.open();
    expect(
      (await h.request("mcp/message", { connectionId: "missing", method: "roots/list" })).error
        ?.code,
    ).toBe(-32602);
    await h.send({
      jsonrpc: "2.0",
      method: "mcp/message",
      params: { connectionId: "missing", method: "notifications/tools/list_changed" },
    });
    expect(
      (await h.request("mcp/message", { connectionId: "mcp-connection-1", method: "roots/list" }))
        .result,
    ).toEqual({ roots: [{ uri: "file:///tmp", name: "Workspace" }] });
    expect(
      (
        await h.request("mcp/message", {
          connectionId: "mcp-connection-1",
          method: "sampling/createMessage",
          params: {},
        })
      ).error?.code,
    ).toBe(-32601);
    const turn = await h.start("session/prompt", prompt(id));
    const permission = await peer.next("session/request_permission");
    expect(
      h.messages.some((m) => m.method === "mcp/message" && m.params?.method === "tools/call"),
    ).toBe(false);
    await peer.reply(permission, { outcome: { outcome: "selected", optionId: "allow-once" } });
    const call = await peer.next("mcp/message", "tools/call");
    expect(call.params).toMatchObject({
      connectionId: "mcp-connection-1",
      params: { name: "echo", arguments: { text: "hello proxy" } },
    });
    await peer.reply(call, { content: [{ type: "text", text: "proxy result" }] });
    expect((await h.response(turn)).result.stopReason).toBe("end_turn");
    const { SessionIdSchema } = await import("@labkit-agent/core/types");
    const loaded = await base.persistence.load(
      SessionIdSchema.parse(id),
      new AbortController().signal,
    );
    expect(JSON.stringify(loaded)).toContain("proxy result");
    expect(JSON.stringify(loaded)).not.toContain("mcp-connection-1");
    await peer.close(id);
    expect(
      (await h.request("mcp/message", { connectionId: "mcp-connection-1", method: "roots/list" }))
        .error?.code,
    ).toBe(-32602);
  } finally {
    await h.close();
  }
});

test("ACP MCP refusal sends no call and cancellation targets the outer request, ignoring late replies", async () => {
  const { mcpToolName } = await import("./mcp.ts");
  const h = harness(
    setup({
      complete: () => ({
        kind: "tools",
        text: "Calling host tool",
        calls: [{ id: "call", name: mcpToolName("host", "echo"), args: { text: "hello" } }],
      }),
    }).options,
  );
  const peer = proxiedMcpPeer(h);
  try {
    await h.initialize();
    const id = await peer.open();
    let turn = await h.start("session/prompt", prompt(id));
    await peer.reply(await peer.next("session/request_permission"), {
      outcome: { outcome: "selected", optionId: "reject-once" },
    });
    expect((await h.response(turn)).result.stopReason).toBe("refusal");
    expect(
      h.messages.some((m) => m.method === "mcp/message" && m.params?.method === "tools/call"),
    ).toBe(false);
    turn = await h.start("session/prompt", prompt(id));
    await peer.reply(await peer.next("session/request_permission"), {
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
    const call = await peer.next("mcp/message", "tools/call");
    await h.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: id } });
    expect((await h.response(turn)).result.stopReason).toBe("cancelled");
    await until(() =>
      h.messages.some((m) => m.method === "$/cancel_request" && m.params?.requestId === call.id),
    );
    await peer.reply(call, { content: [{ type: "text", text: "late result" }] });
    expect(JSON.stringify(h.updates())).not.toContain("late result");
    await peer.close(id);
  } finally {
    await h.close();
  }
});

test("cancelled ACP MCP setup releases a late connection ID without publishing a session", async () => {
  const h = harness(setup().options);
  const peer = proxiedMcpPeer(h);
  try {
    await h.initialize();
    const open = await h.start("session/new", {
      cwd: "/tmp",
      mcpServers: [{ type: "acp", name: "host", serverId: "late" }],
    });
    const connect = await peer.next("mcp/connect");
    await h.send({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: open } });
    expect((await h.response(open)).error).toBeDefined();
    await peer.reply(connect, { connectionId: "late-connection" });
    const disconnect = await peer.next("mcp/disconnect");
    expect(disconnect.params.connectionId).toBe("late-connection");
    await peer.reply(disconnect, {});
    expect(h.messages.some((m) => m.method === "mcp/message")).toBe(false);
    expect(h.updates()).toEqual([]);
  } finally {
    await h.close();
  }
});

test("ACP MCP sessions have independent connections and reject a reused active connection ID", async () => {
  const h = harness(setup().options);
  const peer = proxiedMcpPeer(h);
  try {
    await h.initialize();
    const a = await peer.open("connection-a", "/workspace-a");
    const b = await peer.open("connection-b", "/workspace-b");
    const duplicate = await h.start("session/new", {
      cwd: "/tmp",
      mcpServers: [{ type: "acp", name: "host", serverId: "host-server" }],
    });
    await peer.reply(await peer.next("mcp/connect"), { connectionId: "connection-a" });
    expect((await h.response(duplicate)).error).toBeDefined();
    expect(h.messages.filter((m) => m.method === "mcp/disconnect")).toHaveLength(0);
    for (const [connectionId, cwd] of [
      ["connection-a", "/workspace-a"],
      ["connection-b", "/workspace-b"],
    ])
      expect(
        (await h.request("mcp/message", { connectionId, method: "roots/list" })).result.roots,
      ).toEqual([{ uri: `file://${cwd}`, name: "Workspace" }]);
    await peer.close(a, "connection-a");
    expect(
      (await h.request("mcp/message", { connectionId: "connection-b", method: "roots/list" }))
        .result.roots,
    ).toHaveLength(1);
    await peer.close(b, "connection-b");
  } finally {
    await h.close();
  }
});

test("ACP MCP errors fail the ordinary tool operation and failed catalog setup disconnects", async () => {
  const { mcpToolName } = await import("./mcp.ts");
  const h = harness(
    setup({
      complete: () => ({
        kind: "tools",
        text: "Call",
        calls: [{ id: "call", name: mcpToolName("host", "echo"), args: { text: "error" } }],
      }),
    }).options,
  );
  const peer = proxiedMcpPeer(h);
  try {
    await h.initialize();
    const id = await peer.open();
    const turn = await h.start("session/prompt", prompt(id));
    await peer.reply(await peer.next("session/request_permission"), {
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
    const call = await peer.next("mcp/message", "tools/call");
    await h.send({
      jsonrpc: "2.0",
      id: call.id,
      error: { code: -32001, message: "host tool failed" },
    });
    expect((await h.response(turn)).error).toBeDefined();
    expect(
      h
        .updates()
        .some((m) => m.update.sessionUpdate === "tool_call_update" && m.update.status === "failed"),
    ).toBe(true);
    await peer.close(id);
    const open = await h.start("session/new", {
      cwd: "/tmp",
      mcpServers: [{ type: "acp", name: "host", serverId: "host-server" }],
    });
    await peer.reply(await peer.next("mcp/connect"), { connectionId: "bad-catalog" });
    const initialize = await peer.next("mcp/message", "initialize");
    await peer.reply(initialize, {
      protocolVersion: initialize.params.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "host", version: "1" },
    });
    const list = await peer.next("mcp/message", "tools/list");
    await h.send({
      jsonrpc: "2.0",
      id: list.id,
      error: { code: -32000, message: "catalog unavailable" },
    });
    const disconnect = await peer.next("mcp/disconnect");
    expect(disconnect.params.connectionId).toBe("bad-catalog");
    await peer.reply(disconnect, {});
    expect((await h.response(open)).error).toBeDefined();
  } finally {
    await h.close();
  }
});
