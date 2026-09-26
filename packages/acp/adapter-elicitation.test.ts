import { defineTool } from "@labkit-agent/core";
import { expect, test } from "@logtape/testing-bun/autoload";
import { z } from "zod";

import { deferred, until } from "../core/agent/test-support.ts";
import { answer, prompt, proxiedMcpPeer, tools } from "./testing/fixtures.ts";
import { harness, setup } from "./testing/harness.ts";
import type { Message as HarnessMessage } from "./testing/harness.ts";

type Message = HarnessMessage;
for (const action of ["accept", "decline", "cancel", "invalid"] as const) {
  test(`ACP MCP form elicitation handles ${action} and keeps the existing tool operation`, async () => {
    const { mcpToolName } = await import("./mcp.ts");
    const h = harness(
      setup({
        complete: () => ({
          kind: "tools",
          text: "Call",
          calls: [{ id: "call", name: mcpToolName("host", "echo"), args: { text: "ask" } }],
        }),
      }).options,
    );
    const peer = proxiedMcpPeer(h);
    try {
      await h.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { elicitation: { form: {} } },
      });
      const id = await peer.open();
      const initialize = h.messages.find(
        (m) => m.method === "mcp/message" && m.params?.method === "initialize",
      )!;
      expect(initialize.params.params.capabilities.elicitation).toEqual({ form: {} });
      const turn = await h.start("session/prompt", prompt(id));
      await peer.reply(await peer.next("session/request_permission"), {
        outcome: { outcome: "selected", optionId: "allow-once" },
      });
      await peer.next("mcp/message", "tools/call");
      const elicitation = await h.start("mcp/message", {
        connectionId: "mcp-connection-1",
        method: "elicitation/create",
        params: {
          message: "Pick a strategy",
          requestedSchema: {
            type: "object",
            properties: { strategy: { type: "string", enum: ["small", "large"] } },
            required: ["strategy"],
          },
        },
      });
      const form = await peer.next("elicitation/create");
      expect(form.params).toMatchObject({
        sessionId: id,
        mode: "form",
        message: "Pick a strategy",
      });
      expect(form.params.toolCallId).toBeUndefined(); // MCP provides no reliable originating tool ID.
      await peer.reply(form, {
        action: action === "invalid" ? "accept" : action,
        content: { strategy: action === "invalid" ? "unknown" : "small" },
      });
      const result = await h.response(elicitation);
      if (action === "invalid") expect(result.error).toBeDefined();
      else
        expect(result.result).toEqual(
          action === "accept" ? { action, content: { strategy: "small" } } : { action },
        );
      await h.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: id } });
      expect((await h.response(turn)).result.stopReason).toBe("cancelled");
      await peer.close(id);
    } finally {
      await h.close();
    }
  });
}

test("ACP MCP URL elicitation uses a private ID and signals completion only after the server finishes", async () => {
  const { mcpToolName } = await import("./mcp.ts");
  const h = harness(
    setup({
      complete: () => ({
        kind: "tools",
        text: "Call",
        calls: [{ id: "call", name: mcpToolName("host", "echo"), args: { text: "url" } }],
      }),
    }).options,
  );
  const peer = proxiedMcpPeer(h);
  try {
    await h.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { elicitation: { url: {} } },
    });
    const id = await peer.open();
    const turn = await h.start("session/prompt", prompt(id));
    await peer.reply(await peer.next("session/request_permission"), {
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
    await peer.next("mcp/message", "tools/call");
    const ask = () =>
      h.start("mcp/message", {
        connectionId: "mcp-connection-1",
        method: "elicitation/create",
        params: {
          mode: "url",
          elicitationId: "remote-id",
          message: "Open external setup",
          url: "https://example.invalid/setup",
        },
      });
    const request = await ask();
    const url = await peer.next("elicitation/create");
    expect(url.params.elicitationId).not.toBe("remote-id");
    expect(url.params.url).toBe("https://example.invalid/setup");
    await peer.reply(url, { action: "accept", content: { token: "MUST_NOT_FORWARD" } });
    expect((await h.response(request)).result).toEqual({ action: "accept" });
    expect((await h.response(await ask())).error).toBeDefined();
    expect(h.messages.some((m) => m.method === "elicitation/complete")).toBe(false);
    const complete = {
      jsonrpc: "2.0",
      method: "mcp/message",
      params: {
        connectionId: "mcp-connection-1",
        method: "notifications/elicitation/complete",
        params: { elicitationId: "remote-id" },
      },
    };
    await h.send(complete);
    await until(() => h.messages.some((m) => m.method === "elicitation/complete"));
    expect(h.messages.find((m) => m.method === "elicitation/complete")!.params).toEqual({
      elicitationId: url.params.elicitationId,
    });
    await h.send(complete);
    await h.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: id } });
    expect((await h.response(turn)).result.stopReason).toBe("cancelled");
    expect(h.messages.filter((m) => m.method === "elicitation/complete")).toHaveLength(1);
    await peer.close(id);
  } finally {
    await h.close();
  }
});

test("local tools can elicit a validated form tied to their tool card and journal only their result", async () => {
  const base = setup();
  let completes = 0;
  const h = harness({
    ...base.options,
    sessionOptions: async (context) => {
      const options = await base.options.sessionOptions(context);
      return {
        ...options,
        bindings: {
          ...options.bindings,
          complete: (request) => {
            if (++completes === 1) return tools;
            expect(JSON.stringify(request)).toContain("chosen");
            return answer;
          },
          tools: new Map([
            [
              "echo",
              defineTool({
                input: z.object({ text: z.string() }),
                kind: "other",
                run: async (_input, signal, operation) =>
                  context.elicitation!.form!(
                    {
                      message: "Choose an approach",
                      requestedSchema: {
                        properties: { approach: { type: "string", enum: ["chosen"] } },
                        required: ["approach"],
                      },
                    },
                    signal,
                    operation,
                  ),
              }),
            ],
          ]),
        },
      };
    },
  });
  const peer = proxiedMcpPeer(h);
  try {
    await h.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { elicitation: { form: {} } },
    });
    const id = await h.newSession();
    const turn = await h.start("session/prompt", prompt(id));
    const permission = await peer.next("session/request_permission");
    await peer.reply(permission, { outcome: { outcome: "selected", optionId: "allow-once" } });
    const form = await peer.next("elicitation/create");
    expect(form.params.toolCallId).toBe(permission.params.toolCall.toolCallId);
    await peer.reply(form, { action: "accept", content: { approach: "chosen" } });
    expect((await h.response(turn)).result.stopReason).toBe("end_turn");
    const { SessionIdSchema } = await import("@labkit-agent/core/types");
    const journal = await base.persistence.load(
      SessionIdSchema.parse(id),
      new AbortController().signal,
    );
    expect(JSON.stringify(journal)).toContain("chosen");
    expect(JSON.stringify(journal)).not.toContain("Choose an approach");
  } finally {
    await h.close();
  }
});

test("cancelling a tool prompt cancels ACP elicitation and discards a late form response", async () => {
  const { mcpToolName } = await import("./mcp.ts");
  const h = harness(
    setup({
      complete: () => ({
        kind: "tools",
        text: "Call",
        calls: [{ id: "call", name: mcpToolName("host", "echo"), args: { text: "ask" } }],
      }),
    }).options,
  );
  const peer = proxiedMcpPeer(h);
  try {
    await h.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { elicitation: { form: {} } },
    });
    const id = await peer.open();
    const params = {
      connectionId: "mcp-connection-1",
      method: "elicitation/create",
      params: {
        message: "Input",
        requestedSchema: { type: "object", properties: { value: { type: "string" } } },
      },
    };
    expect((await h.request("mcp/message", params)).error).toBeDefined();
    expect(h.messages.some((m) => m.method === "elicitation/create")).toBe(false);
    const turn = await h.start("session/prompt", prompt(id));
    await peer.reply(await peer.next("session/request_permission"), {
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
    await peer.next("mcp/message", "tools/call");
    const ask = await h.start("mcp/message", params);
    const form = await peer.next("elicitation/create");
    await h.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: id } });
    expect((await h.response(turn)).result.stopReason).toBe("cancelled");
    expect((await h.response(ask)).error).toBeDefined();
    expect(
      h.messages.some((m) => m.method === "$/cancel_request" && m.params?.requestId === form.id),
    ).toBe(true);
    await peer.reply(form, { action: "accept", content: { value: "LATE_FORM_RESPONSE" } });
    expect(JSON.stringify(h.updates())).not.toContain("LATE_FORM_RESPONSE");
    await peer.close(id);
  } finally {
    await h.close();
  }
});

test("authentication URL elicitation is request-scoped and waits for verified external completion", async () => {
  const external = deferred<void>();
  let authenticated = false;
  let credentials: string | undefined;
  const base = setup();
  const h = harness({
    ...base.options,
    auth: {
      methods: [{ id: "browser", name: "Browser login" }],
      isAuthenticated: () => authenticated,
      authenticate: async (_method, signal, context) => {
        if (!context.elicitation.url) throw new Error("URL login requires host URL support");
        const interaction = await context.elicitation.url(
          { message: "Sign in with your browser", url: "https://login.example.invalid/start" },
          signal,
        );
        if (interaction.action !== "accept") return;
        await external.promise; // Application verifies the same user's external workflow.
        signal.throwIfAborted();
        credentials = "AUTH_TOKEN_SENTINEL";
        authenticated = true;
        await interaction.complete();
        await interaction.complete();
      },
    },
  });
  const peer = proxiedMcpPeer(h);
  try {
    await h.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { elicitation: { url: {} } },
    });
    const login = await h.start("authenticate", { methodId: "browser" });
    const url = await peer.next("elicitation/create");
    expect(url.params).toMatchObject({
      requestId: login,
      mode: "url",
      url: "https://login.example.invalid/start",
    });
    expect(url.params.sessionId).toBeUndefined();
    expect(url.params.toolCallId).toBeUndefined();
    await peer.reply(url, { action: "accept" });
    expect(authenticated).toBe(false);
    expect(h.messages.some((m) => m.id === login && !m.method)).toBe(false);
    expect((await h.request("session/new", { cwd: "/tmp", mcpServers: [] })).error?.code).toBe(
      -32000,
    );
    external.resolve();
    expect((await h.response(login)).result).toEqual({});
    expect(credentials).toBe("AUTH_TOKEN_SENTINEL");
    expect(h.messages.filter((m) => m.method === "elicitation/complete")).toHaveLength(1);
    expect(h.messages.find((m) => m.method === "elicitation/complete")!.params).toEqual({
      elicitationId: url.params.elicitationId,
    });
    const id = await h.newSession();
    const { SessionIdSchema } = await import("@labkit-agent/core/types");
    const journal = await base.persistence.load(
      SessionIdSchema.parse(id),
      new AbortController().signal,
    );
    expect(JSON.stringify(journal)).not.toContain("AUTH_TOKEN_SENTINEL");
    expect(JSON.stringify(h.messages)).not.toContain("AUTH_TOKEN_SENTINEL");
  } finally {
    external.resolve();
    await h.close();
  }
});

for (const action of ["decline", "cancel"] as const) {
  test(`authentication URL ${action} cannot create sessions or emit completion`, async () => {
    const h = harness({
      ...setup().options,
      auth: {
        methods: [{ id: "browser", name: "Login" }],
        isAuthenticated: () => false,
        authenticate: async (_id, signal, context) => {
          const result = await context.elicitation.url!(
            { message: "Sign in", url: "https://example.invalid/login" },
            signal,
          );
          expect(result.action).toBe(action);
          await result.complete();
        },
      },
    });
    const peer = proxiedMcpPeer(h);
    try {
      await h.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { elicitation: { url: {} } },
      });
      const login = await h.start("authenticate", { methodId: "browser" });
      await peer.reply(await peer.next("elicitation/create"), { action });
      expect((await h.response(login)).error?.code).toBe(-32000);
      expect((await h.request("session/new", { cwd: "/tmp", mcpServers: [] })).error?.code).toBe(
        -32000,
      );
      expect(h.messages.some((m) => m.method === "elicitation/complete")).toBe(false);
    } finally {
      await h.close();
    }
  });
}

test("cancelled request-scoped login suppresses late external completion", async () => {
  let authenticated = false;
  let finished = false;
  const external = deferred<void>();
  const h = harness({
    ...setup().options,
    auth: {
      methods: [{ id: "browser", name: "Login" }],
      isAuthenticated: () => authenticated,
      authenticate: async (_id, signal, context) => {
        const result = await context.elicitation.url!(
          { message: "Sign in", url: "https://example.invalid/login" },
          signal,
        );
        await external.promise; // Deliberately uncooperative host callback.
        authenticated = true;
        await result.complete();
        finished = true;
      },
    },
  });
  const peer = proxiedMcpPeer(h);
  try {
    await h.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { elicitation: { url: {} } },
    });
    const login = await h.start("authenticate", { methodId: "browser" });
    await peer.reply(await peer.next("elicitation/create"), { action: "accept" });
    await h.send({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: login } });
    expect((await h.response(login)).error).toBeDefined();
    external.resolve();
    await until(() => finished);
    expect(h.messages.some((m) => m.method === "elicitation/complete")).toBe(false);
    expect((await h.request("session/new", { cwd: "/tmp", mcpServers: [] })).error?.code).toBe(
      -32000,
    );
  } finally {
    external.resolve();
    await h.close();
  }
});

test("authentication does not substitute form mode when the required URL capability is absent", async () => {
  const h = harness({
    ...setup().options,
    auth: {
      methods: [{ id: "browser", name: "Login" }],
      isAuthenticated: () => false,
      authenticate: async (_id, _signal, context) => {
        expect(context.elicitation.form).toBeDefined();
        expect(context.elicitation.url).toBeUndefined();
        throw new Error("Use another login flow; URL support is required");
      },
    },
  });
  try {
    await h.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { elicitation: { form: {} } },
    });
    expect((await h.request("authenticate", { methodId: "browser" })).error).toBeDefined();
    expect(h.messages.some((m) => m.method === "elicitation/create")).toBe(false);
  } finally {
    await h.close();
  }
});

test("cancelling authentication while its UI is unanswered cancels the matching elicitation request", async () => {
  const h = harness({
    ...setup().options,
    auth: {
      methods: [{ id: "browser", name: "Login" }],
      isAuthenticated: () => false,
      authenticate: async (_id, signal, context) => {
        await context.elicitation.url!(
          { message: "Sign in", url: "https://example.invalid/login" },
          signal,
        );
      },
    },
  });
  const peer = proxiedMcpPeer(h);
  try {
    await h.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { elicitation: { url: {} } },
    });
    const login = await h.start("authenticate", { methodId: "browser" });
    const url = await peer.next("elicitation/create");
    await h.send({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: login } });
    expect((await h.response(login)).error).toBeDefined();
    expect(
      h.messages.some((m) => m.method === "$/cancel_request" && m.params?.requestId === url.id),
    ).toBe(true);
    await peer.reply(url, { action: "accept" });
    expect((await h.request("session/new", { cwd: "/tmp", mcpServers: [] })).error?.code).toBe(
      -32000,
    );
    expect(h.messages.some((m) => m.method === "elicitation/complete")).toBe(false);
  } finally {
    await h.close();
  }
});
