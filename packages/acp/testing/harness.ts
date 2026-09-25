/** In-process ACP JSON-RPC harness for adapter tests: real SDK framing, no stdio or network. */
import { ndJsonStream, type SessionNotification } from "@agentclientprotocol/sdk";
import { defineTool, type SessionOptions } from "@labkit-agent/core";
import { createMemoryPersistence } from "@labkit-agent/core/testing";
import { z } from "zod";

import { until } from "../../core/agent/test-support.ts";
import { connectAcp, type AcpOptions } from "../adapter.ts";

/** One JSON-RPC frame the adapter wrote, as parsed from its output stream. */
export type Message = {
  jsonrpc: string;
  id?: string | number | null;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
};

/**
 * Connect an adapter to in-memory streams. `request` sends one JSON-RPC request and resolves
 * with its response frame; `messages` holds every frame the adapter wrote, including client
 * requests such as `session/request_permission`.
 */
export function harness(options: AcpOptions) {
  const input = new TransformStream<Uint8Array, Uint8Array>();
  const writer = input.writable.getWriter();
  const messages: Message[] = [];
  const output = new WritableStream<Uint8Array>({
    write(bytes) {
      messages.push(JSON.parse(new TextDecoder().decode(bytes)));
    },
  });
  const server = connectAcp(ndJsonStream(output, input.readable), options);
  const send = (value: unknown) =>
    writer.write(new TextEncoder().encode(`${JSON.stringify(value)}\n`));
  let sequence = 0;

  const response = async (id: number) => {
    await until(() => messages.some((m) => m.id === id && !m.method));
    return messages.find((m) => m.id === id && !m.method)!;
  };

  const start = async (method: string, params: unknown) => {
    const id = ++sequence;
    await send({ jsonrpc: "2.0", id, method, params });
    return id;
  };

  const request = async (method: string, params: unknown) => response(await start(method, params));
  return {
    messages,
    server,
    send,
    start,
    response,
    request,
    raw: (text: string) => writer.write(new TextEncoder().encode(text)),
    initialize: () => request("initialize", { protocolVersion: 1, clientCapabilities: {} }),
    newSession: async () =>
      (await request("session/new", { cwd: "/tmp", mcpServers: [] })).result.sessionId as string,
    updates: () =>
      messages
        .filter((m) => m.method === "session/update")
        .map((m) => m.params as SessionNotification),
    disconnect: async () => {
      await writer.close();
      await server.closed;
    },
    close: () => server.close(),
  };
}

/**
 * Minimal adapter options: memory persistence, one agent `a` with an `echo` tool, and a scripted
 * completion answering "Hello 🌍". `overrides` replace session bindings.
 */
export function setup(overrides: Partial<SessionOptions["bindings"]> = {}) {
  const persistence = createMemoryPersistence();
  const options: AcpOptions = {
    loadSession: true,
    sessionOptions: () => ({
      persistence,
      configuration: {
        agent: "a",
        agents: new Map([["a", { model: "m", tools: ["echo"] }]]),
        steps: 3,
      },
      bindings: {
        complete: () => ({ kind: "answer", text: "Hello 🌍" }),
        tools: new Map([
          ["echo", defineTool({ input: z.object({ text: z.string() }), run: ({ text }) => text })],
        ]),
        ...overrides,
      },
    }),
  };
  return { options, persistence };
}
