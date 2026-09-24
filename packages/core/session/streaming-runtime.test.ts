import { expect, test } from "@logtape/testing-bun/autoload";
import { z } from "zod";

import type { HostStreamNotification } from "../host/host.ts";
import { openaiChat, type CompletionProfile } from "../providers/index.ts";
import {
  sse,
  streamingProfiles,
  streamResponse,
  streamVector,
  text,
} from "../providers/testing/stream-vectors.ts";
import { journalJSONL } from "./session-log.ts";
import {
  createSession,
  defineTool,
  restoreSession,
  type BoundSessionOptions,
} from "./session-runtime.ts";
import { deferred, deterministicIds, until } from "./test-support.ts";
import { createMemoryPersistence } from "./testing/memory-persistence.ts";

function setup(profile: CompletionProfile) {
  const updates: HostStreamNotification[] = [];
  const requests: any[] = [];
  let tools = 0;
  const options: BoundSessionOptions = {
    persistence: createMemoryPersistence(),
    configuration: {
      agent: "a",
      agents: new Map([["a", { model: "m", tools: ["echo"], successors: [] }]]),
      steps: 5,
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
      id: deterministicIds(),
      tools: new Map([
        [
          "echo",
          defineTool({
            input: z.object({ text: z.string() }),
            run: ({ text }) => {
              tools++;
              return text;
            },
          }),
        ],
      ]),
      streamUpdate: (event) => {
        updates.push(event);
      },
      providers: new Map([
        [
          profile.id,
          {
            profile,
            transport: {
              baseUrl: "https://example.invalid",
              fetch: (async (_url, init) => {
                const i = requests.length;
                requests.push(JSON.parse(String(init?.body)));
                return streamResponse(streamVector(profile, i < 2, `signature-${i}`));
              }) as typeof fetch,
            },
          },
        ],
      ]),
    },
  };
  return { options, updates, requests, tools: () => tools };
}
for (const profile of streamingProfiles) {
  test(`${profile.id}: two streaming tool rounds, one settlement per completion, restore/fork preserve owners`, async () => {
    const { options, updates, requests, tools } = setup(profile);
    const session = await createSession(options);
    const result = await session.input("Go").settled;
    expect(result.kind === "terminal" && result.record.outcome.kind).toBe("completed");
    expect(tools()).toBe(2);
    expect(requests).toHaveLength(3);
    const ids = [...new Set(updates.map((event) => event.completionId))];
    expect(ids).toHaveLength(3);
    for (const id of ids) {
      const group = updates.filter((event) => event.completionId === id);
      expect(group.flatMap((event) => (event.status ? [event.status] : []))).toEqual([
        "pending",
        "in_progress",
        "completed",
      ]);
      expect(group.map((event) => event.text ?? "").join("")).toBe(text);
    }
    const durable = session.snapshot.durable;
    const settlements = durable.records.filter(
      (record) =>
        record.body.kind === "event" &&
        record.body.event.type === "child" &&
        record.body.event.event.type === "model_settled",
    );
    expect(settlements).toHaveLength(3);
    expect(journalJSONL(durable)).not.toContain('"completion_update"');
    if (profile.id !== "openai-chat@2") {
      expect(durable.continuations).toHaveLength(3);
      expect(durable.continuations?.every((entry) => entry.provider === profile.id)).toBe(true);
      expect(JSON.stringify(requests[2])).toContain("signature-0");
      expect(JSON.stringify(requests[2])).toContain("signature-1");
    }
    const count = updates.length;
    const restored = await restoreSession(options, durable.conversation.sessionId);
    expect(updates).toHaveLength(count);
    const fork = await session.fork();
    await fork.input("Next").settled;
    expect(updates.at(-1)?.sessionId).toBe(fork.snapshot.durable.conversation.sessionId);
    expect(updates.at(-1)?.status).toBe("completed");
    await Promise.all([session, restored, fork].map((runtime) => runtime.close()));
  });
  test(`${profile.id}: incomplete stream journals only failure and never releases partial tool calls`, async () => {
    const { options, updates, tools } = setup(profile);
    const binding = options.bindings.providers!.get(profile.id)!;
    const session = await createSession({
      ...options,
      bindings: {
        ...options.bindings,
        providers: new Map([
          [
            profile.id,
            {
              ...binding,
              transport: {
                ...binding.transport,
                fetch: (async () =>
                  streamResponse(
                    streamVector(profile, true).slice(0, -1),
                  )) as unknown as typeof fetch,
              },
            },
          ],
        ]),
      },
    });
    const result = await session.input("Go").settled;
    expect(result.kind === "terminal" && result.record.outcome.kind).toBe("failed");
    expect(tools()).toBe(0);
    expect(session.snapshot.durable.continuations ?? []).toEqual([]);
    const settlements = session.snapshot.durable.records.filter(
      (record) =>
        record.body.kind === "event" &&
        record.body.event.type === "child" &&
        record.body.event.event.type === "model_settled",
    );
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({
      body: { event: { event: { result: { kind: "failed" } } } },
    });
    expect(updates.at(-1)?.status).toBe("failed");
    expect(updates.some((event) => event.status === "completed")).toBe(false);
    await session.close();
  });
}

test("streamed completion remains non-authoritative while the settlement append is held", async () => {
  const { options, updates, tools } = setup(streamingProfiles[0]!);
  const gate = deferred<void>();
  let waiting = false;
  const session = await createSession({
    ...options,
    persistence: {
      ...options.persistence,
      append: async (request, signal) => {
        if (
          !waiting &&
          request.records.some((raw) => JSON.parse(raw).body.event?.event?.type === "model_settled")
        ) {
          waiting = true;
          await gate.promise;
        }
        return options.persistence.append(request, signal);
      },
    },
  });
  const pending = session.input("Go").settled;
  await until(() => waiting);
  expect(updates.at(-1)?.status).toBe("completed");
  expect(tools()).toBe(0);
  expect(
    session.snapshot.durable.records.some(
      (record) =>
        record.body.kind === "event" &&
        record.body.event.type === "child" &&
        record.body.event.event.type === "model_settled",
    ),
  ).toBe(false);
  gate.resolve();
  await pending;
  expect(tools()).toBe(2);
  await session.close();
});

test("barge-in cancels the completion reader; no late stream bytes or partial completion survive", async () => {
  const profile = streamingProfiles[0]!;
  const { options, updates } = setup(profile);
  let cancelled = false;
  let requests = 0;
  const binding = options.bindings.providers!.get(profile.id)!;
  const session = await createSession({
    ...options,
    bindings: {
      ...options.bindings,
      providers: new Map([
        [
          profile.id,
          {
            ...binding,
            transport: {
              ...binding.transport,
              fetch: (async () => {
                if (requests++) return streamResponse(streamVector(profile));
                return new Response(
                  new ReadableStream({
                    start(controller) {
                      controller.enqueue(
                        new TextEncoder().encode(sse(streamVector(profile).slice(0, 1))),
                      );
                    },
                    cancel() {
                      cancelled = true;
                    },
                  }),
                  { headers: { "content-type": "text/event-stream" } },
                );
              }) as unknown as typeof fetch,
            },
          },
        ],
      ]),
    },
  });
  const first = session.input("Old").settled;
  await until(() => updates.some((event) => event.text));
  const oldId = updates[0]!.completionId;
  const second = session.input("New").settled;
  const [a, b] = await Promise.all([first, second]);
  expect(a).toEqual(b);
  expect(b.kind === "terminal" && b.record.outcome.kind).toBe("completed");
  expect(cancelled).toBe(true);
  expect(updates.filter((event) => event.completionId === oldId).at(-1)?.status).toBe("failed");
  const log = session.snapshot.durable.conversation.log;
  expect(log[0]?.messages.map((message) => message.text)).toEqual(["Old", "New", text]);
  await session.close();
});

test("policy rejects stream:true for unsupported profiles and provider switches need stream:false", async () => {
  const { options } = setup(streamingProfiles[0]!);
  const registry = new Map(options.bindings.providers);
  let oldFetches = 0;
  registry.set(openaiChat.id, {
    profile: openaiChat,
    transport: {
      baseUrl: "https://example.invalid",
      fetch: (async () => {
        oldFetches++;
        return Response.json({});
      }) as unknown as typeof fetch,
    },
  });
  await expect(
    createSession({
      ...options,
      configuration: {
        ...options.configuration,
        policy: { provider: openaiChat.id, stream: true },
      },
      bindings: { ...options.bindings, providers: registry },
    }),
  ).rejects.toThrow("Unsupported streaming");
  const session = await createSession({
    ...options,
    bindings: { ...options.bindings, providers: registry },
  });
  expect((await session.updatePolicy({ provider: openaiChat.id })).kind).toBe("failed");
  expect((await session.updatePolicy({ provider: openaiChat.id, stream: false })).kind).toBe(
    "accepted",
  );
  expect(oldFetches).toBe(0);
  await session.close();
});

test("large streamed thought signatures use continuation blobs and observers remain optional", async () => {
  const profile = streamingProfiles[2]!;
  const { options } = setup(profile);
  const signature = "s".repeat(70 * 1024);
  let count = 0;
  const requests: string[] = [];
  const binding = options.bindings.providers!.get(profile.id)!;
  const session = await createSession({
    ...options,
    bindings: {
      ...options.bindings,
      streamUpdate: () => Promise.reject(new Error("display unavailable")),
      providers: new Map([
        [
          profile.id,
          {
            ...binding,
            transport: {
              ...binding.transport,
              fetch: (async (_url, init) => {
                requests.push(String(init?.body));
                return streamResponse(streamVector(profile, count++ === 0, signature));
              }) as typeof fetch,
            },
          },
        ],
      ]),
    },
  });
  const result = await session.input("Go").settled;
  expect(result.kind === "terminal" && result.record.outcome.kind).toBe("completed");
  expect(requests[1]).toContain(signature);
  expect(
    session.snapshot.durable.continuations?.every((entry) => entry.payloadBlob && !entry.payload),
  ).toBe(true);
  expect(journalJSONL(session.snapshot.durable)).not.toContain(signature);
  await session.close();
});
