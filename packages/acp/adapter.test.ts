import { ndJsonStream, type SessionNotification } from "@agentclientprotocol/sdk";
import { defineTool, type SessionOptions } from "@labkit-agent/core";
import { createMemoryPersistence } from "@labkit-agent/core/testing";
import { getLogger } from "@logtape/logtape";
import { expect, spyOn, test } from "@logtape/testing-bun/autoload";
import { z } from "zod";

import { deferred, until } from "../core/agent/test-support.ts";
import {
  streamingProfiles,
  streamResponse,
  streamVector,
} from "../core/providers/testing/stream-vectors.ts";
import { connectAcp, type AcpOptions } from "./adapter.ts";
import type { PlanEntries } from "./plan.ts";

type Message = {
  jsonrpc: string;
  id?: string | number | null;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
};

function harness(options: AcpOptions) {
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

function setup(overrides: Partial<SessionOptions["bindings"]> = {}) {
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

const tools = {
  kind: "tools",
  text: "Reading",
  calls: [{ id: "one", name: "echo", args: { text: "contents" } }],
};

const answer = { kind: "answer", text: "Done" };

const prompt = (sessionId: string) => ({ sessionId, prompt: [{ type: "text", text: "Go" }] });

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
      promptCapabilities: { image: true, embeddedContext: true, audio: true },
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

test("permission response correlation and both durable gates precede tool execution", async () => {
  const intent = deferred<void>();
  const approval = deferred<void>();
  let waitingIntent = false;
  let waitingApproval = false;
  let ran = 0;
  let completions = 0;
  const { options, persistence } = setup({
    complete: () => (++completions === 1 ? tools : answer),
    tools: new Map([
      [
        "echo",
        defineTool({
          input: z.object({ text: z.string() }),
          kind: "read",
          locations: () => [{ path: "/tmp/DESIGN.md", line: 3 }],
          run: () => {
            ran++;
            return "contents";
          },
        }),
      ],
    ]),
  });
  const original = options.sessionOptions;
  const h = harness({
    ...options,
    sessionOptions: async (context) => ({
      ...(await original(context)),
      persistence: {
        ...persistence,
        append: async (request, signal) => {
          if (
            request.records.some((raw) => JSON.parse(raw).body.event?.event?.permissionRequired)
          ) {
            waitingIntent = true;
            await intent.promise;
          }
          if (
            request.records.some(
              (raw) => JSON.parse(raw).body.event?.event?.type === "permission_settled",
            )
          ) {
            waitingApproval = true;
            await approval.promise;
          }
          return persistence.append(request, signal);
        },
      },
    }),
  });
  await h.initialize();
  const id = await h.newSession();
  const requestId = await h.start("session/prompt", prompt(id));
  await until(() => waitingIntent);
  expect(h.messages.some((m) => m.method === "session/request_permission")).toBe(false);
  intent.resolve();
  await until(() => h.messages.some((m) => m.method === "session/request_permission"));
  const permission = h.messages.find((m) => m.method === "session/request_permission")!;
  expect(permission.params.toolCall).toMatchObject({
    title: 'echo: "/tmp/DESIGN.md":3',
    locations: [{ path: "/tmp/DESIGN.md", line: 3 }],
    status: "pending",
  });
  expect(permission.params).not.toHaveProperty("turnId");
  expect(permission.params.options.map((o: any) => o.kind)).toEqual([
    "allow_once",
    "allow_always",
    "reject_once",
  ]);
  expect(ran).toBe(0);
  await h.send({
    jsonrpc: "2.0",
    id: "wrong-id",
    result: { outcome: { outcome: "selected", optionId: "allow-once" } },
  });
  await Bun.sleep(5);
  expect(ran).toBe(0);
  await h.send({
    jsonrpc: "2.0",
    id: permission.id,
    result: { outcome: { outcome: "selected", optionId: "allow-once" } },
  });
  await until(() => waitingApproval);
  expect(ran).toBe(0);
  approval.resolve();
  expect((await h.response(requestId)).result).toEqual({ stopReason: "end_turn" });
  expect(ran).toBe(1);
  const updates = h.updates().map((m) => m.update);
  expect(
    updates
      .filter((u) => u.sessionUpdate === "agent_message_chunk")
      .map((u: any) => u.content.text),
  ).toEqual(["Reading", "Done"]);
  expect(
    updates
      .filter((u) => "toolCallId" in u && u.toolCallId === permission.params.toolCall.toolCallId)
      .map((u: any) => u.status)
      .filter(Boolean),
  ).toEqual(["pending", "pending", "in_progress", "completed"]);
  const cardUpdates = updates.filter(
    (u) =>
      u.sessionUpdate === "tool_call_update" &&
      u.toolCallId === permission.params.toolCall.toolCallId,
  );
  expect(cardUpdates[0]).toMatchObject({
    title: 'echo: "/tmp/DESIGN.md":3',
    status: "pending",
    locations: [{ path: "/tmp/DESIGN.md", line: 3 }],
  });
  expect(cardUpdates.at(-1)).toMatchObject({
    title: 'echo: "/tmp/DESIGN.md":3',
    status: "completed",
  });
  expect(h.messages.at(-1)?.id).toBe(requestId);
  await h.close();
});

for (const choice of ["reject-once", "bad-option", "cancelled"] as const)
  test(`${choice} permission never runs tools`, async () => {
    let ran = 0;
    const { options } = setup({
      complete: () => tools,
      tools: new Map([
        [
          "echo",
          defineTool({
            input: z.object({ text: z.string() }),
            run: () => {
              ran++;
              return "bad";
            },
          }),
        ],
      ]),
    });
    const h = harness(options);
    await h.initialize();
    const id = await h.newSession();
    const requestId = await h.start("session/prompt", prompt(id));
    await until(() => h.messages.some((m) => m.method === "session/request_permission"));
    const permission = h.messages.find((m) => m.method === "session/request_permission")!;
    await h.send({
      jsonrpc: "2.0",
      id: permission.id,
      result: {
        outcome:
          choice === "cancelled"
            ? { outcome: "cancelled" }
            : { outcome: "selected", optionId: choice },
      },
    });
    const response = await h.response(requestId);
    if (choice === "bad-option") expect(response.error?.code).toBe(-32000);
    else
      expect(response.result.stopReason).toBe(choice === "reject-once" ? "refusal" : "cancelled");
    expect(ran).toBe(0);
    await h.close();
  });

test("cancellation is processed while permission response is pending; late allow is ignored", async () => {
  let ran = 0;
  const { options } = setup({
    complete: () => tools,
    tools: new Map([
      [
        "echo",
        defineTool({
          input: z.object({ text: z.string() }),
          run: () => {
            ran++;
            return "bad";
          },
        }),
      ],
    ]),
  });
  const h = harness(options);
  await h.initialize();
  const id = await h.newSession();
  const requestId = await h.start("session/prompt", prompt(id));
  await until(() => h.messages.some((m) => m.method === "session/request_permission"));
  const permission = h.messages.find((m) => m.method === "session/request_permission")!;
  expect((await h.request("session/prompt", prompt(id))).error?.message).toContain("active prompt");
  await h.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: id } });
  expect((await h.response(requestId)).result).toEqual({ stopReason: "cancelled" });
  const count = h.updates().length;
  await h.send({
    jsonrpc: "2.0",
    id: permission.id,
    result: { outcome: { outcome: "selected", optionId: "allow-once" } },
  });
  await Bun.sleep(5);
  expect(ran).toBe(0);
  expect(h.updates()).toHaveLength(count);
  await h.close();
});

test("session routing isolates cancellation; disconnect aborts remaining completion", async () => {
  const signals: AbortSignal[] = [];
  const pending = deferred<unknown>();
  const { options } = setup({
    complete: (_, signal) => {
      signals.push(signal);
      return pending.promise;
    },
  });
  const h = harness(options);
  await h.initialize();
  const a = await h.newSession();
  const b = await h.newSession();
  const first = await h.start("session/prompt", prompt(a));
  await h.start("session/prompt", prompt(b));
  await until(() => signals.length === 2);
  await h.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: a } });
  expect((await h.response(first)).result.stopReason).toBe("cancelled");
  expect(signals.map((s) => s.aborted)).toEqual([true, false]);
  await h.disconnect();
  expect(signals.every((s) => s.aborted)).toBe(true);
  pending.resolve(answer);
});

test("load replays committed history before response, never starts providers or permissions", async () => {
  let completions = 0;
  const { options } = setup({
    complete: () => {
      completions++;
      return answer;
    },
  });
  const first = harness(options);
  await first.initialize();
  const id = await first.newSession();
  await first.request("session/prompt", prompt(id));
  await first.close();
  const second = harness(options);
  await second.initialize();
  expect(
    (await second.request("session/load", { sessionId: id, cwd: "/tmp", mcpServers: [] })).result,
  ).toEqual({});
  expect(second.updates().map((m) => m.update.sessionUpdate)).toEqual([
    "user_message_chunk",
    "agent_message_chunk",
  ]);
  expect(completions).toBe(1);
  expect(second.messages.at(-1)?.result).toEqual({});
  expect(
    (await second.request("session/load", { sessionId: id, cwd: "/tmp", mcpServers: [] })).error
      ?.message,
  ).toContain("already loaded");
  await second.request("session/close", { sessionId: id });
  expect((await second.request("session/prompt", prompt(id))).error).toBeDefined();
  await second.close();
});

for (const profile of streamingProfiles)
  test(`${profile.id}: streamed text/thinking stays incremental without duplicate settled output`, async () => {
    const { options } = setup();
    const original = options.sessionOptions;
    const h = harness({
      ...options,
      sessionOptions: async (context) => {
        const base = await original(context);
        return {
          ...base,
          configuration: {
            ...base.configuration,
            policy: {
              thinkingBudgetTokens: profile.capabilities.thinking.mode === "budget" ? 1024 : null,
              provider: profile.id,
              stream: true,
              thinking:
                profile.id.startsWith("anthropic") || profile.id.startsWith("google")
                  ? "budget"
                  : "high",
              maxOutputTokens: 2048,
            },
          },
          bindings: {
            ...base.bindings,
            complete: undefined,
            providers: new Map([
              [
                profile.id,
                {
                  profile,
                  transport: {
                    baseUrl: "https://test.invalid",
                    fetch: (async () =>
                      streamResponse(streamVector(profile))) as unknown as typeof fetch,
                  },
                },
              ],
            ]),
          },
        };
      },
    });
    await h.initialize();
    const id = await h.newSession();
    expect((await h.request("session/prompt", prompt(id))).result?.stopReason).toBe("end_turn");
    const chunks = h
      .updates()
      .map((m) => m.update)
      .filter((u) => u.sessionUpdate === "agent_message_chunk");
    expect(chunks.map((u: any) => u.content.text).join("")).toBe("Hello 🌍");
    expect(new Set(chunks.map((u: any) => u.messageId)).size).toBe(1);
    if (profile.id !== "openai-chat@2")
      expect(h.updates().some((m) => m.update.sessionUpdate === "agent_thought_chunk")).toBe(true);
    await h.close();
  });

test("load keeps raw failed tool status under tolerant policy and never repeats permission", async () => {
  let completions = 0;
  const { options } = setup({
    complete: () => (++completions === 1 ? tools : answer),
    tools: new Map([
      [
        "echo",
        defineTool({
          input: z.object({ text: z.string() }),
          run: () => {
            throw new Error("read failed");
          },
        }),
      ],
    ]),
  });
  const original = options.sessionOptions;
  const config: AcpOptions = {
    ...options,
    sessionOptions: async (context) => {
      const base = await original(context);
      return {
        ...base,
        configuration: {
          ...base.configuration,
          policy: { toolFailure: "return-error-and-continue" },
        },
      };
    },
  };
  const h = harness(config);
  await h.initialize();
  const id = await h.newSession();
  const requestId = await h.start("session/prompt", prompt(id));
  await until(() => h.messages.some((m) => m.method === "session/request_permission"));
  const permission = h.messages.find((m) => m.method === "session/request_permission")!;
  await h.send({
    jsonrpc: "2.0",
    id: permission.id,
    result: { outcome: { outcome: "selected", optionId: "allow-once" } },
  });
  expect((await h.response(requestId)).result.stopReason).toBe("end_turn");
  await h.close();
  const loaded = harness(config);
  await loaded.initialize();
  await loaded.request("session/load", { sessionId: id, cwd: "/tmp", mcpServers: [] });
  expect(
    loaded
      .updates()
      .some((m) => m.update.sessionUpdate === "tool_call_update" && m.update.status === "failed"),
  ).toBe(true);
  expect(loaded.messages.some((m) => m.method === "session/request_permission")).toBe(false);
  expect(completions).toBe(2);
  await loaded.close();
});

test("interrupted permission recovers on load with no effects or repeated request", async () => {
  let completions = 0;
  let ran = 0;
  const { options } = setup({
    complete: () => {
      completions++;
      return tools;
    },
    tools: new Map([
      [
        "echo",
        defineTool({
          input: z.object({ text: z.string() }),
          run: () => {
            ran++;
            return "bad";
          },
        }),
      ],
    ]),
  });
  const h = harness(options);
  await h.initialize();
  const id = await h.newSession();
  await h.start("session/prompt", prompt(id));
  await until(() => h.messages.some((m) => m.method === "session/request_permission"));
  await h.disconnect();
  const loaded = harness(options);
  await loaded.initialize();
  expect(
    (await loaded.request("session/load", { sessionId: id, cwd: "/tmp", mcpServers: [] })).result,
  ).toEqual({});
  expect(completions).toBe(1);
  expect(ran).toBe(0);
  expect(loaded.messages.some((m) => m.method === "session/request_permission")).toBe(false);
  expect(
    loaded
      .updates()
      .some((m) => m.update.sessionUpdate === "tool_call_update" && m.update.status === "failed"),
  ).toBe(true);
  await loaded.close();
});

test("incomplete stream reports an RPC failure, never successful end_turn", async () => {
  const { openaiChatV2 } = await import("@labkit-agent/core/providers");
  const { options } = setup();
  const original = options.sessionOptions;
  const h = harness({
    ...options,
    sessionOptions: async (context) => {
      const base = await original(context);
      return {
        ...base,
        configuration: {
          ...base.configuration,
          policy: { maxOutputTokens: 16384, provider: openaiChatV2.id, stream: true },
        },
        bindings: {
          ...base.bindings,
          complete: undefined,
          providers: new Map([
            [
              openaiChatV2.id,
              {
                profile: openaiChatV2,
                transport: {
                  baseUrl: "https://test.invalid",
                  fetch: (async () =>
                    streamResponse(
                      streamVector(openaiChatV2).slice(0, -1),
                    )) as unknown as typeof fetch,
                },
              },
            ],
          ]),
        },
      };
    },
  });
  await h.initialize();
  const id = await h.newSession();
  expect((await h.request("session/prompt", prompt(id))).error?.code).toBe(-32000);
  await h.close();
});

test("disconnect does not wait for an unresolved options factory and late resolution starts no session", async () => {
  const pending = deferred<SessionOptions>();
  let signal: AbortSignal | undefined;
  let appends = 0;
  const { options, persistence } = setup();
  const h = harness({
    sessionOptions: (context) => {
      signal = context.signal;
      return pending.promise;
    },
  });
  await h.initialize();
  await h.start("session/new", { cwd: "/tmp", mcpServers: [] });
  await until(() => !!signal);
  await h.disconnect();
  expect(signal?.aborted).toBe(true);
  const bound = await options.sessionOptions({ cwd: "/tmp", signal: new AbortController().signal });
  pending.resolve({
    ...bound,
    persistence: {
      ...persistence,
      append: (request, value) => {
        appends++;
        return persistence.append(request, value);
      },
    },
  });
  await Bun.sleep(5);
  expect(appends).toBe(0);
});

test("output failure closes owned runtimes and cancels pending provider work", async () => {
  const input = new TransformStream<Uint8Array, Uint8Array>();
  const writer = input.writable.getWriter();
  const frames: Message[] = [];
  let failOutput = false;
  const output = new WritableStream<Uint8Array>({
    write(bytes) {
      if (failOutput) throw new Error("Broken stdout");
      frames.push(JSON.parse(new TextDecoder().decode(bytes)));
    },
  });
  const pending = deferred<unknown>();
  let signal: AbortSignal | undefined;
  const { options } = setup({
    complete: (_, value) => {
      signal = value;
      return pending.promise;
    },
  });
  const h = connectAcp(ndJsonStream(output, input.readable), options);
  const send = (message: unknown) =>
    writer.write(new TextEncoder().encode(`${JSON.stringify(message)}\n`));
  await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
  await until(() => frames.some((f) => f.id === 1));
  await send({
    jsonrpc: "2.0",
    id: 2,
    method: "session/new",
    params: { cwd: "/tmp", mcpServers: [] },
  });
  await until(() => frames.some((f) => f.id === 2));
  const id = frames.find((f) => f.id === 2)!.result.sessionId;
  await send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: prompt(id) });
  await until(() => !!signal);
  failOutput = true;
  // Force a response write while the provider is still running.
  await send({ jsonrpc: "2.0", id: 4, method: "unknown", params: {} });
  await h.closed;
  expect(signal?.aborted).toBe(true);
  pending.resolve(answer);
});

test("local resource links become session blob refs; outside paths reject before admission; remote links never fetch", async () => {
  const { mkdtemp, mkdir, writeFile, symlink, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const root = await mkdtemp(join(tmpdir(), "labkit-acp-attachments-"));
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  const body = "# Attachment-only sentinel 57193";
  await writeFile(join(cwd, "DESIGN.md"), body);
  await writeFile(join(root, "outside.md"), "outside sentinel");
  await symlink(join(root, "outside.md"), join(cwd, "escape.md"));
  let completions = 0;
  const { options, persistence } = setup({
    complete: () => {
      completions++;
      return answer;
    },
  });
  const { openaiChat } = await import("@labkit-agent/core/providers");
  const original = options.sessionOptions;
  const h = harness({
    ...options,
    sessionOptions: async (context) => {
      const base = await original(context);
      return {
        ...base,
        configuration: {
          ...base.configuration,
          policy: { maxOutputTokens: 16384, provider: openaiChat.id },
        },
        bindings: {
          ...base.bindings,
          complete: undefined,
          providers: new Map([
            [
              openaiChat.id,
              {
                profile: openaiChat,
                transport: {
                  baseUrl: "https://provider.invalid/v1",
                  fetch: (async (url, init) => {
                    expect(String(url)).toBe("https://provider.invalid/v1/chat/completions");
                    completions++;
                    if (completions <= 2) expect(String(init?.body)).toContain(body);
                    return Response.json({ choices: [{ message: { content: "Done" } }] });
                  }) as typeof fetch,
                },
              },
            ],
          ]),
        },
      };
    },
  });
  try {
    await h.initialize();
    const id = (await h.request("session/new", { cwd, mcpServers: [] })).result.sessionId;
    for (const uri of [
      pathToFileURL(join(root, "outside.md")).href,
      "../outside.md",
      pathToFileURL(join(cwd, "escape.md")).href,
    ]) {
      expect(
        (
          await h.request("session/prompt", {
            sessionId: id,
            prompt: [{ type: "resource_link", name: "invalid", uri }],
          })
        ).error?.code,
      ).toBe(-32602);
    }
    expect(completions).toBe(0);
    for (const uri of [pathToFileURL(join(cwd, "DESIGN.md")).href, "DESIGN.md"]) {
      expect(
        (
          await h.request("session/prompt", {
            sessionId: id,
            prompt: [
              { type: "text", text: "Review" },
              { type: "resource_link", name: "DESIGN.md", uri },
            ],
          })
        ).result.stopReason,
      ).toBe("end_turn");
    }
    const { SessionIdSchema } = await import("@labkit-agent/core/types");
    const sessionId = SessionIdSchema.parse(id);
    const loaded = await persistence.load(sessionId, new AbortController().signal);
    if (loaded.kind !== "loaded") throw new Error("Missing journal");
    const records = loaded.batches.flatMap((batch) => batch.records.map((raw) => JSON.parse(raw)));
    const inputs = records.filter((r) => r.body.kind === "event" && r.body.event.type === "user");
    expect(inputs).toHaveLength(2);
    const ref = inputs[0].body.event.attachments[0];
    expect(ref).toMatchObject({
      media: "text/markdown",
      name: "DESIGN.md",
      bytes: Buffer.byteLength(body),
    });
    const blob = await persistence.getBlob(sessionId, ref.id, new AbortController().signal);
    expect("bytes" in blob && new TextDecoder().decode(blob.bytes)).toBe(body);
    expect(JSON.stringify(loaded.batches)).not.toContain(body);
    // If a URL were fetched this deliberately invalid host could not succeed.
    expect(
      (
        await h.request("session/prompt", {
          sessionId: id,
          prompt: [
            {
              type: "resource_link",
              name: "remote",
              uri: "https://must-not-fetch.invalid/README.md",
            },
          ],
        })
      ).result.stopReason,
    ).toBe("end_turn");
    expect(completions).toBe(3);
  } finally {
    await h.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("cancel during attachment storage never admits a user event or starts completion", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const cwd = await mkdtemp(join(tmpdir(), "labkit-acp-cancel-attachment-"));
  await writeFile(join(cwd, "file.txt"), "body");
  let entered = false;
  let storageSignal: AbortSignal | undefined;
  let completions = 0;
  const pending = deferred<void>();
  const { options, persistence } = setup({
    complete: () => {
      completions++;
      return answer;
    },
  });
  const { openaiChat } = await import("@labkit-agent/core/providers");
  const original = options.sessionOptions;
  const h = harness({
    ...options,
    sessionOptions: async (context) => {
      const base = await original(context);
      return {
        ...base,
        configuration: {
          ...base.configuration,
          policy: { maxOutputTokens: 16384, provider: openaiChat.id },
        },
        bindings: {
          ...base.bindings,
          complete: undefined,
          providers: new Map([
            [
              openaiChat.id,
              {
                profile: openaiChat,
                transport: {
                  baseUrl: "https://provider.invalid",
                  fetch: (async (_url, _init) => {
                    completions++;
                    return Response.json({
                      choices: [{ message: { content: "Unexpected completion" } }],
                    });
                  }) as typeof fetch,
                },
              },
            ],
          ]),
        },
        persistence: {
          ...persistence,
          putBlob: async (id, bytes, meta, signal) => {
            entered = true;
            storageSignal = signal;
            await pending.promise;
            return persistence.putBlob(id, bytes, meta, signal);
          },
        },
      };
    },
  });
  try {
    await h.initialize();
    const id = (await h.request("session/new", { cwd, mcpServers: [] })).result.sessionId;
    const promptId = await h.start("session/prompt", {
      sessionId: id,
      prompt: [{ type: "resource_link", name: "file", uri: "file.txt" }],
    });
    await until(() => entered);
    await h.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: id } });
    await until(() => !!storageSignal?.aborted);
    pending.resolve();
    expect((await h.response(promptId)).result.stopReason).toBe("cancelled");
    expect(completions).toBe(0);
    const { SessionIdSchema } = await import("@labkit-agent/core/types");
    const loaded = await persistence.load(SessionIdSchema.parse(id), new AbortController().signal);
    expect(
      loaded.kind === "loaded" && loaded.batches.flatMap((batch) => batch.records).length,
    ).toBe(1);
  } finally {
    pending.resolve();
    await h.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("durable ACP reload resolves stored attachments without source files; denied write returns refusal", async () => {
  const { mkdtemp, writeFile, rm, access } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { openaiChat } = await import("@labkit-agent/core/providers");
  const { workspacePersistence } = await import("./workspace-persistence.ts");
  const { workspaceFiles } = await import("./workspace-files.ts");
  const { workspaceTools } = await import("./workspace-tools.ts");
  const cwd = await mkdtemp(join(tmpdir(), "labkit-acp-durable-"));
  const document = "# Blob-only document sentinel 27381";
  await writeFile(join(cwd, "DESIGN.md"), document);
  let blobReads = 0;
  let completions = 0;
  const options: AcpOptions = {
    loadSession: true,
    sessionOptions: async () => {
      const tools = workspaceTools(await workspaceFiles(cwd));
      const persistence = workspacePersistence(cwd);
      return {
        persistence: {
          ...persistence,
          getBlob: (...args) => {
            blobReads++;
            return persistence.getBlob(...args);
          },
        },
        configuration: {
          agent: "workspace",
          agents: new Map([
            ["workspace", { model: "m", tools: [...tools.keys()], successors: [] }],
          ]),
          steps: 6,
          policy: { maxOutputTokens: 16384, provider: openaiChat.id, permissions: "ask" },
        },
        bindings: {
          tools,
          providers: new Map([
            [
              openaiChat.id,
              {
                profile: openaiChat,
                transport: {
                  baseUrl: "https://test.invalid",
                  fetch: (async (_url, init) => {
                    completions++;
                    const body = String(init?.body);
                    if (body.includes("WRITE_DENIED"))
                      return Response.json({
                        choices: [
                          {
                            message: {
                              content: null,
                              tool_calls: [
                                {
                                  id: "write-one",
                                  type: "function",
                                  function: {
                                    name: "write_file",
                                    arguments: JSON.stringify({
                                      path: "denied.txt",
                                      text: "must not write",
                                    }),
                                  },
                                },
                              ],
                            },
                          },
                        ],
                      });
                    expect(body).toContain(document);
                    return Response.json({
                      choices: [{ message: { content: "Attachment read" } }],
                    });
                  }) as typeof fetch,
                },
              },
            ],
          ]),
        },
      };
    },
  };
  let h = harness(options);
  try {
    await h.initialize();
    const sessionId = (await h.request("session/new", { cwd, mcpServers: [] })).result.sessionId;
    expect(
      (
        await h.request("session/prompt", {
          sessionId,
          prompt: [
            { type: "text", text: "Review" },
            { type: "resource_link", name: "DESIGN.md", uri: "DESIGN.md" },
          ],
        })
      ).result.stopReason,
    ).toBe("end_turn");
    await h.close();
    await rm(join(cwd, "DESIGN.md"));
    h = harness(options);
    await h.initialize();
    const before = blobReads;
    expect(
      (await h.request("session/load", { cwd, sessionId, mcpServers: [] })).error,
    ).toBeUndefined();
    expect(blobReads).toBe(before);
    expect(completions).toBe(1);
    expect(
      (
        await h.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: "Review that attachment again" }],
        })
      ).result.stopReason,
    ).toBe("end_turn");
    expect(blobReads).toBeGreaterThan(before);
    const denialSession = (await h.request("session/new", { cwd, mcpServers: [] })).result
      .sessionId;
    const pending = await h.start("session/prompt", {
      sessionId: denialSession,
      prompt: [{ type: "text", text: "WRITE_DENIED" }],
    });
    await until(() => h.messages.some((m) => m.method === "session/request_permission"));
    const permission = h.messages.find((m) => m.method === "session/request_permission")!;
    expect(permission.params.toolCall).toMatchObject({
      kind: "edit",
      locations: [
        { path: join(await import("node:fs/promises").then((m) => m.realpath(cwd)), "denied.txt") },
      ],
    });
    const option = permission.params.options.find((value: any) => value.kind === "reject_once");
    await h.send({
      jsonrpc: "2.0",
      id: permission.id,
      result: { outcome: { outcome: "selected", optionId: option.optionId } },
    });
    expect((await h.response(pending)).result.stopReason).toBe("refusal");
    await expect(access(join(cwd, "denied.txt"))).rejects.toThrow();
    expect(completions).toBe(3);
  } finally {
    await h.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("resume advertises durable support and restores without replay; list is gated and read-only", async () => {
  let completions = 0;
  const base = setup({
    complete: () => {
      completions++;
      return answer;
    },
  });
  const listRequests: unknown[] = [];
  const options: AcpOptions = {
    ...base.options,
    listSessions: (params, signal) => {
      signal.throwIfAborted();
      listRequests.push(params);
      return { sessions: [] };
    },
  };
  let h = harness(options);
  try {
    expect((await h.request("session/list", {})).error?.code).toBe(-32002);
    expect((await h.initialize()).result.agentCapabilities.sessionCapabilities).toMatchObject({
      list: {},
      resume: {},
    });
    expect((await h.request("session/list", { cwd: "relative" })).error?.code).toBe(-32602);
    expect((await h.request("session/list", {})).result).toEqual({ sessions: [] });
    expect(listRequests).toHaveLength(1);
    const id = await h.newSession();
    await h.request("session/prompt", prompt(id));
    await h.close();
    h = harness(options);
    await h.initialize();
    expect((await h.request("session/resume", { sessionId: id, cwd: "/tmp" })).result).toEqual({});
    expect(h.updates()).toHaveLength(0);
    expect(completions).toBe(1);
    expect((await h.request("session/resume", { sessionId: id, cwd: "/tmp" })).error?.code).toBe(
      -32602,
    );
    expect((await h.request("session/prompt", prompt(id))).result.stopReason).toBe("end_turn");
    expect(completions).toBe(2);
  } finally {
    await h.close();
  }
  const unsupported = harness({ ...base.options, loadSession: false });
  try {
    const capabilities = (await unsupported.initialize()).result.agentCapabilities
      .sessionCapabilities;
    expect(capabilities.list).toBeUndefined();
    expect(capabilities.resume).toBeUndefined();
    expect((await unsupported.request("session/list", {})).error?.code).toBe(-32601);
    expect(
      (await unsupported.request("session/resume", { sessionId: "none", cwd: "/tmp" })).error?.code,
    ).toBe(-32601);
  } finally {
    await unsupported.close();
  }
});

function configurable(complete: (model: string) => unknown | Promise<unknown> = () => answer) {
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

test("config updates wait for the journal receipt, notify complete state, and restore with modes", async () => {
  const models: string[] = [];
  const base = configurable((model) => {
    models.push(model);
    return answer;
  });
  const gate = deferred<void>();
  let entered = false;
  let gatePolicy = true;
  const persistence = {
    ...base.persistence,
    append: async (request: Parameters<typeof base.persistence.append>[0], signal: AbortSignal) => {
      if (gatePolicy && request.records.some((raw) => JSON.parse(raw).body.kind === "policy")) {
        entered = true;
        await gate.promise;
        gatePolicy = false;
      }
      return base.persistence.append(request, signal);
    },
  };
  const options: AcpOptions = {
    ...base.options,
    sessionOptions: async (context) => ({
      ...(await base.options.sessionOptions(context)),
      persistence,
    }),
  };
  let h = harness(options);
  try {
    await h.initialize();
    const created = (await h.request("session/new", { cwd: "/tmp", mcpServers: [] })).result;
    const id = created.sessionId;
    expect(created.configOptions.map((option: any) => option.currentValue)).toEqual(["m", "tools"]);
    expect(created.modes.currentModeId).toBe("tools");
    expect(
      (
        await h.request("session/set_config_option", {
          sessionId: id,
          configId: "model",
          value: "unknown",
        })
      ).error?.code,
    ).toBe(-32602);
    const setting = await h.start("session/set_config_option", {
      sessionId: id,
      configId: "model",
      value: "m2",
    });
    await until(() => entered);
    expect(h.updates()).toHaveLength(0);
    const turn = await h.start("session/prompt", prompt(id));
    await Bun.sleep(5);
    expect(models).toEqual([]);
    expect(h.messages.some((message) => message.id === setting && !message.method)).toBe(false);
    gate.resolve();
    const response = await h.response(setting);
    expect(response.result.configOptions.map((option: any) => option.currentValue)).toEqual([
      "m2",
      "tools",
    ]);
    expect((await h.response(turn)).result.stopReason).toBe("end_turn");
    expect(models).toEqual(["m2"]);
    expect(base.requests[0]?.tools?.some((tool) => tool.function.name === "echo")).toBe(true);
    expect(
      h.updates().filter((n) => n.update.sessionUpdate === "config_option_update"),
    ).toHaveLength(1);
    expect((await h.request("session/set_mode", { sessionId: id, modeId: "chat" })).result).toEqual(
      {},
    );
    expect(
      h
        .updates()
        .some(
          (n) =>
            n.update.sessionUpdate === "current_mode_update" && n.update.currentModeId === "chat",
        ),
    ).toBe(true);
    expect((await h.request("session/prompt", prompt(id))).result.stopReason).toBe("end_turn");
    expect(base.requests.at(-1)?.tools ?? []).toEqual([]);
    await h.close();
    h = harness(options);
    await h.initialize();
    const loaded = (await h.request("session/load", { sessionId: id, cwd: "/tmp", mcpServers: [] }))
      .result;
    expect(loaded.configOptions.map((option: any) => option.currentValue)).toEqual(["m2", "chat"]);
    expect(loaded.modes.currentModeId).toBe("chat");
  } finally {
    gate.resolve();
    await h.close();
  }
});

test("configuration requested mid-turn waits for settlement and does not admit overlapping prompts", async () => {
  const pending = deferred<unknown>();
  const models: string[] = [];
  const { options } = configurable((model) => {
    models.push(model);
    return models.length === 1 ? pending.promise : answer;
  });
  const h = harness(options);
  try {
    await h.initialize();
    const id = await h.newSession();
    const first = await h.start("session/prompt", prompt(id));
    await until(() => models.length === 1);
    const setting = await h.start("session/set_config_option", {
      sessionId: id,
      configId: "model",
      value: "m2",
    });
    expect((await h.request("session/prompt", prompt(id))).error?.code).toBe(-32000);
    expect(h.messages.some((m) => m.id === setting && !m.method)).toBe(false);
    pending.resolve(answer);
    expect((await h.response(first)).result.stopReason).toBe("end_turn");
    expect((await h.response(setting)).result.configOptions[0].currentValue).toBe("m2");
    expect((await h.request("session/prompt", prompt(id))).result.stopReason).toBe("end_turn");
    expect(models).toEqual(["m", "m2"]);
  } finally {
    pending.resolve(answer);
    await h.close();
  }
});

test("closing an active session rejects queued config without journaling the change", async () => {
  let started = false;
  const pending = deferred<unknown>();
  const { options, persistence } = configurable(() => {
    started = true;
    return pending.promise;
  });
  const h = harness(options);
  try {
    await h.initialize();
    const id = await h.newSession();
    await h.start("session/prompt", prompt(id));
    await until(() => started);
    const setting = await h.start("session/set_config_option", {
      sessionId: id,
      configId: "model",
      value: "m2",
    });
    expect((await h.request("session/close", { sessionId: id })).result).toEqual({});
    expect((await h.response(setting)).error?.code).toBe(-32000);
    const { SessionIdSchema } = await import("@labkit-agent/core/types");
    const loaded = await persistence.load(SessionIdSchema.parse(id), new AbortController().signal);
    expect(
      loaded.kind === "loaded" &&
        loaded.batches
          .flatMap((batch) => batch.records)
          .some((raw) => JSON.parse(raw).body.kind === "policy"),
    ).toBe(false);
  } finally {
    pending.resolve(answer);
    await h.close();
  }
});

test("cancelling a queued configuration request never applies it after the turn", async () => {
  const pending = deferred<unknown>();
  let started = false;
  const { options, persistence } = configurable(() => {
    started = true;
    return pending.promise;
  });
  const h = harness(options);
  try {
    await h.initialize();
    const id = await h.newSession();
    const turn = await h.start("session/prompt", prompt(id));
    await until(() => started);
    const setting = await h.start("session/set_config_option", {
      sessionId: id,
      configId: "model",
      value: "m2",
    });
    await h.send({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: setting } });
    expect((await h.response(setting)).error).toBeDefined();
    pending.resolve(answer);
    await h.response(turn);
    const { SessionIdSchema } = await import("@labkit-agent/core/types");
    const loaded = await persistence.load(SessionIdSchema.parse(id), new AbortController().signal);
    expect(
      loaded.kind === "loaded" &&
        loaded.batches
          .flatMap((batch) => batch.records)
          .some((raw) => JSON.parse(raw).body.kind === "policy"),
    ).toBe(false);
    expect(h.updates().some((n) => n.update.sessionUpdate === "config_option_update")).toBe(false);
  } finally {
    pending.resolve(answer);
    await h.close();
  }
});

test("invalid policy patches return errors without publishing a configuration change", async () => {
  const base = configurable();
  const h = harness({
    ...base.options,
    sessionOptions: async (context) => {
      const original = await base.options.sessionOptions(context);
      return {
        ...original,
        config: original.config!.map((binding) =>
          binding.id !== "model" || binding.type === "boolean"
            ? binding
            : {
                ...binding,
                options: [
                  ...binding.options.flatMap((option) =>
                    "group" in option ? [...option.options] : [option],
                  ),
                  {
                    value: "unbound",
                    name: "Unbound",
                    patch: { model: "unbound", provider: "missing@1" },
                  },
                ],
              },
        ),
      };
    },
  });
  try {
    await h.initialize();
    const id = await h.newSession();
    expect(
      (
        await h.request("session/set_config_option", {
          sessionId: id,
          configId: "model",
          value: "unbound",
        })
      ).error?.code,
    ).toBe(-32000);
    expect(h.updates()).toHaveLength(0);
    const same = await h.request("session/set_config_option", {
      sessionId: id,
      configId: "model",
      value: "m",
    });
    expect(same.result.configOptions[0].currentValue).toBe("m");
    expect((await h.request("session/prompt", prompt(id))).result.stopReason).toBe("end_turn");
  } finally {
    await h.close();
  }
});

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

test("ACP embedded image, PDF, and editor text reach provider wire through blobs only", async () => {
  const { anthropicMessagesV2 } = await import("@labkit-agent/core/providers");
  const { SessionIdSchema } = await import("@labkit-agent/core/types");
  const base = setup();
  const text = "UNSAVED_EDITOR_CONTENT_SENTINEL";
  const image = Buffer.from("IMAGE_CONTENT_SENTINEL").toString("base64");
  const pdf = Buffer.from("PDF_CONTENT_SENTINEL").toString("base64");
  let wire: any;
  const h = harness({
    ...base.options,
    sessionOptions: async (context) => {
      const original = await base.options.sessionOptions(context);
      return {
        ...original,
        configuration: {
          ...original.configuration,
          policy: { maxOutputTokens: 16384, provider: anthropicMessagesV2.id },
        },
        bindings: {
          ...original.bindings,
          complete: undefined,
          providers: new Map([
            [
              anthropicMessagesV2.id,
              {
                profile: anthropicMessagesV2,
                transport: {
                  baseUrl: "https://provider.invalid",
                  fetch: (async (_url, init) => {
                    wire = JSON.parse(String(init?.body));
                    return Response.json({
                      role: "assistant",
                      content: [{ type: "text", text: "Done" }],
                      stop_reason: "end_turn",
                    });
                  }) as typeof fetch,
                },
              },
            ],
          ]),
        },
      };
    },
  });
  try {
    await h.initialize();
    const id = await h.newSession();
    const response = await h.request("session/prompt", {
      sessionId: id,
      prompt: [
        { type: "image", mimeType: "image/png", data: image },
        {
          type: "resource",
          resource: { uri: "file:///outside/unsaved.md", mimeType: "text/markdown", text },
        },
        {
          type: "resource",
          resource: {
            uri: "https://must-not-fetch.invalid/doc.pdf",
            mimeType: "application/pdf",
            blob: pdf,
          },
        },
      ],
    });
    expect(response.error).toBeUndefined();
    expect(response.result.stopReason).toBe("end_turn");
    const content = wire.messages[0].content;
    expect(content).toContainEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: image },
    });
    expect(content).toContainEqual({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: pdf },
    });
    expect(JSON.stringify(content)).toContain(text);
    const journal = await base.persistence.load(
      SessionIdSchema.parse(id),
      new AbortController().signal,
    );
    expect(JSON.stringify(journal)).not.toContain(text);
    expect(JSON.stringify(journal)).not.toContain(image);
    expect(JSON.stringify(journal)).not.toContain(pdf);
  } finally {
    await h.close();
  }
});

for (const scenario of [
  "read",
  "write",
  "reject",
  "cancel",
  "error",
  "oversize",
  "unsupported",
] as const) {
  test(`client filesystem ${scenario} stays on the permission and session path`, async () => {
    const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { workspaceFiles, MAX_FILE_BYTES } = await import("./workspace-files.ts");
    const { workspaceTools } = await import("./workspace-tools.ts");
    const cwd = await mkdtemp(join(tmpdir(), "labkit-client-fs-"));
    await writeFile(join(cwd, "README.md"), "disk contents");
    const files = await workspaceFiles(cwd);
    let completions = 0;
    const writing = scenario === "write" || scenario === "reject";
    const base = setup({
      complete: (request) => {
        if (++completions === 1)
          return {
            kind: "tools",
            text: "Access file",
            calls: [
              {
                id: "file",
                name: writing ? "write_file" : "read_file",
                args: writing ? { path: "README.md", text: "editor write" } : { path: "README.md" },
              },
            ],
          };
        expect(JSON.stringify(request.messages)).toContain(
          writing
            ? "README.md"
            : scenario === "unsupported"
              ? "disk contents"
              : "unsaved editor contents",
        );
        return answer;
      },
    });
    const h = harness({
      ...base.options,
      sessionOptions: async (context) => {
        const original = await base.options.sessionOptions(context);
        expect(Boolean(context.clientFiles?.readText)).toBe(scenario !== "unsupported");
        expect(Boolean(context.clientFiles?.write)).toBe(writing);
        const tools = workspaceTools(files, context.clientFiles);
        return {
          ...original,
          configuration: {
            ...original.configuration,
            agents: new Map([["a", { model: "m", tools: [...tools.keys()] }]]),
          },
          bindings: { ...original.bindings, tools },
        };
      },
    });
    try {
      await h.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: scenario !== "unsupported", writeTextFile: writing },
        },
      });
      const id = (await h.request("session/new", { cwd, mcpServers: [] })).result.sessionId;
      const turn = await h.start("session/prompt", prompt(id));
      await until(() =>
        h.messages.some((message) => message.method === "session/request_permission"),
      );
      const permission = h.messages.find(
        (message) => message.method === "session/request_permission",
      )!;
      expect(permission.params.toolCall.locations).toEqual([
        { path: join(files.root, "README.md") },
      ]);
      expect(h.messages.some((message) => message.method?.startsWith("fs/"))).toBe(false);
      const option = permission.params.options.find(
        (value: any) => value.kind === (scenario === "reject" ? "reject_once" : "allow_once"),
      );
      await h.send({
        jsonrpc: "2.0",
        id: permission.id,
        result: { outcome: { outcome: "selected", optionId: option.optionId } },
      });
      if (scenario !== "reject" && scenario !== "unsupported") {
        await until(() => h.messages.some((message) => message.method?.startsWith("fs/")));
        const file = h.messages.find((message) => message.method?.startsWith("fs/"))!;
        expect(file.method).toBe(writing ? "fs/write_text_file" : "fs/read_text_file");
        expect(file.params).toEqual({
          sessionId: id,
          path: join(files.root, "README.md"),
          ...(writing ? { content: "editor write" } : {}),
        });
        if (scenario === "cancel")
          await h.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: id } });
        else
          await h.send({
            jsonrpc: "2.0",
            id: file.id,
            ...(scenario === "error"
              ? { error: { code: -32000, message: "Editor unavailable" } }
              : {
                  result: writing
                    ? {}
                    : {
                        content:
                          scenario === "oversize"
                            ? "x".repeat(MAX_FILE_BYTES + 1)
                            : "unsaved editor contents",
                      },
                }),
          });
      }
      const response = await h.response(turn);
      if (scenario === "error" || scenario === "oversize")
        expect(response.error?.code).toBe(-32000);
      else
        expect(response.result.stopReason).toBe(
          scenario === "reject" ? "refusal" : scenario === "cancel" ? "cancelled" : "end_turn",
        );
      if (scenario === "reject" || scenario === "unsupported")
        expect(h.messages.some((message) => message.method?.startsWith("fs/"))).toBe(false);
      expect(await readFile(join(cwd, "README.md"), "utf8")).toBe("disk contents");
    } finally {
      await h.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

for (const scenario of [
  "success",
  "reject",
  "cancel",
  "late_create",
  "failed_exit",
  "oversize",
  "release_error",
  "unsupported",
] as const) {
  test(`client terminal ${scenario} preserves permission, cancellation, and release`, async () => {
    const { terminalTool } = await import("./client-terminal.ts");
    let completions = 0;
    const base = setup({
      complete: (request) => {
        if (scenario === "unsupported") return answer;
        if (++completions === 1)
          return {
            kind: "tools",
            text: "Run checks",
            calls: [{ id: "cmd", name: "run_command", args: { command: "bun", args: ["test"] } }],
          };
        expect(JSON.stringify(request.messages)).toContain("test output");
        if (scenario === "failed_exit")
          expect(JSON.stringify(request.messages)).toMatch(/exitCode\\?":2/);
        return answer;
      },
    });
    const h = harness({
      ...base.options,
      sessionOptions: async (context) => {
        const original = await base.options.sessionOptions(context);
        expect(Boolean(context.terminal)).toBe(scenario !== "unsupported");
        const tools = context.terminal
          ? new Map([["run_command", terminalTool(context.terminal, context.cwd)]])
          : new Map();
        return {
          ...original,
          configuration: {
            ...original.configuration,
            agents: new Map([["a", { model: "m", tools: [...tools.keys()] }]]),
          },
          bindings: { ...original.bindings, tools },
        };
      },
    });
    const next = async (method: string) => {
      await until(() => h.messages.some((message) => message.method === method));
      return h.messages.find((message) => message.method === method)!;
    };
    const reply = (request: Message, result: unknown) =>
      h.send({ jsonrpc: "2.0", id: request.id, result });
    try {
      await h.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { terminal: scenario !== "unsupported" },
      });
      const id = await h.newSession();
      const turn = await h.start("session/prompt", prompt(id));
      if (scenario === "unsupported") {
        expect((await h.response(turn)).result.stopReason).toBe("end_turn");
        expect(h.messages.some((message) => message.method?.startsWith("terminal/"))).toBe(false);
        return;
      }
      const permission = await next("session/request_permission");
      expect(permission.params.toolCall.kind).toBe("execute");
      expect(h.messages.some((message) => message.method === "terminal/create")).toBe(false);
      const option = permission.params.options.find(
        (value: any) => value.kind === (scenario === "reject" ? "reject_once" : "allow_once"),
      );
      await reply(permission, { outcome: { outcome: "selected", optionId: option.optionId } });
      if (scenario === "reject") {
        expect((await h.response(turn)).result.stopReason).toBe("refusal");
        expect(h.messages.some((message) => message.method?.startsWith("terminal/"))).toBe(false);
        return;
      }
      const create = await next("terminal/create");
      expect(create.params).toEqual({
        sessionId: id,
        command: "bun",
        args: ["test"],
        cwd: "/tmp",
        outputByteLimit: 256 * 1024,
      });
      if (scenario === "late_create") {
        await h.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: id } });
        expect((await h.response(turn)).result.stopReason).toBe("cancelled");
      }
      await reply(create, { terminalId: "terminal-one" });
      if (scenario === "cancel" || scenario === "late_create") {
        if (scenario === "cancel") {
          await next("terminal/wait_for_exit");
          await h.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: id } });
        }
        await reply(await next("terminal/kill"), {});
      } else {
        await reply(await next("terminal/wait_for_exit"), {
          exitCode: scenario === "failed_exit" ? 2 : 0,
        });
        await reply(await next("terminal/output"), {
          output: scenario === "oversize" ? "x".repeat(256 * 1024 + 1) : "test output",
          truncated: false,
        });
      }
      const release = await next("terminal/release");
      expect(release.params).toEqual({ sessionId: id, terminalId: "terminal-one" });
      if (scenario === "release_error")
        await h.send({
          jsonrpc: "2.0",
          id: release.id,
          error: { code: -32000, message: "Release failed" },
        });
      else await reply(release, {});
      const response = await h.response(turn);
      if (scenario === "oversize" || scenario === "release_error")
        expect(response.error?.code).toBe(-32000);
      else {
        expect(response.error).toBeUndefined();
        expect(response.result.stopReason).toBe(
          scenario === "cancel" || scenario === "late_create" ? "cancelled" : "end_turn",
        );
      }
      expect(h.messages.filter((message) => message.method === "terminal/release")).toHaveLength(1);
      if (scenario === "cancel" || scenario === "late_create") expect(completions).toBe(1);
      if (scenario === "late_create")
        expect(
          h
            .updates()
            .some(
              (message) =>
                message.update.sessionUpdate === "tool_call_update" &&
                message.update.content?.some((content) => content.type === "terminal"),
            ),
        ).toBe(false);
    } finally {
      await h.close();
    }
  });
}

test("parallel terminal IDs stay attached to their own tool cards through final output", async () => {
  const { terminalTool } = await import("./client-terminal.ts");
  const { SessionIdSchema } = await import("@labkit-agent/core/types");
  let completions = 0;
  const base = setup({
    complete: () =>
      ++completions === 1
        ? {
            kind: "tools",
            text: "Two commands",
            calls: [
              { id: "first", name: "run_command", args: { command: "bun", args: ["first"] } },
              { id: "second", name: "run_command", args: { command: "bun", args: ["second"] } },
            ],
          }
        : answer,
  });
  const h = harness({
    ...base.options,
    sessionOptions: async (context) => {
      const original = await base.options.sessionOptions(context);
      return {
        ...original,
        configuration: {
          ...original.configuration,
          agents: new Map([["a", { model: "m", tools: ["run_command"] }]]),
        },
        bindings: {
          ...original.bindings,
          tools: new Map([["run_command", terminalTool(context.terminal!, context.cwd)]]),
        },
      };
    },
  });
  const requests = (method: string) => h.messages.filter((message) => message.method === method);
  const reply = (request: Message, result: unknown) =>
    h.send({ jsonrpc: "2.0", id: request.id, result });
  try {
    await h.request("initialize", { protocolVersion: 1, clientCapabilities: { terminal: true } });
    const id = await h.newSession();
    const turn = await h.start("session/prompt", prompt(id));
    for (let i = 0; i < 2; i++) {
      await until(() => requests("session/request_permission").length > i);
      const permission = requests("session/request_permission")[i]!;
      const allow = permission.params.options.find((value: any) => value.kind === "allow_once");
      await reply(permission, { outcome: { outcome: "selected", optionId: allow.optionId } });
    }
    await until(() => requests("terminal/create").length === 2);
    for (const create of requests("terminal/create").toReversed())
      await reply(create, { terminalId: `ephemeral-terminal-${create.params.args[0]}` });
    await until(() => requests("terminal/wait_for_exit").length === 2);
    for (const label of ["first", "second"]) {
      const toolCall = h
        .updates()
        .find(
          (message) =>
            message.update.sessionUpdate === "tool_call" &&
            (message.update.rawInput as any).args[0] === label,
        )!.update;
      if (toolCall.sessionUpdate !== "tool_call") throw new Error("Missing tool call");
      expect(
        h
          .updates()
          .some(
            (message) =>
              message.update.sessionUpdate === "tool_call_update" &&
              message.update.toolCallId === toolCall.toolCallId &&
              message.update.content?.some(
                (content) =>
                  content.type === "terminal" &&
                  content.terminalId === `ephemeral-terminal-${label}`,
              ),
          ),
      ).toBe(true);
    }
    for (const wait of requests("terminal/wait_for_exit")) await reply(wait, { exitCode: 0 });
    await until(() => requests("terminal/output").length === 2);
    for (const output of requests("terminal/output"))
      await reply(output, { output: "completed", truncated: false });
    await until(() => requests("terminal/release").length === 2);
    for (const release of requests("terminal/release")) await reply(release, {});
    expect((await h.response(turn)).result.stopReason).toBe("end_turn");
    for (const label of ["first", "second"]) {
      const toolCall = h
        .updates()
        .find(
          (message) =>
            message.update.sessionUpdate === "tool_call" &&
            (message.update.rawInput as any).args[0] === label,
        )!.update;
      if (toolCall.sessionUpdate !== "tool_call") throw new Error("Missing tool call");
      const settled = h
        .updates()
        .find(
          (message) =>
            message.update.sessionUpdate === "tool_call_update" &&
            message.update.toolCallId === toolCall.toolCallId &&
            message.update.status === "completed",
        )!.update;
      expect(settled).toMatchObject({
        content: [
          { type: "terminal", terminalId: `ephemeral-terminal-${label}` },
          { type: "content", content: { type: "text" } },
        ],
      });
    }
    const journal = await base.persistence.load(
      SessionIdSchema.parse(id),
      new AbortController().signal,
    );
    expect(JSON.stringify(journal)).not.toContain("ephemeral-terminal-");
  } finally {
    await h.close();
  }
});

test("plan notifications replace the complete list, clear explicitly, and use the ordinary journaled tool path", async () => {
  const { planTool } = await import("./plan.ts");
  const { SessionIdSchema } = await import("@labkit-agent/core/types");
  const plans: PlanEntries[] = [
    [
      { content: "Inspect files", priority: "high", status: "in_progress" },
      { content: "Summarize", priority: "medium", status: "pending" },
    ],
    [{ content: "Inspect files", priority: "high", status: "completed" }],
    [],
  ];
  let calls = 0;
  const base = setup({
    complete: () =>
      calls < plans.length
        ? {
            kind: "tools",
            text: "Update plan",
            calls: [
              { id: `plan-${calls}`, name: "update_plan", args: { entries: plans[calls++] } },
            ],
          }
        : answer,
  });
  const h = harness({
    ...base.options,
    sessionOptions: async (context) => {
      const original = await base.options.sessionOptions(context);
      return {
        ...original,
        configuration: {
          ...original.configuration,
          steps: 5,
          agents: new Map([["a", { model: "m", tools: ["update_plan"] }]]),
        },
        bindings: {
          ...original.bindings,
          tools: new Map([["update_plan", planTool(context.publishPlan!)]]),
        },
      };
    },
  });
  try {
    await h.initialize();
    const id = await h.newSession();
    const turn = await h.start("session/prompt", prompt(id));
    for (let index = 0; index < plans.length; index++) {
      await until(
        () =>
          h.messages.filter((message) => message.method === "session/request_permission").length >
          index,
      );
      expect(h.updates().filter((message) => message.update.sessionUpdate === "plan")).toHaveLength(
        index,
      );
      const permission = h.messages.filter(
        (message) => message.method === "session/request_permission",
      )[index]!;
      expect(permission.params.toolCall.kind).toBe("think");
      const allow = permission.params.options.find((value: any) => value.kind === "allow_once");
      await h.send({
        jsonrpc: "2.0",
        id: permission.id,
        result: { outcome: { outcome: "selected", optionId: allow.optionId } },
      });
    }
    expect((await h.response(turn)).result.stopReason).toBe("end_turn");
    expect(
      h
        .updates()
        .filter((message) => message.update.sessionUpdate === "plan")
        .map((message) => message.update),
    ).toEqual(plans.map((entries) => ({ sessionUpdate: "plan", entries })));
    const journal = await base.persistence.load(
      SessionIdSchema.parse(id),
      new AbortController().signal,
    );
    expect(JSON.stringify(journal)).toContain("Inspect files");
  } finally {
    await h.close();
  }
});

test("commands are discovered on new/load and expand once before journal admission while retaining attachments", async () => {
  const { SessionIdSchema } = await import("@labkit-agent/core/types");
  const commands = [
    {
      name: "review",
      description: "Review contents",
      input: { hint: "focus" },
      prompt: "REVIEW_TEMPLATE_ORIGINAL",
    },
  ];
  let requestText = "";
  const { openaiChat } = await import("@labkit-agent/core/providers");
  const base = setup();
  const options: AcpOptions = {
    ...base.options,
    sessionOptions: async (context) => {
      const original = await base.options.sessionOptions(context);
      return {
        ...original,
        commands,
        configuration: {
          ...original.configuration,
          policy: { maxOutputTokens: 16384, provider: openaiChat.id },
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
                  baseUrl: "https://provider.invalid",
                  fetch: (async (_url, init) => {
                    requestText = String(init?.body);
                    return Response.json({ choices: [{ message: { content: "Done" } }] });
                  }) as typeof fetch,
                },
              },
            ],
          ]),
        },
      };
    },
  };
  let h = harness(options);
  try {
    await h.initialize();
    const id = await h.newSession();
    expect(
      h.updates().find((message) => message.update.sessionUpdate === "available_commands_update")
        ?.update,
    ).toEqual({
      sessionUpdate: "available_commands_update",
      availableCommands: [
        { name: "review", description: "Review contents", input: { hint: "focus" } },
      ],
    });
    commands[0]!.prompt = "REVIEW_TEMPLATE_REVISED";
    const response = await h.request("session/prompt", {
      sessionId: id,
      prompt: [
        { type: "text", text: "/review invariants" },
        {
          type: "resource",
          resource: {
            uri: "untitled:design.md",
            mimeType: "text/markdown",
            text: "draft contents",
          },
        },
      ],
    });
    expect(response.result.stopReason).toBe("end_turn");
    expect(requestText).toContain("REVIEW_TEMPLATE_ORIGINAL");
    expect(requestText).not.toContain("REVIEW_TEMPLATE_REVISED");
    expect(requestText).toContain("invariants");
    const journal = await base.persistence.load(
      SessionIdSchema.parse(id),
      new AbortController().signal,
    );
    if (journal.kind !== "loaded") throw new Error("Missing journal");
    const records = journal.batches.flatMap((batch) =>
      batch.records.map((record) => JSON.parse(record)),
    );
    const admitted = records.find(
      (record) => record.body.kind === "event" && record.body.event.type === "user",
    ).body.event;
    expect(admitted.text).toContain("REVIEW_TEMPLATE_ORIGINAL");
    expect(admitted.attachments).toHaveLength(1);
    expect(JSON.stringify(journal)).not.toContain("draft contents");
    await h.close();
    h = harness(options);
    await h.initialize();
    expect(
      (await h.request("session/load", { sessionId: id, cwd: "/tmp", mcpServers: [] })).error,
    ).toBeUndefined();
    expect(
      h.updates().some((message) => message.update.sessionUpdate === "available_commands_update"),
    ).toBe(true);
    const replay = JSON.stringify(
      h.updates().filter((message) => message.update.sessionUpdate === "user_message_chunk"),
    );
    expect(replay).toContain("REVIEW_TEMPLATE_ORIGINAL");
    expect(replay).not.toContain("REVIEW_TEMPLATE_REVISED");
  } finally {
    await h.close();
  }
});

test("unbound attachment media is rejected before blob storage or user admission", async () => {
  const base = setup();
  let puts = 0;
  const h = harness({
    ...base.options,
    sessionOptions: async (context) => ({
      ...(await base.options.sessionOptions(context)),
      persistence: {
        ...base.persistence,
        putBlob: async (...args) => {
          puts++;
          return base.persistence.putBlob(...args);
        },
      },
    }),
  });
  try {
    await h.initialize();
    const id = await h.newSession();
    const response = await h.request("session/prompt", {
      sessionId: id,
      prompt: [{ type: "resource", resource: { uri: "urn:text", text: "unsupported text" } }],
    });
    expect(response.error?.code).toBe(-32602);
    expect(puts).toBe(0);
    const { SessionIdSchema } = await import("@labkit-agent/core/types");
    const journal = await base.persistence.load(
      SessionIdSchema.parse(id),
      new AbortController().signal,
    );
    expect(
      journal.kind === "loaded" && journal.batches.flatMap((batch) => batch.records).length,
    ).toBe(1);
  } finally {
    await h.close();
  }
});

test("ACP fork copies attachment history into an independent restorable child without provider replay", async () => {
  const { openaiChat } = await import("@labkit-agent/core/providers");
  const { SessionIdSchema } = await import("@labkit-agent/core/types");
  const base = setup();
  const bodies: string[] = [];
  const options: AcpOptions = {
    ...base.options,
    forkSession: true,
    sessionOptions: async (context) => {
      const original = await base.options.sessionOptions(context);
      return {
        ...original,
        configuration: {
          ...original.configuration,
          policy: { maxOutputTokens: 16384, provider: openaiChat.id },
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
                  baseUrl: "https://provider.invalid",
                  fetch: (async (_url, init) => {
                    bodies.push(String(init?.body));
                    return Response.json({ choices: [{ message: { content: "Done" } }] });
                  }) as typeof fetch,
                },
              },
            ],
          ]),
        },
      };
    },
  };
  let h = harness(options);
  try {
    expect((await h.initialize()).result.agentCapabilities.sessionCapabilities.fork).toEqual({});
    const parent = await h.newSession();
    expect(
      (
        await h.request("session/prompt", {
          sessionId: parent,
          prompt: [
            { type: "text", text: "parent question" },
            {
              type: "resource",
              resource: { uri: "urn:design", text: "inherited design contents" },
            },
          ],
        })
      ).result.stopReason,
    ).toBe("end_turn");
    const fork = await h.request("session/fork", { sessionId: parent, cwd: "/tmp" });
    expect(fork.error).toBeUndefined();
    const child = fork.result.sessionId;
    expect(child).not.toBe(parent);
    expect(bodies).toHaveLength(1);
    expect(
      (
        await h.request("session/prompt", {
          sessionId: child,
          prompt: [{ type: "text", text: "child-only question" }],
        })
      ).result.stopReason,
    ).toBe("end_turn");
    expect(bodies[1]).toContain("parent question");
    expect(bodies[1]).toContain("inherited design contents");
    expect(
      (
        await h.request("session/prompt", {
          sessionId: parent,
          prompt: [{ type: "text", text: "parent followup" }],
        })
      ).result.stopReason,
    ).toBe("end_turn");
    expect(bodies[2]).not.toContain("child-only question");
    const loaded = await base.persistence.load(
      SessionIdSchema.parse(child),
      new AbortController().signal,
    );
    if (loaded.kind !== "loaded") throw new Error("Missing child");
    const seed = JSON.parse(loaded.batches[0]!.records[0]!).body.seed;
    expect(JSON.stringify(seed)).toContain(parent);
    expect(JSON.stringify(loaded)).not.toContain("inherited design contents");
    await h.close();
    h = harness(options);
    await h.initialize();
    expect(
      (await h.request("session/load", { sessionId: child, cwd: "/tmp", mcpServers: [] })).error,
    ).toBeUndefined();
    expect(bodies).toHaveLength(3);
    expect((await h.request("session/prompt", prompt(child))).result.stopReason).toBe("end_turn");
    expect(bodies[3]).toContain("inherited design contents");
    expect(bodies[3]).toContain("child-only question");
  } finally {
    await h.close();
  }
});

test("ACP fork waits for child creation receipt and inherits committed configuration", async () => {
  const base = configurable();
  const gate = deferred<void>();
  let parent = "";
  let childAppend = false;
  const h = harness({
    ...base.options,
    forkSession: true,
    sessionOptions: async (context) => ({
      ...(await base.options.sessionOptions(context)),
      persistence: {
        ...base.persistence,
        append: async (request, signal) => {
          if (parent && request.sessionId !== parent && request.expectedRevision === 0) {
            childAppend = true;
            await gate.promise;
          }
          return base.persistence.append(request, signal);
        },
      },
    }),
  });
  try {
    await h.initialize();
    parent = await h.newSession();
    expect(
      (
        await h.request("session/set_config_option", {
          sessionId: parent,
          configId: "model",
          value: "m2",
        })
      ).error,
    ).toBeUndefined();
    const fork = await h.start("session/fork", { sessionId: parent, cwd: "/tmp" });
    await until(() => childAppend);
    expect(h.messages.some((message) => message.id === fork && !message.method)).toBe(false);
    gate.resolve();
    const response = await h.response(fork);
    expect(response.error).toBeUndefined();
    expect(
      response.result.configOptions.find((option: any) => option.id === "model").currentValue,
    ).toBe("m2");
    expect(
      (await h.request("session/prompt", prompt(response.result.sessionId))).result.stopReason,
    ).toBe("end_turn");
    expect(base.requests.at(-1)?.model).toBe("m2");
  } finally {
    gate.resolve();
    await h.close();
  }
});

test("ACP fork waits for a running turn and rejects workspace or MCP changes before forking", async () => {
  const gate = deferred<unknown>();
  let started = false;
  const base = setup({
    complete: () => {
      started = true;
      return gate.promise;
    },
  });
  const h = harness({ ...base.options, forkSession: true });
  try {
    await h.initialize();
    const parent = await h.newSession();
    for (const params of [
      { cwd: "/other" },
      { cwd: "/tmp", additionalDirectories: ["/other"] },
      { cwd: "/tmp", mcpServers: [{ name: "x", command: "missing", args: [], env: [] }] },
    ])
      expect((await h.request("session/fork", { sessionId: parent, ...params })).error?.code).toBe(
        -32602,
      );
    const turn = await h.start("session/prompt", prompt(parent));
    await until(() => started);
    const fork = await h.start("session/fork", { sessionId: parent, cwd: "/tmp" });
    expect(h.messages.some((message) => message.id === fork && !message.method)).toBe(false);
    gate.resolve(answer);
    expect((await h.response(turn)).result.stopReason).toBe("end_turn");
    expect((await h.response(fork)).error).toBeUndefined();
  } finally {
    gate.resolve(answer);
    await h.close();
  }
});

test("cancelling a queued fork creates no child after the active turn settles", async () => {
  const gate = deferred<unknown>();
  let started = false;
  let parent = "";
  let childCreates = 0;
  const base = setup({
    complete: () => {
      started = true;
      return gate.promise;
    },
  });
  const h = harness({
    ...base.options,
    forkSession: true,
    sessionOptions: async (context) => ({
      ...(await base.options.sessionOptions(context)),
      persistence: {
        ...base.persistence,
        append: async (request, signal) => {
          if (parent && request.sessionId !== parent) childCreates++;
          return base.persistence.append(request, signal);
        },
      },
    }),
  });
  try {
    await h.initialize();
    parent = await h.newSession();
    const turn = await h.start("session/prompt", prompt(parent));
    await until(() => started);
    const fork = await h.start("session/fork", { sessionId: parent, cwd: "/tmp" });
    await h.send({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: fork } });
    expect((await h.response(fork)).error).toBeDefined();
    gate.resolve(answer);
    await h.response(turn);
    expect((await h.request("session/prompt", prompt(parent))).result.stopReason).toBe("end_turn");
    expect(childCreates).toBe(0);
  } finally {
    gate.resolve(answer);
    await h.close();
  }
});

test("rejected child creation returns no fork and leaves the parent usable", async () => {
  const base = setup();
  let parent = "";
  const h = harness({
    ...base.options,
    forkSession: true,
    sessionOptions: async (context) => ({
      ...(await base.options.sessionOptions(context)),
      persistence: {
        ...base.persistence,
        append: async (request, signal) =>
          parent && request.sessionId !== parent
            ? { kind: "rejected", message: "Child storage unavailable" }
            : base.persistence.append(request, signal),
      },
    }),
  });
  try {
    await h.initialize();
    parent = await h.newSession();
    const fork = await h.request("session/fork", { sessionId: parent, cwd: "/tmp" });
    expect(fork.error).toBeDefined();
    expect(fork.result).toBeUndefined();
    expect((await h.request("session/prompt", prompt(parent))).result.stopReason).toBe("end_turn");
  } finally {
    await h.close();
  }
});

test("saved sessions fork without loading or replaying the parent into the client", async () => {
  const base = setup();
  let runs = 0;
  const options: AcpOptions = {
    ...base.options,
    forkSession: true,
    sessionOptions: async (context) => {
      const original = await base.options.sessionOptions(context);
      return {
        ...original,
        commands: [{ name: "review", description: "Review", prompt: "Review" }],
        bindings: {
          ...original.bindings,
          complete: () => {
            runs++;
            return answer;
          },
        },
      };
    },
  };
  let h = harness(options);
  try {
    await h.initialize();
    const parent = await h.newSession();
    expect((await h.request("session/prompt", prompt(parent))).result.stopReason).toBe("end_turn");
    await h.close();
    h = harness(options);
    await h.initialize();
    const fork = await h.request("session/fork", { sessionId: parent, cwd: "/tmp" });
    expect(fork.error).toBeUndefined();
    expect(fork.result.sessionId).not.toBe(parent);
    expect(runs).toBe(1);
    expect(h.updates().some((message) => message.sessionId === parent)).toBe(false);
    expect(
      h.updates().every((message) => message.update.sessionUpdate === "available_commands_update"),
    ).toBe(true);
    expect((await h.request("session/prompt", prompt(parent))).error?.code).toBe(-32602);
    expect(
      (await h.request("session/prompt", prompt(fork.result.sessionId))).result.stopReason,
    ).toBe("end_turn");
    expect(
      (await h.request("session/load", { sessionId: parent, cwd: "/tmp", mcpServers: [] })).error,
    ).toBeUndefined();
    expect(runs).toBe(2);
  } finally {
    await h.close();
  }
});

test("a privately restored fork parent is unavailable to concurrent requests and is released after publication", async () => {
  const base = setup();
  let parent = "";
  let entered = false;
  const gate = deferred<void>();
  const options: AcpOptions = {
    ...base.options,
    forkSession: true,
    sessionOptions: async (context) => ({
      ...(await base.options.sessionOptions(context)),
      persistence: {
        ...base.persistence,
        append: async (request, signal) => {
          if (parent && request.sessionId !== parent && request.expectedRevision === 0) {
            entered = true;
            await gate.promise;
          }
          return base.persistence.append(request, signal);
        },
      },
    }),
  };
  let h = harness(options);
  try {
    await h.initialize();
    parent = await h.newSession();
    await h.close();
    h = harness(options);
    await h.initialize();
    const fork = await h.start("session/fork", { sessionId: parent, cwd: "/tmp" });
    await until(() => entered);
    expect((await h.request("session/prompt", prompt(parent))).error?.code).toBe(-32602);
    expect((await h.request("session/fork", { sessionId: parent, cwd: "/tmp" })).error?.code).toBe(
      -32602,
    );
    expect(
      (await h.request("session/load", { sessionId: parent, cwd: "/tmp", mcpServers: [] })).error
        ?.code,
    ).toBe(-32602);
    gate.resolve();
    expect((await h.response(fork)).error).toBeUndefined();
    expect(
      (await h.request("session/load", { sessionId: parent, cwd: "/tmp", mcpServers: [] })).error,
    ).toBeUndefined();
  } finally {
    gate.resolve();
    await h.close();
  }
});

test("cancelling private parent setup returns promptly and cannot later expose that runtime", async () => {
  const base = setup();
  const seed = harness(base.options);
  await seed.initialize();
  const parent = await seed.newSession();
  await seed.close();
  const gate = deferred<void>();
  let entered = false;
  const h = harness({
    ...base.options,
    forkSession: true,
    sessionOptions: async (context) => {
      entered = true;
      await gate.promise;
      return base.options.sessionOptions(context);
    },
  });
  try {
    await h.initialize();
    const fork = await h.start("session/fork", { sessionId: parent, cwd: "/tmp" });
    await until(() => entered);
    await h.send({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: fork } });
    expect((await h.response(fork)).error).toBeDefined();
    gate.resolve();
    expect((await h.request("session/prompt", prompt(parent))).error?.code).toBe(-32602);
    expect(h.updates()).toHaveLength(0);
  } finally {
    gate.resolve();
    await h.close();
  }
});

test("ACP deletion closes active work, holds its response until persistence completes, and blocks concurrent reopen", async () => {
  const completion = deferred<unknown>();
  const deletion = deferred<void>();
  let entered = false;
  let completionSignal: AbortSignal | undefined;
  let deleted: { sessionId: string; cwd?: string } | undefined;
  const base = setup({
    complete: (_request, signal) => {
      completionSignal = signal;
      return completion.promise;
    },
  });
  const h = harness({
    ...base.options,
    deleteSession: async (params) => {
      deleted = params;
      entered = true;
      await deletion.promise;
    },
  });
  try {
    expect((await h.initialize()).result.agentCapabilities.sessionCapabilities.delete).toEqual({});
    const id = await h.newSession();
    const turn = await h.start("session/prompt", prompt(id));
    await until(() => !!completionSignal);
    const remove = await h.start("session/delete", { sessionId: id });
    await until(() => entered);
    expect(completionSignal!.aborted).toBe(true);
    expect(deleted).toEqual({ sessionId: id, cwd: "/tmp" });
    expect((await h.response(turn)).result.stopReason).toBe("cancelled");
    expect(h.messages.some((message) => message.id === remove && !message.method)).toBe(false);
    expect(
      (await h.request("session/load", { sessionId: id, cwd: "/tmp", mcpServers: [] })).error?.code,
    ).toBe(-32602);
    expect((await h.request("session/delete", { sessionId: id })).error?.code).toBe(-32602);
    deletion.resolve();
    expect((await h.response(remove)).result).toEqual({});
    expect((await h.request("session/prompt", prompt(id))).error?.code).toBe(-32602);
  } finally {
    completion.resolve(answer);
    deletion.resolve();
    await h.close();
  }
});

test("ACP workspace deletion removes saved sessions and rejects load and fork", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { workspaceDirectory } = await import("./workspace-directory.ts");
  const { workspacePersistence } = await import("./workspace-persistence.ts");
  const cwd = mkdtempSync(join(tmpdir(), "labkit-acp-delete-"));
  const directory = workspaceDirectory(cwd);
  const store = workspacePersistence(cwd);
  const base = setup();
  const options: AcpOptions = {
    ...base.options,
    forkSession: true,
    listSessions: (params, signal) => directory.list(params, signal),
    deleteSession: (params, signal) => directory.deleteSession(params, signal),
    sessionOptions: async (context) => ({
      ...(await base.options.sessionOptions(context)),
      persistence: store,
    }),
  };
  let h = harness(options);
  try {
    await h.initialize();
    const id = (await h.request("session/new", { cwd, mcpServers: [] })).result.sessionId;
    await h.close();
    h = harness(options);
    await h.initialize();
    expect((await h.request("session/list", {})).result.sessions).toHaveLength(1);
    expect((await h.request("session/delete", { sessionId: id })).result).toEqual({});
    expect((await h.request("session/list", {})).result.sessions).toHaveLength(0);
    expect(
      (await h.request("session/load", { sessionId: id, cwd, mcpServers: [] })).error,
    ).toBeDefined();
    expect((await h.request("session/fork", { sessionId: id, cwd })).error).toBeDefined();
    expect((await h.request("session/delete", { sessionId: id })).result).toEqual({});
  } finally {
    await h.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("cancelled deletion keeps its lifecycle lock until the persistence hook settles", async () => {
  const base = setup();
  const gate = deferred<void>();
  let entered = false;
  const h = harness({
    ...base.options,
    deleteSession: async () => {
      entered = true;
      await gate.promise;
    },
  });
  try {
    await h.initialize();
    const id = await h.newSession();
    const remove = await h.start("session/delete", { sessionId: id });
    await until(() => entered);
    await h.send({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: remove } });
    expect((await h.response(remove)).error).toBeDefined();
    expect(
      (await h.request("session/load", { sessionId: id, cwd: "/tmp", mcpServers: [] })).error?.code,
    ).toBe(-32602);
    gate.reject(new Error("Deletion did not commit"));
    // A later unrelated round-trip allows the already-settled hook cleanup to run.
    await h.request("unknown", {});
    expect(
      (await h.request("session/load", { sessionId: id, cwd: "/tmp", mcpServers: [] })).error,
    ).toBeUndefined();
  } finally {
    gate.resolve();
    await h.close();
  }
});

test("workspace session info notifications match persisted titles and timestamps", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { workspacePersistence } = await import("./workspace-persistence.ts");
  const { workspaceDirectory } = await import("./workspace-directory.ts");
  const cwd = mkdtempSync(join(tmpdir(), "labkit-info-"));
  const store = workspacePersistence(cwd);
  const directory = workspaceDirectory(cwd);
  const base = setup();
  const h = harness({
    ...base.options,
    sessionInfo: (params, signal) => directory.info(params, signal),
    sessionOptions: async (context) => ({
      ...(await base.options.sessionOptions(context)),
      persistence: store,
    }),
  });
  try {
    await h.initialize();
    const id = (await h.request("session/new", { cwd, mcpServers: [] })).result.sessionId;
    await until(() =>
      h.updates().some((message) => message.update.sessionUpdate === "session_info_update"),
    );
    expect(
      h.updates().find((message) => message.update.sessionUpdate === "session_info_update")!.update,
    ).toMatchObject({ title: null });
    expect(
      (
        await h.request("session/prompt", {
          sessionId: id,
          prompt: [{ type: "text", text: "  Review\nworkspace metadata  " }],
        })
      ).result.stopReason,
    ).toBe("end_turn");
    await until(() =>
      h
        .updates()
        .some(
          (message) =>
            message.update.sessionUpdate === "session_info_update" &&
            message.update.title === "Review workspace metadata",
        ),
    );
    const last = h
      .updates()
      .filter((message) => message.update.sessionUpdate === "session_info_update")
      .at(-1)!.update;
    const metadata = directory.list({}, new AbortController().signal).sessions[0]!;
    expect(last).toEqual({
      sessionUpdate: "session_info_update",
      title: metadata.title!,
      updatedAt: metadata.updatedAt!,
    });
  } finally {
    await h.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("stale and closed-session metadata replies cannot overwrite current session info", async () => {
  const first = deferred<{ title: string }>();
  const last = deferred<{ title: string }>();
  let reads = 0;
  const base = setup();
  const h = harness({
    ...base.options,
    sessionInfo: () =>
      ++reads === 1 ? first.promise : reads === 2 ? { title: "current" } : last.promise,
  });
  try {
    await h.initialize();
    const id = await h.newSession();
    expect((await h.request("session/prompt", prompt(id))).result.stopReason).toBe("end_turn");
    await until(() =>
      h
        .updates()
        .some(
          (message) =>
            message.update.sessionUpdate === "session_info_update" &&
            message.update.title === "current",
        ),
    );
    first.resolve({ title: "stale" });
    expect((await h.request("session/prompt", prompt(id))).result.stopReason).toBe("end_turn");
    await h.request("session/close", { sessionId: id });
    last.resolve({ title: "closed" });
    await h.request("unknown", {});
    expect(
      h
        .updates()
        .filter((message) => message.update.sessionUpdate === "session_info_update")
        .map((message) => message.update),
    ).toEqual([{ sessionUpdate: "session_info_update", title: "current" }]);
  } finally {
    first.resolve({ title: "stale" });
    last.resolve({ title: "closed" });
    await h.close();
  }
});

test("throwing, rejected, pending, and malformed metadata callbacks do not fail or hold prompts", async () => {
  for (const sessionInfo of [
    () => {
      throw new Error("Metadata failed");
    },
    () => Promise.reject(new Error("Metadata failed")),
    () => new Promise<undefined>(() => {}),
    () => ({ updatedAt: "not a timestamp" }),
  ]) {
    const h = harness({ ...setup().options, sessionInfo });
    try {
      await h.initialize();
      const id = await h.newSession();
      expect((await h.request("session/prompt", prompt(id))).result.stopReason).toBe("end_turn");
      expect(
        h.updates().some((message) => message.update.sessionUpdate === "session_info_update"),
      ).toBe(false);
    } finally {
      await h.close();
    }
  }
});

test("workspace roots survive listing restart, replace on load/resume, and fork independently", async () => {
  const { mkdtempSync, mkdirSync, realpathSync, rmSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { workspaceAgent } = await import("./examples/vscode-workspace.ts");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "labkit-acp-roots-")));
  const cwd = join(root, "primary");
  const a = join(root, "a");
  const b = join(root, "b");
  for (const path of [cwd, a, b]) mkdirSync(path);
  const make = () =>
    workspaceAgent({ ANTHROPIC_API_KEY: "fixture", LABKIT_ACP_MODEL: "fixture-model" });
  let h = harness(make());
  try {
    expect(
      (await h.initialize()).result.agentCapabilities.sessionCapabilities.additionalDirectories,
    ).toEqual({});
    expect(
      (await h.request("session/new", { cwd, mcpServers: [], additionalDirectories: ["relative"] }))
        .error?.code,
    ).toBe(-32602);
    const opened = await h.request("session/new", {
      cwd,
      mcpServers: [],
      additionalDirectories: [a],
    });
    expect(opened.error).toBeUndefined();
    const id = opened.result.sessionId;
    const rows = async () =>
      (await h.request("session/list", { cwd })).result.sessions as {
        sessionId: string;
        additionalDirectories?: string[];
      }[];
    expect((await rows())[0]?.additionalDirectories).toEqual([a]);
    await h.close();
    h = harness(make());
    await h.initialize();
    expect((await rows())[0]?.additionalDirectories).toEqual([a]);
    expect(
      (
        await h.request("session/load", {
          sessionId: id,
          cwd,
          mcpServers: [],
          additionalDirectories: [b],
        })
      ).error,
    ).toBeUndefined();
    expect((await rows())[0]?.additionalDirectories).toEqual([b]);
    const fork = await h.request("session/fork", {
      sessionId: id,
      cwd,
      additionalDirectories: [a],
    });
    expect(fork.error).toBeUndefined();
    expect((await rows()).find((row) => row.sessionId === id)?.additionalDirectories).toEqual([b]);
    expect(
      (await rows()).find((row) => row.sessionId === fork.result.sessionId)?.additionalDirectories,
    ).toEqual([a]);
    await h.request("session/close", { sessionId: id });
    expect(
      (await h.request("session/resume", { sessionId: id, cwd, mcpServers: [] })).error,
    ).toBeUndefined();
    expect(
      (await rows()).find((row) => row.sessionId === id)?.additionalDirectories,
    ).toBeUndefined();
    await h.request("session/close", { sessionId: id });
    const savedFork = await h.request("session/fork", {
      sessionId: id,
      cwd,
      mcpServers: [],
      additionalDirectories: [b],
    });
    expect(savedFork.error).toBeUndefined();
    expect(
      (await rows()).find((row) => row.sessionId === id)?.additionalDirectories,
    ).toBeUndefined();
    expect(
      (await rows()).find((row) => row.sessionId === savedFork.result.sessionId)
        ?.additionalDirectories,
    ).toEqual([b]);
    expect(existsSync(join(cwd, ".labkit/sessions/store.sqlite"))).toBe(true);
    expect(existsSync(join(a, ".labkit"))).toBe(false);
    expect(existsSync(join(b, ".labkit"))).toBe(false);
  } finally {
    await h.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("lifecycle publication waits for metadata and failed or cancelled hooks cannot publish", async () => {
  const base = setup();
  const gate = deferred<void>();
  let entered = false;
  let id: string | undefined;
  let fail = false;
  const h = harness({
    ...base.options,
    sessionOptions: async (context) => ({
      ...(await base.options.sessionOptions(context)),
      onReady: async (sessionId) => {
        id = sessionId;
        entered = true;
        await gate.promise;
        if (fail) throw new Error("metadata failed");
      },
    }),
  });
  try {
    await h.initialize();
    const open = await h.start("session/new", { cwd: "/tmp", mcpServers: [] });
    await until(() => entered);
    expect(h.messages.some((message) => message.id === open && !message.method)).toBe(false);
    expect((await h.request("session/prompt", prompt(id!))).error).toBeDefined();
    expect(
      (await h.request("session/load", { sessionId: id, cwd: "/tmp", mcpServers: [] })).error?.code,
    ).toBe(-32602);
    await h.send({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: open } });
    expect((await h.response(open)).error).toBeDefined();
    gate.resolve();
    fail = true;
    expect(
      (await h.request("session/load", { sessionId: id, cwd: "/tmp", mcpServers: [] })).error?.code,
    ).toBe(-32603);
    fail = false;
    expect(
      (await h.request("session/load", { sessionId: id, cwd: "/tmp", mcpServers: [] })).error,
    ).toBeUndefined();
    expect((await h.request("session/prompt", prompt(id!))).result.stopReason).toBe("end_turn");
  } finally {
    gate.resolve();
    await h.close();
  }
});

test("ACP admits an additional-root resource as a blob and passes its contents through the provider", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { openaiChat } = await import("@labkit-agent/core/providers");
  const { SessionIdSchema } = await import("@labkit-agent/core/types");
  const root = mkdtempSync(join(tmpdir(), "labkit-acp-root-blob-"));
  const cwd = join(root, "primary");
  const extra = join(root, "extra");
  mkdirSync(cwd);
  mkdirSync(extra);
  const path = join(extra, "DESIGN.md");
  const body = "extra workspace document bytes";
  writeFileSync(path, body);
  const base = setup();
  let calls = 0;
  const h = harness({
    ...base.options,
    additionalDirectories: true,
    sessionOptions: async (context) => {
      expect(context.additionalDirectories).toEqual([extra]);
      const options = await base.options.sessionOptions(context);
      return {
        ...options,
        configuration: {
          ...options.configuration,
          policy: { maxOutputTokens: 16384, provider: openaiChat.id },
        },
        bindings: {
          ...options.bindings,
          complete: undefined,
          providers: new Map([
            [
              openaiChat.id,
              {
                profile: openaiChat,
                transport: {
                  baseUrl: "https://provider.invalid/v1",
                  fetch: (async (_url, init) => {
                    calls++;
                    expect(String(init?.body)).toContain(body);
                    return Response.json({ choices: [{ message: { content: "Done" } }] });
                  }) as typeof fetch,
                },
              },
            ],
          ]),
        },
      };
    },
  });
  try {
    await h.initialize();
    const id = (
      await h.request("session/new", { cwd, additionalDirectories: [extra], mcpServers: [] })
    ).result.sessionId;
    expect(
      (
        await h.request("session/prompt", {
          sessionId: id,
          prompt: [{ type: "resource_link", name: "DESIGN.md", uri: path }],
        })
      ).result.stopReason,
    ).toBe("end_turn");
    expect(calls).toBe(1);
    const loaded = await base.persistence.load(
      SessionIdSchema.parse(id),
      new AbortController().signal,
    );
    expect(loaded.kind).toBe("loaded");
    expect(JSON.stringify(loaded)).not.toContain(body);
    expect(JSON.stringify(loaded)).toContain("attachments");
  } finally {
    await h.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function proxiedMcpPeer(h: ReturnType<typeof harness>) {
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

test("ACP authentication gates session access, negotiates terminal methods, and logout releases active work", async () => {
  let authenticated = false;
  let factoryCalls = 0;
  let logoutCalls = 0;
  let completionSignal: AbortSignal | undefined;
  const blocked = deferred<unknown>();
  const base = setup({
    complete: (_request, signal) => {
      completionSignal = signal;
      return blocked.promise;
    },
  });
  const h = harness({
    ...base.options,
    listSessions: () => ({ sessions: [] }),
    auth: {
      methods: [
        { id: "login", name: "Sign in" },
        { type: "terminal", id: "interactive", name: "Terminal login", args: ["--login"] },
      ],
      isAuthenticated: () => authenticated,
      authenticate: (method) => {
        expect(method).toBe("login");
        authenticated = true;
      },
      logout: () => {
        logoutCalls++;
        authenticated = false;
      },
    },
    sessionOptions: (context) => {
      factoryCalls++;
      return base.options.sessionOptions(context);
    },
  });
  try {
    expect((await h.request("authenticate", { methodId: "login" })).error?.code).toBe(-32002);
    const init = await h.initialize();
    expect(init.result.authMethods).toEqual([{ id: "login", name: "Sign in" }]);
    expect(init.result.agentCapabilities.auth).toEqual({ logout: {} });
    expect((await h.request("session/new", { cwd: "/tmp", mcpServers: [] })).error?.code).toBe(
      -32000,
    );
    expect((await h.request("session/list", {})).error?.code).toBe(-32000);
    expect(factoryCalls).toBe(0);
    expect((await h.request("authenticate", { methodId: "unknown" })).error?.code).toBe(-32602);
    expect((await h.request("authenticate", { methodId: "interactive" })).error?.code).toBe(-32602);
    expect((await h.request("authenticate", { methodId: "login" })).result).toEqual({});
    const id = await h.newSession();
    const turn = await h.start("session/prompt", prompt(id));
    await until(() => !!completionSignal);
    expect((await h.request("logout", {})).result).toEqual({});
    expect(completionSignal!.aborted).toBe(true);
    expect((await h.response(turn)).result.stopReason).toBe("cancelled");
    expect(logoutCalls).toBe(1);
    expect((await h.request("session/new", { cwd: "/tmp", mcpServers: [] })).error?.code).toBe(
      -32000,
    );
    expect((await h.request("authenticate", { methodId: "login" })).result).toEqual({});
    expect(
      (await h.request("session/load", { sessionId: id, cwd: "/tmp", mcpServers: [] })).error,
    ).toBeUndefined();
    const { SessionIdSchema } = await import("@labkit-agent/core/types");
    const saved = await base.persistence.load(
      SessionIdSchema.parse(id),
      new AbortController().signal,
    );
    expect(JSON.stringify(saved)).not.toContain("Sign in");
  } finally {
    blocked.resolve(answer);
    await h.close();
  }
});

test("cancelled authentication cannot grant late access or overlap another credential change", async () => {
  let authenticated = false;
  let calls = 0;
  const gate = deferred<void>();
  const h = harness({
    ...setup().options,
    auth: {
      methods: [{ id: "login", name: "Sign in" }],
      isAuthenticated: () => authenticated,
      authenticate: async () => {
        if (++calls === 1) await gate.promise;
        authenticated = true;
      },
    },
  });
  try {
    await h.initialize();
    const login = await h.start("authenticate", { methodId: "login" });
    await until(() => calls === 1);
    await h.send({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: login } });
    expect((await h.response(login)).error).toBeDefined();
    expect((await h.request("authenticate", { methodId: "login" })).error).toBeDefined();
    expect(calls).toBe(1);
    gate.resolve();
    await until(() => authenticated);
    expect((await h.request("session/new", { cwd: "/tmp", mcpServers: [] })).error?.code).toBe(
      -32000,
    );
    expect((await h.request("authenticate", { methodId: "login" })).result).toEqual({});
    expect(typeof (await h.newSession())).toBe("string");
  } finally {
    gate.resolve();
    await h.close();
  }
});

test("logout cancels an opening factory and terminal login is advertised only to capable clients", async () => {
  let authenticated = true;
  const gate = deferred<void>();
  let entered = false;
  let factorySignal: AbortSignal | undefined;
  const base = setup();
  const h = harness({
    ...base.options,
    auth: {
      methods: [{ type: "terminal", id: "interactive", name: "Terminal", args: ["--login"] }],
      isAuthenticated: () => authenticated,
      logout: () => {
        authenticated = false;
      },
    },
    sessionOptions: async (context) => {
      entered = true;
      factorySignal = context.signal;
      await gate.promise;
      return base.options.sessionOptions(context);
    },
  });
  try {
    const init = await h.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { auth: { terminal: true } },
    });
    expect(init.result.authMethods).toHaveLength(1);
    expect(init.result.authMethods[0].type).toBe("terminal");
    expect((await h.request("authenticate", { methodId: "interactive" })).error).toBeDefined();
    const open = await h.start("session/new", { cwd: "/tmp", mcpServers: [] });
    await until(() => entered);
    expect((await h.request("logout", {})).result).toEqual({});
    expect(factorySignal!.aborted).toBe(true);
    gate.resolve();
    expect((await h.response(open)).error).toBeDefined();
    expect(h.updates()).toEqual([]);
  } finally {
    gate.resolve();
    await h.close();
  }
});

test("expired credentials still permit cancellation and close; disconnect aborts pending authentication", async () => {
  let authenticated = true;
  let completionSignal: AbortSignal | undefined;
  let loginSignal: AbortSignal | undefined;
  const completion = deferred<unknown>();
  const login = deferred<void>();
  const h = harness({
    ...setup({
      complete: (_request, signal) => {
        completionSignal = signal;
        return completion.promise;
      },
    }).options,
    auth: {
      methods: [{ id: "login", name: "Login" }],
      isAuthenticated: () => authenticated,
      authenticate: async (_id, signal) => {
        loginSignal = signal;
        await login.promise;
      },
    },
  });
  try {
    await h.initialize();
    const id = await h.newSession();
    const turn = await h.start("session/prompt", prompt(id));
    await until(() => !!completionSignal);
    authenticated = false;
    await h.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: id } });
    expect((await h.response(turn)).result.stopReason).toBe("cancelled");
    expect((await h.request("session/close", { sessionId: id })).result).toEqual({});
    await h.start("authenticate", { methodId: "login" });
    await until(() => !!loginSignal);
    await h.close();
    expect(loginSignal!.aborted).toBe(true);
  } finally {
    completion.resolve(answer);
    login.resolve();
    await h.close();
  }
});

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

function booleanConfiguration() {
  const base = configurable();
  const options: AcpOptions = {
    ...base.options,
    sessionOptions: async (context) => {
      const original = await base.options.sessionOptions(context);
      return {
        ...original,
        config: [
          ...original.config!,
          {
            id: "tools_enabled",
            name: "Enable tools",
            type: "boolean",
            category: "mode",
            current: (policy) => (policy.tools.a?.length ?? 0) > 0,
            patches: { true: { tools: { a: ["echo"] } }, false: { tools: { a: [] } } },
          },
        ],
      };
    },
  };
  return { ...base, options };
}

test("boolean configuration is capability-gated and rejects wrong wire value types", async () => {
  for (const capability of [undefined, null, {}]) {
    const h = harness(booleanConfiguration().options);
    try {
      await h.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { session: { configOptions: { boolean: capability } } },
      });
      const created = (await h.request("session/new", { cwd: "/tmp", mcpServers: [] })).result;
      const visible = capability != null;
      expect(created.configOptions.some((option: any) => option.type === "boolean")).toBe(visible);
      expect(created.modes.currentModeId).toBe("tools");
      for (const params of [
        { type: "boolean", value: "false" },
        { value: false },
        { type: "select", value: "false" },
      ])
        expect(
          (
            await h.request("session/set_config_option", {
              sessionId: created.sessionId,
              configId: "tools_enabled",
              ...params,
            })
          ).error?.code,
        ).toBe(-32602);
      const result = await h.request("session/set_config_option", {
        sessionId: created.sessionId,
        configId: "tools_enabled",
        type: "boolean",
        value: false,
      });
      if (visible) {
        expect(result.error).toBeUndefined();
        expect(result.result.configOptions.at(-1)).toEqual({
          id: "tools_enabled",
          name: "Enable tools",
          category: "mode",
          type: "boolean",
          currentValue: false,
        });
        expect(
          result.result.configOptions.find((option: any) => option.id === "mode").currentValue,
        ).toBe("chat");
      } else expect(result.error?.code).toBe(-32602);
    } finally {
      await h.close();
    }
  }
});

test("boolean configuration waits for its policy receipt and restores without exposing it to older clients", async () => {
  const base = booleanConfiguration();
  const gate = deferred<void>();
  let entered = false;
  const persistence = {
    ...base.persistence,
    append: async (request: Parameters<typeof base.persistence.append>[0], signal: AbortSignal) => {
      if (request.records.some((raw) => JSON.parse(raw).body.kind === "policy")) {
        entered = true;
        await gate.promise;
      }
      return base.persistence.append(request, signal);
    },
  };
  const options: AcpOptions = {
    ...base.options,
    sessionOptions: async (context) => ({
      ...(await base.options.sessionOptions(context)),
      persistence,
    }),
  };
  let h = harness(options);
  const initialize = () =>
    h.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { session: { configOptions: { boolean: {} } } },
    });
  try {
    await initialize();
    const id = await h.newSession();
    const set = await h.start("session/set_config_option", {
      sessionId: id,
      configId: "tools_enabled",
      type: "boolean",
      value: false,
    });
    await until(() => entered);
    expect(h.messages.some((m) => m.id === set && !m.method)).toBe(false);
    expect(h.updates().some((m) => m.update.sessionUpdate === "config_option_update")).toBe(false);
    gate.resolve();
    const result = await h.response(set);
    expect(result.result.configOptions.at(-1).currentValue).toBe(false);
    const update = h
      .updates()
      .find((m) => m.update.sessionUpdate === "config_option_update")!.update;
    expect(update).toMatchObject({ configOptions: result.result.configOptions });
    await h.close();
    h = harness(options);
    await h.initialize();
    const legacy = await h.request("session/load", { sessionId: id, cwd: "/tmp", mcpServers: [] });
    expect(legacy.result.configOptions.some((option: any) => option.type === "boolean")).toBe(
      false,
    );
    expect(legacy.result.modes.currentModeId).toBe("chat");
    await h.close();
    h = harness(options);
    await initialize();
    const restored = await h.request("session/resume", {
      sessionId: id,
      cwd: "/tmp",
      mcpServers: [],
    });
    expect(restored.result.configOptions.at(-1).currentValue).toBe(false);
    expect(base.requests).toHaveLength(0);
  } finally {
    gate.resolve();
    await h.close();
  }
});

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

test("ACP exposes structured storage failure from public settlement without reconstructing it", async () => {
  const { options, persistence } = setup();
  const original = options.sessionOptions;
  const h = harness({
    ...options,
    sessionOptions: async (context) => ({
      ...(await original(context)),
      persistence: {
        ...persistence,
        append: async (request, signal) =>
          request.expectedRevision === 0
            ? persistence.append(request, signal)
            : {
                kind: "rejected",
                message: "Journal volume is read-only",
                error: {
                  message: "Journal volume is read-only",
                  cause: { code: "EROFS", path: "/store/journal" },
                },
              },
      },
    }),
  });
  try {
    await h.initialize();
    const sessionId = await h.newSession();
    const response = await h.request("session/prompt", prompt(sessionId));
    expect(response.error).toMatchObject({
      code: -32000,
      message: "Journal volume is read-only",
      data: {
        classification: "persistence",
        operation: { kind: "append", sessionId },
        phase: "append",
        cause: { code: "EROFS", path: "/store/journal" },
      },
    });
  } finally {
    await h.close();
  }
});

test("workspace ACP reports missing-file errors to the model, completes sibling reads, and supplies recovery instructions to the next completion", async () => {
  const { mkdir, realpath } = await import("node:fs/promises");
  const { resolve, join } = await import("node:path");
  const { workspaceAgent } = await import("./examples/vscode-workspace.ts");
  const { withFixtureDiagnostics } = await import("../core/logging/fixture-capture.ts");
  const directory = resolve(`.session-artifacts/acp-tool-recovery/${crypto.randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const cwd = await realpath(directory);
  await withFixtureDiagnostics(directory, {}, async () => {
    const workspace = workspaceAgent({
      LABKIT_ACP_MODEL: "review-model",
      ANTHROPIC_API_KEY: "scripted-credential",
    });
    let completions = 0;
    const modelRequests: unknown[] = [];
    const h = harness({
      ...workspace,
      sessionOptions: async (context) => {
        const options = await workspace.sessionOptions(context);
        expect(options.configuration.policy?.toolFailure).toBe("return-error-and-continue");
        return {
          ...options,
          config: undefined,
          configuration: {
            ...options.configuration,
            policy: {
              permissions: options.configuration.policy!.permissions,
              toolFailure: options.configuration.policy!.toolFailure,
            },
          },
          bindings: {
            ...options.bindings,
            providers: undefined,
            complete: (request) => {
              modelRequests.push(request);
              completions++;
              if (completions === 1)
                return {
                  kind: "tools",
                  text: "Read the documentation",
                  calls: [
                    {
                      id: "missing",
                      name: "read_file",
                      args: { path: "packages/core/agent/README.md" },
                    },
                    {
                      id: "existing",
                      name: "read_file",
                      args: { path: "packages/acp/protocol-reference.md" },
                    },
                  ],
                };
              const results = request.messages.filter((message) => message.role === "tool");
              if (completions === 2) {
                expect(results).toHaveLength(2);
                expect(JSON.stringify(results)).toContain("ENOENT");
                expect(JSON.stringify(results)).toContain("list_dir");
                expect(JSON.stringify(results)).toContain("discover existing names");
                expect(JSON.stringify(results)).toContain("packages/core/agent/README.md");
                expect(JSON.stringify(results)).toContain("Protocol documentation contents");
                return {
                  kind: "tools",
                  text: "The requested README is absent; read the agent implementation instead",
                  calls: [
                    {
                      id: "recovery",
                      name: "read_file",
                      args: { path: "packages/core/agent/agent.ts" },
                    },
                  ],
                };
              }
              expect(JSON.stringify(results)).toContain("Agent implementation contents");
              return {
                kind: "answer",
                text: "Review completed using the implementation and protocol reference; the agent README does not exist.",
              };
            },
          },
        };
      },
    });
    try {
      await h.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true } },
      });
      const opened = await h.request("session/new", { cwd, mcpServers: [] });
      expect(opened.error).toBeUndefined();
      const sessionId = opened.result.sessionId;
      const turn = await h.start("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "Review this project's documentation" }],
      });
      await until(() =>
        h.messages.some((message) => message.method === "session/request_permission"),
      );
      const permission = h.messages.find(
        (message) => message.method === "session/request_permission",
      )!;
      await h.send({
        jsonrpc: "2.0",
        id: permission.id,
        result: { outcome: { outcome: "selected", optionId: "allow-session" } },
      });
      await until(
        () => h.messages.filter((message) => message.method === "fs/read_text_file").length === 2,
      );
      const reads = h.messages.filter((message) => message.method === "fs/read_text_file");
      for (const read of reads) {
        if (read.params.path.endsWith("README.md"))
          await h.send({
            jsonrpc: "2.0",
            id: read.id,
            error: {
              code: -32603,
              message: "Internal error",
              data: {
                details: `Error: ENOENT: no such file or directory, open '${read.params.path}'`,
              },
            },
          });
        else
          await h.send({
            jsonrpc: "2.0",
            id: read.id,
            result: { content: "Protocol documentation contents" },
          });
      }
      await until(
        () => h.messages.filter((message) => message.method === "fs/read_text_file").length === 3,
      );
      const recovery = h.messages.filter((message) => message.method === "fs/read_text_file")[2]!;
      expect(recovery.params.path).toBe(join(cwd, "packages/core/agent/agent.ts"));
      await h.send({
        jsonrpc: "2.0",
        id: recovery.id,
        result: { content: "Agent implementation contents" },
      });
      expect((await h.response(turn)).result.stopReason).toBe("end_turn");
      expect(completions).toBe(3);
      expect(
        h.messages.filter((message) => message.method === "session/request_permission"),
      ).toHaveLength(1);
      const updates = h.updates().map((message) => message.update);
      expect(
        updates.some(
          (update) =>
            update.sessionUpdate === "tool_call_update" &&
            update.toolCallId.endsWith("/missing") &&
            update.status === "failed",
        ),
      ).toBe(true);
      expect(
        updates.some(
          (update) =>
            update.sessionUpdate === "tool_call_update" &&
            update.toolCallId.endsWith("/existing") &&
            update.status === "completed",
        ),
      ).toBe(true);
    } finally {
      await h.close();
      await Bun.write(join(directory, "protocol.json"), JSON.stringify(h.messages, null, 2));
      await Bun.write(
        join(directory, "model-requests.json"),
        JSON.stringify(modelRequests, null, 2),
      );
    }
  });
  const records = (await Bun.file(join(directory, "diagnostics.jsonl")).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const failure = records.find((record) => record.event === "client_file.failed");
  expect(failure).toMatchObject({ level: "warning", operation: "fs/read_text_file" });
  expect(failure.path).toContain("packages/core/agent/README.md");
  expect(JSON.stringify(failure.error)).toContain("ENOENT");
  expect(failure.toolCallId).toEndWith("/missing");
  expect(
    records.some(
      (record) =>
        record.event === "client_file.completed" && record.path.endsWith("protocol-reference.md"),
    ),
  ).toBe(true);
});

for (const stream of [false, true]) {
  for (const reason of ["max_tokens", "refusal"]) {
    test(`ACP maps Anthropic ${reason} (stream=${stream}) without admitting partial tools`, async () => {
      const { anthropicMessagesV3 } = await import("../core/providers/index.ts");
      const { withFixtureDiagnostics } = await import("../core/logging/fixture-capture.ts");
      const directory = `.session-artifacts/acp-provider-stop/${crypto.randomUUID()}`;
      await withFixtureDiagnostics(directory, {}, async () => {
        const base = setup();
        let requests = 0;
        let toolRuns = 0;
        const h = harness({
          sessionOptions: async (context) => {
            const options = await base.options.sessionOptions(context);
            return {
              ...options,
              configuration: {
                ...options.configuration,
                policy: {
                  provider: "anthropic",
                  model: "m",
                  permissions: "off",
                  stream,
                  thinking: "off",
                  maxOutputTokens: 4096,
                },
              },
              bindings: {
                ...options.bindings,
                complete: undefined,
                tools: new Map([
                  [
                    "echo",
                    defineTool({
                      input: z.object({ text: z.string() }),
                      run: () => {
                        toolRuns++;
                        return "unexpected";
                      },
                    }),
                  ],
                ]),
                providers: new Map([
                  [
                    "anthropic",
                    {
                      profile: anthropicMessagesV3,
                      transport: {
                        baseUrl: "https://example.invalid",
                        fetch: (async () => {
                          requests++;
                          if (!stream)
                            return Response.json(
                              {
                                role: "assistant",
                                stop_reason: reason,
                                content: [
                                  {
                                    type: "tool_use",
                                    id: "partial",
                                    name: "echo",
                                    input: { text: "partial" },
                                  },
                                ],
                                usage: { output_tokens: 4096 },
                              },
                              { headers: { "request-id": "provider-stop-test" } },
                            );
                          const events = streamVector(anthropicMessagesV3, true).map((event) => {
                            const data = JSON.parse(event.data);
                            if (data.type === "message_delta") data.delta.stop_reason = reason;
                            return { ...event, data: JSON.stringify(data) };
                          });
                          return streamResponse(events);
                        }) as unknown as typeof fetch,
                      },
                    },
                  ],
                ]),
              },
            };
          },
        });
        try {
          await h.initialize();
          const sessionId = await h.newSession();
          const response = await h.request("session/prompt", prompt(sessionId));
          expect(response.error).toBeUndefined();
          expect(response.result.stopReason).toBe(
            reason === "max_tokens" ? "max_tokens" : "refusal",
          );
          expect(response.result._meta["labkit.dev/failure"]).toMatchObject({
            operation: { kind: "completion", sessionId },
            providerStop: { category: reason === "max_tokens" ? "token_limit" : "refusal", reason },
          });
          expect(requests).toBe(1);
          expect(toolRuns).toBe(0);
        } finally {
          await h.close();
        }
      });
      const records = (await Bun.file(`${directory}/diagnostics.jsonl`).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const failed = records.find((record) => record.event === "provider.completion.failed");
      expect(failed.level).toBe("warning");
      expect(failed.error.providerStop.reason).toBe(reason);
    });
  }
}

test("live command catalogs update and clear without changing admitted prompts or leaking after close", async () => {
  const { withFixtureDiagnostics } = await import("../core/logging/fixture-capture.ts");
  const directory = `.session-artifacts/acp-commands/${crypto.randomUUID()}`;
  await withFixtureDiagnostics(directory, {}, async () => {
    const pending = deferred<unknown>();
    let admittedText = "";
    let publish: NonNullable<Parameters<AcpOptions["sessionOptions"]>[0]["publishCommands"]>;
    const base = setup({
      complete: (request) => {
        admittedText = request.messages.at(-1)!.content;
        return pending.promise;
      },
    });
    const h = harness({
      ...base.options,
      sessionOptions: async (context) => {
        publish = context.publishCommands!;
        publish([{ name: "review", description: "Staged", prompt: "Initial instructions" }]);
        return base.options.sessionOptions(context);
      },
    });
    try {
      await h.initialize();
      const sessionId = await h.newSession();
      const catalogs = () =>
        h
          .updates()
          .filter((message) => message.update.sessionUpdate === "available_commands_update");
      expect(catalogs()).toHaveLength(1);
      const turn = await h.start("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "/review this" }],
      });
      await until(() => admittedText !== "");
      publish!([{ name: "review", description: "Changed", prompt: "Replacement instructions" }]);
      await until(() => catalogs().length === 2);
      expect(admittedText).toContain("Initial instructions");
      expect(admittedText).not.toContain("Replacement instructions");
      expect(() =>
        publish!([{ name: "INVALID COMMAND", description: "bad", prompt: "bad" }]),
      ).toThrow();
      expect(catalogs()).toHaveLength(2);
      pending.resolve(answer);
      expect((await h.response(turn)).result.stopReason).toBe("end_turn");
      await h.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "/review again" }],
      });
      expect(admittedText).toContain("Replacement instructions");
      publish!([]);
      await until(() => catalogs().length === 3);
      expect(catalogs().at(-1)!.update).toMatchObject({ availableCommands: [] });
      await h.request("session/close", { sessionId });
      expect(() => publish!([])).toThrow("closed ACP session");
      expect(catalogs()).toHaveLength(3);
    } finally {
      pending.resolve(answer);
      await h.close();
    }
  });
  const records = (await Bun.file(`${directory}/diagnostics.jsonl`).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const updated = records.filter((record) => record.event === "acp.commands.updated");
  expect(updated.map((record) => record.count)).toEqual([1, 0]);
  expect(updated[0]).toMatchObject({ level: "info", names: ["review"] });
  expect(updated[0].sessionId).toBeString();
  expect(records.filter((record) => record.event === "acp.commands.rejected")).toHaveLength(2);
});

test("read_file forwards line ranges to the ACP client and retains range diagnostics", async () => {
  const { workspaceFiles } = await import("./workspace-files.ts");
  const { workspaceTools } = await import("./workspace-tools.ts");
  const { withFixtureDiagnostics } = await import("../core/logging/fixture-capture.ts");
  const directory = `.session-artifacts/acp-file-range/${crypto.randomUUID()}`;
  await withFixtureDiagnostics(directory, {}, async () => {
    let completions = 0;
    const base = setup({
      complete: (request) => {
        if (++completions === 1)
          return {
            kind: "tools",
            text: "Read the relevant lines",
            calls: [
              { id: "range", name: "read_file", args: { path: "note.txt", line: 10, limit: 3 } },
            ],
          };
        expect(request.messages.find((message) => message.role === "tool")!.content).toContain(
          "Unsaved editor lines",
        );
        return answer;
      },
    });
    const h = harness({
      ...base.options,
      sessionOptions: async (context) => {
        const options = await base.options.sessionOptions(context);
        return {
          ...options,
          configuration: {
            ...options.configuration,
            policy: { permissions: "off" },
            agents: new Map([["a", { model: "m", tools: ["read_file"] }]]),
          },
          bindings: {
            ...options.bindings,
            tools: workspaceTools(await workspaceFiles(context.cwd), context.clientFiles),
          },
        };
      },
    });
    try {
      await h.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true } },
      });
      const sessionId = await h.newSession();
      const turn = await h.start("session/prompt", prompt(sessionId));
      await until(() => h.messages.some((message) => message.method === "fs/read_text_file"));
      const request = h.messages.find((message) => message.method === "fs/read_text_file")!;
      expect(request.params).toMatchObject({ sessionId, line: 10, limit: 3 });
      expect(request.params.path).toEndWith("/note.txt");
      await h.send({ jsonrpc: "2.0", id: request.id, result: { content: "Unsaved editor lines" } });
      expect((await h.response(turn)).result.stopReason).toBe("end_turn");
    } finally {
      await h.close();
    }
  });
  const records = (await Bun.file(`${directory}/diagnostics.jsonl`).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(records.find((record) => record.event === "client_file.completed")).toMatchObject({
    line: 10,
    limit: 3,
  });
  expect(records.filter((record) => ["warning", "error"].includes(record.level))).toHaveLength(0);
});

test("ACP audio reaches Google as exact inline bytes, remains a journal ref, and reload performs no HTTP", async () => {
  const { googleGenerateV3 } = await import("../core/providers/index.ts");
  const { SessionIdSchema } = await import("../core/agent/types.ts");
  const { withFixtureDiagnostics } = await import("../core/logging/fixture-capture.ts");
  const directory = `.session-artifacts/acp-audio/${crypto.randomUUID()}`;
  await withFixtureDiagnostics(directory, {}, async () => {
    const wav = Buffer.alloc(44 + 320);
    wav.write("RIFF", 0);
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16000, 24);
    wav.writeUInt32LE(32000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(320, 40);
    const data = wav.toString("base64");
    const wires: any[] = [];
    const base = setup();
    const options: AcpOptions = {
      ...base.options,
      sessionOptions: async (context) => {
        const original = await base.options.sessionOptions(context);
        return {
          ...original,
          configuration: {
            ...original.configuration,
            policy: { provider: "google", model: "audio-test", thinking: "off" },
          },
          bindings: {
            ...original.bindings,
            complete: undefined,
            providers: new Map([
              [
                "google",
                {
                  profile: googleGenerateV3,
                  transport: {
                    baseUrl: "https://example.invalid",
                    fetch: (async (_url, init) => {
                      wires.push(JSON.parse(String(init?.body)));
                      return Response.json({
                        candidates: [
                          {
                            finishReason: "STOP",
                            content: {
                              role: "model",
                              parts: [{ text: "Scripted audio response" }],
                            },
                          },
                        ],
                      });
                    }) as typeof fetch,
                  },
                },
              ],
            ]),
          },
        };
      },
    };
    let h = harness(options);
    try {
      await h.initialize();
      const id = await h.newSession();
      const response = await h.request("session/prompt", {
        sessionId: id,
        prompt: [
          { type: "text", text: "Describe this recording" },
          { type: "audio", mimeType: "audio/wav", data },
        ],
      });
      expect(response.result.stopReason).toBe("end_turn");
      expect(wires[0].contents[0].parts).toContainEqual({
        inlineData: { mimeType: "audio/wav", data },
      });
      const loaded = await base.persistence.load(
        SessionIdSchema.parse(id),
        new AbortController().signal,
      );
      expect(JSON.stringify(loaded)).toContain("audio/wav");
      expect(JSON.stringify(loaded)).not.toContain(data);
      await h.close();
      h = harness(options);
      await h.initialize();
      expect(
        (await h.request("session/load", { sessionId: id, cwd: "/tmp", mcpServers: [] })).error,
      ).toBeUndefined();
      expect(wires).toHaveLength(1);
      expect(
        h
          .updates()
          .some(
            (message) =>
              message.update.sessionUpdate === "user_message_chunk" &&
              message.update.content.type === "resource_link" &&
              message.update.content.mimeType === "audio/wav",
          ),
      ).toBe(true);
      await h.request("session/prompt", {
        sessionId: id,
        prompt: [{ type: "text", text: "Describe the recording again" }],
      });
      expect(wires).toHaveLength(2);
      expect(wires[1].contents[0].parts).toContainEqual({
        inlineData: { mimeType: "audio/wav", data },
      });
    } finally {
      await h.close();
      await Bun.write(`${directory}/requests.json`, JSON.stringify(wires, null, 2));
    }
  });
  const records = (await Bun.file(`${directory}/diagnostics.jsonl`).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(records.find((record) => record.event === "attachment.stored")).toMatchObject({
    media: "audio/wav",
    bytes: 364,
  });
  expect(records.filter((record) => ["warning", "error"].includes(record.level))).toHaveLength(0);
});
