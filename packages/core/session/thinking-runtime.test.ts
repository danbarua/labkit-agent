import { expect, test } from "@logtape/testing-bun/autoload";
import { z } from "zod";

import { builtinResolvers } from "../policy/policy.ts";
import { anthropicMessagesV2, googleGenerate } from "../providers/index.ts";
import { AppendIdSchema, type CommittedBatch, type SessionPersistence } from "./persistence.ts";
import { decodeRecord, replay, stage } from "./session-log.ts";
import {
  createSession,
  defineTool,
  restoreSession,
  type SessionOptions,
} from "./session-runtime.ts";
import { deterministicIds } from "./test-support.ts";
import { createMemoryPersistence } from "./testing/memory-persistence.ts";

function setup(responses?: readonly unknown[]) {
  const bodies: {
    messages?: { role: string; content: { type: string; signature?: string }[] }[];
  }[] = [];
  let count = 0;
  const opts: SessionOptions = {
    persistence: createMemoryPersistence(),
    configuration: {
      agent: "a",
      agents: new Map([["a", { model: "claude-sonnet-4-5", tools: ["echo"], successors: [] }]]),
      steps: 4,
      policy: {
        provider: anthropicMessagesV2.id,
        thinking: "budget",
        thinkingBudgetTokens: 1024,
        maxOutputTokens: 2048,
      },
    },
    bindings: {
      id: deterministicIds(),
      tools: new Map([["echo", defineTool({ input: z.object({}), run: () => "ok" })]]),
      providers: new Map(
        [anthropicMessagesV2, googleGenerate].map((profile) => [
          profile.id,
          {
            profile,
            transport: {
              baseUrl: "https://example.invalid",
              fetch: (async (_url, init) => {
                bodies.push(JSON.parse(String(init?.body)));
                if (profile.id === googleGenerate.id)
                  return Response.json({
                    candidates: [
                      {
                        finishReason: "STOP",
                        content: { role: "model", parts: [{ text: "google" }] },
                      },
                    ],
                  });
                const i = count++;
                if (responses?.[i]) return Response.json(responses[i]);
                return Response.json({
                  role: "assistant",
                  stop_reason: i < 2 ? "tool_use" : "end_turn",
                  content: [
                    { type: "thinking", thinking: "private", signature: `sig-${i}` },
                    i < 2
                      ? { type: "tool_use", id: `c${i}`, name: "echo", input: {} }
                      : { type: "text", text: "done" },
                  ],
                });
              }) as typeof fetch,
            },
          },
        ]),
      ),
    },
  };
  return { opts, bodies };
}

const resolvers = {
  ...builtinResolvers,
  providerIds: new Set([anthropicMessagesV2.id, googleGenerate.id]),
};

test("thinking survives two tool rounds, restore, fork; projection/switch omit and compaction drops", async () => {
  const { opts, bodies } = setup();
  const session = await createSession(opts);
  const settled = await session.input("Go").settled;
  expect(settled.kind === "terminal" && settled.record.outcome.kind).toBe("completed");
  expect(session.snapshot.durable.continuations).toHaveLength(3);
  expect(
    bodies[2]?.messages?.filter((m) => m.role === "assistant").map((m) => m.content[0]?.signature),
  ).toEqual(["sig-0", "sig-1"]);
  const id = session.snapshot.durable.conversation.sessionId;
  const restored = await restoreSession(opts, id);
  expect(bodies).toHaveLength(3);
  expect(restored.snapshot.durable).toEqual(session.snapshot.durable);
  const fork = await session.fork();
  expect(fork.snapshot.durable.continuations).toEqual(session.snapshot.durable.continuations);
  await fork.input("next").settled;
  expect(
    bodies
      .at(-1)
      ?.messages?.filter((m) => m.role === "assistant")
      .map((m) => m.content[0]?.signature),
  ).toEqual(["sig-0", "sig-1", "sig-2"]);
  const compact = await session.compact([]);
  expect(compact.snapshot.durable.continuations ?? []).toEqual([]);
  await session.updatePolicy({ project: "context-only@1" });
  await session.input("context only").settled;
  expect(bodies.at(-1)?.messages?.filter((m) => m.role === "assistant")).toEqual([]);
  const retained = session.snapshot.durable.continuations;
  expect((await session.updatePolicy({ provider: googleGenerate.id })).kind).toBe("failed");
  expect(
    (
      await session.updatePolicy({
        provider: googleGenerate.id,
        thinking: "off",
        thinkingBudgetTokens: null,
      })
    ).kind,
  ).toBe("accepted");
  await session.input("google").settled;
  expect(session.snapshot.durable.continuations).toEqual(retained);
  const prepared = session.snapshot.durable.records.findLast(
    (r) =>
      r.body.kind === "event" &&
      r.body.event.type === "child" &&
      r.body.event.event.type === "prepared",
  );
  expect(JSON.stringify(prepared)).not.toContain('"continuations"');
  await Promise.all([session.close(), restored.close(), fork.close(), compact.close()]);
});

test("v4 staging rejects altered owners and prepared joins; load keeps stored envelopes", async () => {
  const { opts } = setup();
  const session = await createSession(opts);
  await session.input("Go").settled;
  const loaded = await opts.persistence.load(
    session.snapshot.durable.conversation.sessionId,
    new AbortController().signal,
  );
  if (loaded.kind !== "loaded") throw new Error("missing");
  const altered = (change: (entry: any) => void) =>
    loaded.batches.map((batch) => ({
      ...batch,
      records: batch.records.map((raw) => {
        const entry = JSON.parse(raw);
        change(entry);
        return JSON.stringify(entry);
      }),
    }));
  for (const record of session.snapshot.durable.records.filter(
    (r) =>
      r.body.kind === "created" ||
      (r.body.kind === "event" &&
        r.body.event.type === "child" &&
        ["prepared", "model_settled"].includes(r.body.event.event.type)),
  ))
    expect(() => decodeRecord(JSON.stringify({ ...record, version: 3 }))).toThrow();
  const staging = (batches: readonly CommittedBatch[], at: number) => {
    const body = decodeRecord(batches[at]!.records[0]!).body;
    if (body.kind !== "event") throw new Error("Expected an event record");
    return () =>
      stage(
        replay(loaded.batches.slice(0, at)),
        body,
        AppendIdSchema.parse(batches[at]!.appendId),
        resolvers,
      );
  };
  const settled = loaded.batches.findIndex((batch) => {
    const body = decodeRecord(batch.records[0]!).body;
    return (
      body.kind === "event" &&
      body.event.type === "child" &&
      body.event.event.type === "model_settled" &&
      body.event.event.continuation !== undefined
    );
  });
  const joined = loaded.batches.findIndex((batch) => {
    const body = decodeRecord(batch.records[0]!).body;
    return (
      body.kind === "event" &&
      body.event.type === "child" &&
      body.event.event.type === "prepared" &&
      body.event.event.result.kind === "succeeded" &&
      body.event.event.result.value.continuations !== undefined
    );
  });
  const moved = altered((e) => {
    const c = e.body.event?.event?.continuation;
    if (c) c.owner.generation++;
  });
  expect(staging(moved, settled)).toThrow("owner");
  expect(replay(moved).continuations).toEqual(
    session.snapshot.durable.continuations?.map((entry) => ({
      ...entry,
      owner: { ...entry.owner, generation: entry.owner.generation + 1 },
    })),
  );
  expect(() =>
    replay(
      altered((e) => {
        const c = e.body.event?.event?.continuation;
        if (c) c.payload = "x".repeat(65537);
      }),
    ),
  ).toThrow("record_decode");
  expect(
    staging(
      altered((e) => {
        const v = e.body.event?.event?.result?.value;
        if (v?.continuations) v.continuations = [];
      }),
      joined,
    ),
  ).toThrow("continuation mismatch");
  expect(
    replay(
      altered((e) => {
        e.body.event?.event?.result?.value?.continuations?.reverse();
      }),
    ).continuations,
  ).toEqual(session.snapshot.durable.continuations);
  await session.close();
});

test("indeterminate envelope append reconciles stable bytes before releasing tools", async () => {
  const { opts, bodies } = setup();
  const backing = opts.persistence;
  let lost = false;
  const persistence: SessionPersistence = {
    lifetime: backing.lifetime,
    putBlob: backing.putBlob.bind(backing),
    getBlob: backing.getBlob.bind(backing),
    load: backing.load.bind(backing),
    async append(request, signal) {
      const result = await backing.append(request, signal);
      if (!lost && request.records.some((raw) => JSON.parse(raw).body.event?.event?.continuation)) {
        lost = true;
        return { kind: "indeterminate", message: "lost receipt" };
      }
      return result;
    },
  };
  const session = await createSession({ ...opts, persistence });
  const settled = await session.input("Go").settled;
  expect(settled.kind === "terminal" && settled.record.outcome.kind).toBe("completed");
  expect(lost).toBe(true);
  expect(bodies).toHaveLength(3);
  expect(session.snapshot.durable.continuations).toHaveLength(3);
  await session.close();
});

test("handoff projection keeps only the envelope belonging to its retained assistant", async () => {
  const reply = (signature: string, content: unknown) => ({
    role: "assistant",
    stop_reason: "tool_use",
    content: [{ type: "thinking", thinking: "private", signature }, content],
  });
  const { opts, bodies } = setup([
    reply("tool-signature", { type: "tool_use", id: "c", name: "echo", input: {} }),
    reply("handoff-signature", {
      type: "tool_use",
      id: "h",
      name: "handoff_to",
      input: { agent: "b" },
    }),
    reply("answer-signature", { type: "text", text: "done" }),
  ]);
  const configured = {
    ...opts,
    configuration: {
      ...opts.configuration,
      agents: new Map([
        ["a", { model: "test", tools: ["echo"], successors: ["b"] }],
        ["b", { model: "test", tools: ["echo"], successors: [] }],
      ]),
    },
  };
  const session = await createSession(configured);
  const outcome = await session.input("Go").settled;
  expect(outcome.kind === "terminal" && outcome.record.outcome.kind).toBe("completed");
  expect(
    bodies[2]?.messages
      ?.filter((message) => message.role === "assistant")
      .map((message) => message.content[0]?.signature),
  ).toEqual(["handoff-signature"]);
  const restored = await restoreSession(
    configured,
    session.snapshot.durable.conversation.sessionId,
  );
  expect(bodies).toHaveLength(3);
  expect(restored.snapshot.durable.continuations).toHaveLength(3);
  await Promise.all([session.close(), restored.close()]);
});
