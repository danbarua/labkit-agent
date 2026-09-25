/** End-to-end proof for advertised `mcpCapabilities` and baseline stdio MCP through real handlers. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { McpServer, SessionNotification } from "@agentclientprotocol/sdk";
import type { CompletionPortRequest } from "@labkit-agent/core";
import { withConfig, type LogRecord } from "@logtape/logtape";
import { expect, test } from "@logtape/testing-bun/autoload";

import type { AcpOptions } from "./adapter.ts";
import { mcpToolName } from "./mcp.ts";
import { harness, setup, type Message } from "./testing/harness.ts";
import { mcpHttpFixture } from "./testing/mcp-http.ts";

type Transport = "stdio" | "http" | "sse" | "acp";
/** The client side of an in-process harness connection. */
type Client = { messages: Message[]; send: (value: unknown) => Promise<void> };
type ToolFailure = "fail-turn" | "return-error-and-continue";

const transports = ["stdio", "http", "sse", "acp"] as const;
const stdioFixture = new URL("./testing/mcp-server.ts", import.meta.url).pathname;
const echo = mcpToolName("fixture", "echo");

/**
 * Client end of the unstable MCP-over-ACP transport: answers the adapter's `mcp/connect`,
 * `mcp/message` and `mcp/disconnect` requests as an editor-hosted MCP server would.
 */
function acpMcpHost(options: { refuse?: boolean } = {}) {
  const counts = { connect: 0, initialize: 0, call: 0, disconnect: 0 };
  const reply = (h: Client, message: Message, result: unknown) =>
    h.send({ jsonrpc: "2.0", id: message.id, result });
  const fail = (h: Client, message: Message, code: number, text: string) =>
    h.send({ jsonrpc: "2.0", id: message.id, error: { code, message: text } });
  function serve(h: Client, message: Message) {
    if (message.method === "mcp/connect") {
      counts.connect++;
      return options.refuse
        ? fail(h, message, -32001, "host refused MCP server host-fixture: server is not running")
        : reply(h, message, { connectionId: `host-connection-${counts.connect}` });
    }
    if (message.method === "mcp/disconnect") {
      counts.disconnect++;
      return reply(h, message, {});
    }
    const inner = message.params.method as string;
    const params = message.params.params;
    if (inner === "initialize") {
      counts.initialize++;
      return reply(h, message, {
        protocolVersion: params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "host", version: "1" },
      });
    }
    if (inner === "tools/list")
      return reply(h, message, {
        tools: [
          {
            name: "echo",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
        ],
      });
    if (inner === "tools/call") {
      counts.call++;
      const text = params.arguments.text as string;
      if (text === "drop") return fail(h, message, -32603, "host MCP server crashed");
      if (text === "error")
        return reply(h, message, {
          isError: true,
          content: [{ type: "text", text: "fixture tool error" }],
        });
      if (text === "binary")
        return reply(h, message, {
          content: [{ type: "image", mimeType: "image/png", data: "AA==" }],
        });
      return reply(h, message, { content: [{ type: "text", text }] });
    }
    return fail(h, message, -32601, `Method not found: ${inner}`);
  }
  return {
    counts,
    /**
     * Serve one adapter connection until the returned stop function runs. The harness records every
     * frame the adapter writes in `messages`; answering from that push keeps the host event-driven.
     */
    attach(h: Client) {
      let active = true;
      const record = h.messages.push.bind(h.messages);
      h.messages.push = (...frames: Message[]) => {
        const length = record(...frames);
        for (const message of frames)
          if (active && message.id !== undefined && message.method?.startsWith("mcp/"))
            void serve(h, message);
        return length;
      };
      return () => {
        active = false;
      };
    },
  };
}

/** One live MCP server per transport, all named `fixture` and exposing an `echo` tool. */
async function mcpServer(transport: Transport) {
  if (transport === "stdio") {
    const directory = await mkdtemp(join(tmpdir(), "labkit-mcp-caps-"));
    const log = join(directory, "events");
    const events = async (): Promise<{ method: string }[]> => {
      try {
        return (await readFile(log, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    };
    return {
      spec: {
        name: "fixture",
        command: process.execPath,
        args: [stdioFixture],
        env: [{ name: "MCP_TEST_LOG", value: log }],
      } satisfies McpServer,
      attach: (_h: Client) => () => {},
      initializations: async () => (await events()).filter((e) => e.method === "initialize").length,
      calls: async () => (await events()).filter((e) => e.method === "tools/call").length,
      close: () => rm(directory, { recursive: true, force: true }),
    };
  }
  if (transport === "acp") {
    const host = acpMcpHost();
    return {
      spec: { type: "acp", name: "fixture", serverId: "host-fixture" } satisfies McpServer,
      attach: (h: Client) => host.attach(h),
      initializations: async () => host.counts.initialize,
      calls: async () => host.counts.call,
      close: async () => {},
    };
  }
  const peer = mcpHttpFixture(transport);
  return {
    spec: { type: transport, name: "fixture", url: peer.url, headers: peer.headers },
    attach: (_h: Client) => () => {},
    initializations: async () => peer.events.filter((e) => e.method === "initialize").length,
    calls: async () => peer.events.filter((e) => e.method === "tools/call").length,
    close: () => peer.close(),
  };
}

/**
 * Scripted model: a user prompt `answer` gets a plain answer; any other prompt text becomes one
 * MCP `echo` call with that text; a tool result gets the answer "Done".
 */
function scripted(toolFailure: ToolFailure) {
  const requests: CompletionPortRequest[] = [];
  const base = setup({
    complete: (request) => {
      requests.push(request);
      const last = request.messages.at(-1);
      if (last?.role !== "user" || last.content === "answer")
        return { kind: "answer", text: "Done" };
      return {
        kind: "tools",
        text: "Calling MCP",
        calls: [{ id: `call-${requests.length}`, name: echo, args: { text: last.content } }],
      };
    },
  });
  const options: AcpOptions = {
    ...base.options,
    sessionOptions: async (context) => {
      const original = await base.options.sessionOptions(context);
      return {
        ...original,
        configuration: { ...original.configuration, policy: { permissions: "off", toolFailure } },
      };
    },
  };
  return { options, requests };
}

const say = (sessionId: string, text: string) => ({
  sessionId,
  prompt: [{ type: "text", text }],
});

function toolUpdates(h: { updates: () => SessionNotification[] }, toolCallId: string) {
  return h
    .updates()
    .map(({ update }) => update)
    .filter(
      (update) =>
        (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") &&
        update.toolCallId.endsWith(`/${toolCallId}`),
    );
}

async function recording<T>(callback: (records: LogRecord[]) => Promise<T>) {
  const records: LogRecord[] = [];
  return withConfig(
    {
      sinks: { memory: (record) => void records.push(record) },
      loggers: [{ category: ["labkit", "acp"], lowestLevel: "debug", sinks: ["memory"] }],
    },
    () => callback(records),
  );
}

const events = (records: LogRecord[], event: string) =>
  records.filter((record) => record.properties.event === event).map((record) => record.properties);

for (const transport of transports) {
  const reopen = transport === "stdio" || transport === "http" ? "session/load" : "session/resume";

  test(`MCP ${transport}: session/new exposes the server's tools, a call's result reaches the client and the next step, and ${reopen} reconnects`, async () => {
    const server = await mcpServer(transport);
    const { options, requests } = scripted("return-error-and-continue");
    let h = harness(options);
    let detach = server.attach(h);
    try {
      const initialized = await h.initialize();
      if (transport !== "stdio")
        expect(initialized.result.agentCapabilities.mcpCapabilities[transport]).toBe(true);
      const opened = await h.request("session/new", { cwd: "/tmp", mcpServers: [server.spec] });
      expect(opened.error).toBeUndefined();
      const sessionId = opened.result.sessionId as string;

      const turn = await h.request("session/prompt", say(sessionId, `hello ${transport}`));
      expect(turn.result.stopReason).toBe("end_turn");
      // The completion request advertised the discovered MCP tool under its namespaced name.
      expect(requests[0]!.tools?.map((tool) => tool.function.name)).toContain(echo);
      expect(await server.calls()).toBe(1);
      const updates = toolUpdates(h, "call-1");
      expect(updates[0]).toMatchObject({ sessionUpdate: "tool_call", status: "pending" });
      expect(updates.at(-1)).toMatchObject({
        sessionUpdate: "tool_call_update",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: `hello ${transport}` } }],
      });
      // The step after the call carries the MCP result as the call's tool message.
      expect(requests[1]!.messages.at(-1)).toMatchObject({
        role: "tool",
        tool_call_id: "call-1",
        content: expect.stringContaining(`"text":"hello ${transport}"`),
      });

      detach();
      await h.close();
      h = harness(options);
      detach = server.attach(h);
      await h.initialize();
      const reopened = await h.request(reopen, {
        sessionId,
        cwd: "/tmp",
        mcpServers: [server.spec],
      });
      expect(reopened.error).toBeUndefined();
      expect(await server.initializations()).toBe(2);
      const again = await h.request("session/prompt", say(sessionId, `again ${transport}`));
      expect(again.result.stopReason).toBe("end_turn");
      expect(await server.calls()).toBe(2);
      expect(requests.at(-2)!.tools?.map((tool) => tool.function.name)).toContain(echo);
      expect(toolUpdates(h, "call-3").at(-1)).toMatchObject({
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: `again ${transport}` } }],
      });
    } finally {
      detach();
      await h.close();
      await server.close();
    }
  });

  test(`MCP ${transport}: isError and a mid-call transport failure become failed tool results the model reads; the turn ends normally`, () =>
    // The harness is created inside the capture so the connection's diagnostics reach it.
    recording(async (records) => {
      const server = await mcpServer(transport);
      const { options, requests } = scripted("return-error-and-continue");
      const h = harness(options);
      const detach = server.attach(h);
      try {
        await h.initialize();
        const sessionId = (
          await h.request("session/new", { cwd: "/tmp", mcpServers: [server.spec] })
        ).result.sessionId as string;

        const failed = await h.request("session/prompt", say(sessionId, "error"));
        expect(failed.result.stopReason).toBe("end_turn");
        expect(toolUpdates(h, "call-1").at(-1)).toMatchObject({ status: "failed" });
        expect(requests[1]!.messages.at(-1)).toMatchObject({
          role: "tool",
          tool_call_id: "call-1",
          content: expect.stringContaining("MCP tool failed: fixture tool error"),
        });

        const dropped = await h.request("session/prompt", say(sessionId, "drop"));
        expect(dropped.result.stopReason).toBe("end_turn");
        expect(toolUpdates(h, "call-3").at(-1)).toMatchObject({ status: "failed" });
        const cause = {
          stdio: "MCP error -32000: Connection closed",
          http: "Error POSTing to endpoint: fixture upstream crashed",
          sse: "fixture upstream crashed",
          acp: "host MCP server crashed",
        }[transport];
        expect(requests[3]!.messages.at(-1)).toMatchObject({
          role: "tool",
          tool_call_id: "call-3",
          content: expect.stringContaining(cause),
        });
        expect(events(records, "mcp.call.failed")).toContainEqual(
          expect.objectContaining({
            sessionId,
            serverName: "fixture",
            toolName: echo,
            toolCallId: expect.stringMatching(/\/call-3$/),
            outcome: "failed",
            error: expect.objectContaining({ message: expect.stringContaining(cause) }),
          }),
        );
        expect(h.server.connection.signal.aborted).toBe(false);
      } finally {
        detach();
        await h.close();
        await server.close();
      }
    }));

  test(`MCP ${transport}: under fail-turn an MCP tool error or transport failure fails session/prompt with tool name and callId, and the connection keeps serving prompts`, async () => {
    const server = await mcpServer(transport);
    const { options } = scripted("fail-turn");
    const h = harness(options);
    const detach = server.attach(h);
    try {
      await h.initialize();
      const sessionId = (await h.request("session/new", { cwd: "/tmp", mcpServers: [server.spec] }))
        .result.sessionId as string;
      const failed = await h.request("session/prompt", say(sessionId, "error"));
      expect(failed.error).toMatchObject({
        code: -32000,
        message: expect.stringContaining("Agent turn failed"),
        data: {
          message: expect.stringContaining("fixture tool error"),
          operation: { kind: "tool", toolName: echo, callId: "call-1" },
        },
      });
      expect(toolUpdates(h, "call-1").at(-1)).toMatchObject({ status: "failed" });
      expect(h.server.connection.signal.aborted).toBe(false);
      expect((await h.request("session/prompt", say(sessionId, "answer"))).result.stopReason).toBe(
        "end_turn",
      );
      const dropped = await h.request("session/prompt", say(sessionId, "drop"));
      expect(dropped.error?.code).toBe(-32000);
      expect(dropped.error?.data).toMatchObject({
        classification: "execution",
        operation: { kind: "tool", toolName: echo, callId: "call-3" },
      });
      expect(toolUpdates(h, "call-3").at(-1)).toMatchObject({ status: "failed" });
      expect((await h.request("session/prompt", say(sessionId, "answer"))).result.stopReason).toBe(
        "end_turn",
      );
    } finally {
      detach();
      await h.close();
      await server.close();
    }
  });
}

/** Unreachable or refusing servers per transport, with the cause text the client must see. */
async function unreachable(transport: Transport) {
  if (transport === "stdio")
    return {
      spec: {
        name: "fixture",
        command: process.execPath,
        args: ["-e", "process.exit(3)"],
        env: [],
      } satisfies McpServer,
      cause: "MCP error -32000: Connection closed",
      host: undefined,
    };
  if (transport === "acp") {
    const host = acpMcpHost({ refuse: true });
    return {
      spec: { type: "acp", name: "fixture", serverId: "host-fixture" } satisfies McpServer,
      cause: "host refused MCP server host-fixture: server is not running",
      host,
    };
  }
  // Bind then stop a local listener so the port is known to refuse connections.
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = listener.port;
  await listener.stop(true);
  return {
    spec: {
      type: transport,
      name: "fixture",
      url: `http://127.0.0.1:${port}/${transport === "sse" ? "sse" : "mcp"}`,
      headers: [],
    } satisfies McpServer,
    // Bun's fetch reports a refused connection this way; the SSE transport prefixes its own label.
    cause: `${transport === "sse" ? "SSE error: " : ""}Unable to connect`,
    host: undefined,
  };
}

for (const transport of transports) {
  test(`MCP ${transport}: session/new refuses a server it cannot open with invalid_params naming the server and cause`, () =>
    recording(async (records) => {
      const target = await unreachable(transport);
      let factories = 0;
      const base = scripted("return-error-and-continue");
      const h = harness({
        ...base.options,
        sessionOptions: (context) => {
          factories++;
          return base.options.sessionOptions(context);
        },
      });
      const detach = target.host?.attach(h) ?? (() => {});
      try {
        await h.initialize();
        const opened = await h.request("session/new", { cwd: "/tmp", mcpServers: [target.spec] });
        expect(opened.result).toBeUndefined();
        expect(opened.error?.code).toBe(-32602);
        expect(opened.error?.data).toEqual({ serverName: "fixture", stage: "connect" });
        expect(opened.error?.message).toStartWith(
          `Invalid params: Failed to connect to MCP server "fixture": ${target.cause}`,
        );
        expect(opened.error?.message).toContain("Check that the server is running");
        // The session is never created without the server's tools.
        expect(factories).toBe(0);
        expect(h.updates()).toEqual([]);
        expect(events(records, "mcp.open.failed")).toContainEqual(
          expect.objectContaining({
            serverName: "fixture",
            stage: "connect",
            error: expect.objectContaining({ message: expect.any(String) }),
          }),
        );
        expect(events(records, "acp.session.open.failed")).toContainEqual(
          expect.objectContaining({
            connectionId: expect.any(String),
            rpcRequestId: String(opened.id),
            method: "session/new",
            outcome: "failed",
            error: expect.objectContaining({
              message: expect.stringContaining(`MCP server "fixture"`),
            }),
          }),
        );
        if (target.host) expect(target.host.counts.connect).toBe(1);
        expect(h.server.connection.signal.aborted).toBe(false);
        expect((await h.request("session/new", { cwd: "/tmp", mcpServers: [] })).error).toBe(
          undefined,
        );
      } finally {
        detach();
        await h.close();
      }
    }));
}

test("session/new refuses an MCP server whose tool catalog cannot be loaded, naming the catalog stage", async () => {
  const { options } = scripted("return-error-and-continue");
  const h = harness(options);
  try {
    await h.initialize();
    const opened = await h.request("session/new", {
      cwd: "/tmp",
      mcpServers: [
        {
          name: "fixture",
          command: process.execPath,
          args: [stdioFixture],
          env: [{ name: "MCP_TEST_MODE", value: "repeat" }],
        },
      ],
    });
    expect(opened.error?.code).toBe(-32602);
    expect(opened.error?.data).toEqual({ serverName: "fixture", stage: "catalog" });
    expect(opened.error?.message).toStartWith(
      `Invalid params: Failed to load tools from MCP server "fixture": MCP tool catalog repeated a cursor.`,
    );
  } finally {
    await h.close();
  }
});

test("MCP binary tool results are refused as a failed tool result the model reads, not dropped", async () => {
  const server = await mcpServer("stdio");
  const { options, requests } = scripted("return-error-and-continue");
  const h = harness(options);
  try {
    await h.initialize();
    const sessionId = (await h.request("session/new", { cwd: "/tmp", mcpServers: [server.spec] }))
      .result.sessionId as string;
    expect((await h.request("session/prompt", say(sessionId, "binary"))).result.stopReason).toBe(
      "end_turn",
    );
    expect(toolUpdates(h, "call-1").at(-1)).toMatchObject({ status: "failed" });
    expect(requests[1]!.messages.at(-1)).toMatchObject({
      role: "tool",
      tool_call_id: "call-1",
      content: expect.stringContaining("Binary MCP tool results are not supported"),
    });
  } finally {
    await h.close();
    await server.close();
  }
});
