import { ndJsonStream, type SessionNotification } from "@agentclientprotocol/sdk";
import { defineTool, type BoundSessionOptions } from "@labkit-agent/core";
import { createMemoryPersistence } from "@labkit-agent/core/testing";
import { expect, test } from "@logtape/testing-bun/autoload";
import { z } from "zod";

import { deferred, until } from "../core/agent/test-support.ts";
import {
  streamingProfiles,
  streamResponse,
  streamVector,
} from "../core/providers/testing/stream-vectors.ts";
import { connectAcp, type AcpOptions } from "./adapter.ts";

type Message = {
  jsonrpc: string;
  id?: string | number | null;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string };
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
function setup(overrides: Partial<BoundSessionOptions["bindings"]> = {}) {
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
    agentCapabilities: { loadSession: true, promptCapabilities: { image: false } },
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
        mcpServers: [{ name: "m", command: "sh", args: [], env: [] }],
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
    locations: [{ path: "/tmp/DESIGN.md", line: 3 }],
    status: "pending",
  });
  expect(permission.params).not.toHaveProperty("turnId");
  expect(permission.params.options.map((o: any) => o.kind)).toEqual(["allow_once", "reject_once"]);
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
  ).toEqual(["pending", "in_progress", "completed"]);
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
              provider: profile.id,
              stream: true,
              thinking:
                profile.id.startsWith("anthropic") || profile.id.startsWith("google")
                  ? "adaptive"
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
          policy: { provider: openaiChatV2.id, stream: true },
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
  const pending = deferred<BoundSessionOptions>();
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
        configuration: { ...base.configuration, policy: { provider: openaiChat.id } },
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
  const original = options.sessionOptions;
  const h = harness({
    ...options,
    sessionOptions: async (context) => ({
      ...(await original(context)),
      persistence: {
        ...persistence,
        putBlob: async (id, bytes, meta, signal) => {
          entered = true;
          storageSignal = signal;
          await pending.promise;
          return persistence.putBlob(id, bytes, meta, signal);
        },
      },
    }),
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
          policy: { provider: openaiChat.id, permissions: "ask" },
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
