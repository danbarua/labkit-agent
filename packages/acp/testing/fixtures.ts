/** Constants and helpers shared by the adapter-*.test.ts files. */

import { expect } from "@logtape/testing-bun/autoload";

import { until } from "../../core/agent/test-support.ts";
import type { AcpOptions } from "../adapter.ts";
import { setup, type harness } from "./harness.ts";
import type { Message as HarnessMessage, Message } from "./harness.ts";

// Keep workspace launcher tests off any real local model server.
export const offline = (async () => {
  throw new Error("offline");
}) as unknown as typeof fetch;

export const tools = {
  kind: "tools",
  text: "Reading",
  calls: [{ id: "one", name: "echo", args: { text: "contents" } }],
};

export const answer = { kind: "answer", text: "Done" };

export const prompt = (sessionId: string) => ({
  sessionId,
  prompt: [{ type: "text", text: "Go" }],
});

export function configurable(
  complete: (model: string) => unknown | Promise<unknown> = () => answer,
) {
  const base = setup();
  const requests: { model: string; tools?: { function: { name: string } }[] }[] = [];
  const options: AcpOptions = {
    ...base.options,
    sessionOptions: async (context) => {
      const original = await base.options.sessionOptions(context);
      const { openaiChat } = await import("@labkit-agent/core/providers");
      return {
        ...original,
        configuration: {
          ...original.configuration,
          agents: new Map(
            [...original.configuration.agents].map(([name, agent]) => [
              name,
              { ...agent, successors: [] },
            ]),
          ),
          policy: { maxOutputTokens: 16384, provider: openaiChat.id, model: "m" },
        },
        bindings: {
          ...original.bindings,
          complete: undefined,
          providers: new Map([
            [
              openaiChat.id,
              {
                profile: openaiChat,
                transport: {
                  baseUrl: "https://test.invalid",
                  fetch: (async (_url, init) => {
                    const body = JSON.parse(String(init?.body));
                    requests.push(body);
                    const result = (await complete(body.model)) as {
                      text: string;
                    };
                    return Response.json({ choices: [{ message: { content: result.text } }] });
                  }) as typeof fetch,
                },
              },
            ],
          ]),
        },
        config: [
          {
            id: "model",
            name: "Model",
            category: "model",
            current: (policy) => policy.model ?? "m",
            options: [
              { value: "m", name: "First", patch: { model: "m" } },
              { value: "m2", name: "Second", patch: { model: "m2" } },
            ],
          },
          {
            id: "mode",
            name: "Tools",
            category: "mode",
            current: (policy) => (policy.tools.a?.length ? "tools" : "chat"),
            options: [
              { value: "tools", name: "Tools", patch: { tools: { a: ["echo"] } } },
              { value: "chat", name: "Chat only", patch: { tools: { a: [] } } },
            ],
          },
        ],
      };
    },
  };
  return { ...base, options, requests };
}

export function proxiedMcpPeer(h: ReturnType<typeof harness>) {
  const handled = new Set<unknown>();
  const next = async (method: string, inner?: string) => {
    const match = () =>
      h.messages.find(
        (m) =>
          m.method === method &&
          m.id !== undefined &&
          !handled.has(m.id) &&
          (!inner || m.params?.method === inner),
      );
    await until(() => !!match());
    const message = match()!;
    handled.add(message.id);
    return message;
  };
  const reply = (message: Message, result: unknown) =>
    h.send({ jsonrpc: "2.0", id: message.id, result });
  return {
    next,
    reply,
    async open(connectionId = "mcp-connection-1", cwd = "/tmp") {
      const request = await h.start("session/new", {
        cwd,
        mcpServers: [{ type: "acp", name: "host", serverId: "host-server" }],
      });
      const connect = await next("mcp/connect");
      expect(connect.params).toEqual({ serverId: "host-server" });
      await reply(connect, { connectionId });
      const initialize = await next("mcp/message", "initialize");
      expect(initialize.params.connectionId).toBe(connectionId);
      await reply(initialize, {
        protocolVersion: initialize.params.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "host", version: "1" },
      });
      const list = await next("mcp/message", "tools/list");
      await reply(list, {
        tools: [
          {
            name: "echo",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
              additionalProperties: false,
            },
          },
        ],
      });
      const opened = await h.response(request);
      expect(opened.error).toBeUndefined();
      return opened.result.sessionId as string;
    },
    async close(sessionId: string, connectionId = "mcp-connection-1") {
      const close = await h.start("session/close", { sessionId });
      const disconnect = await next("mcp/disconnect");
      expect(disconnect.params).toEqual({ connectionId });
      await reply(disconnect, {});
      expect((await h.response(close)).error).toBeUndefined();
    },
  };
}
