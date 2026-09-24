import { expect, test } from "@logtape/testing-bun/autoload";
import { z } from "zod";

import { PreparedModelSchema } from "../agent/agent.ts";
import { SessionIdSchema } from "../agent/types.ts";
import {
  ContinuationSchema,
  googleGenerateV2,
  openaiResponsesV2,
  type CompletionProfile,
} from "../providers/index.ts";
import { continuationPayload } from "../providers/shared.ts";
import { resolveRequestBlobs, storeContinuation } from "./blobs.ts";
import { decodeRecord, journalJSONL } from "./session-log.ts";
import {
  createSession,
  defineTool,
  restoreSession,
  type BoundSessionOptions,
} from "./session-runtime.ts";
import { deferred, deterministicIds, until } from "./test-support.ts";
import { createMemoryPersistence } from "./testing/memory-persistence.ts";

const signal = () => new AbortController().signal;
const owner = { turnId: "turn", generation: 1 };

test("continuation representation boundary, operation-only resolution, and exclusive schema", async () => {
  const base = createMemoryPersistence();
  let reads = 0;
  let puts = 0;
  const port = {
    ...base,
    getBlob: async (...args: Parameters<typeof base.getBlob>) => {
      reads++;
      return base.getBlob(...args);
    },
    putBlob: async (...args: Parameters<typeof base.putBlob>) => {
      puts++;
      return base.putBlob(...args);
    },
  };
  const sessionId = SessionIdSchema.parse(deterministicIds()());
  for (const length of [10, 65536, 65537, 70 * 1024]) {
    const payload = "x".repeat(length - 2); // Quotes count toward the serialized JSON cap.
    const entry = await storeContinuation(
      port,
      sessionId,
      {
        provider: googleGenerateV2.id,
        owner: ContinuationSchema.parse({ provider: googleGenerateV2.id, owner, payload: null })
          .owner,
        payload,
      },
      signal(),
    );
    expect(entry.payload !== undefined).toBe(length <= 65536);
    expect(entry.payloadBlob !== undefined).toBe(length > 65536);
    const request = PreparedModelSchema.parse({
      model: "test",
      provider: googleGenerateV2.id,
      messages: [{ role: "assistant", content: "answer", owner }],
      continuations: [entry],
    });
    const before = reads;
    await resolveRequestBlobs(port, sessionId, request, [], signal());
    expect(reads).toBe(before);
    const blobs = await resolveRequestBlobs(port, sessionId, request, [], signal(), true);
    expect(continuationPayload(entry, blobs)).toBe(payload);
    expect(reads - before).toBe(length > 65536 ? 1 : 0);
    if (entry.payloadBlob) {
      expect(() => ContinuationSchema.parse({ ...entry, payload })).toThrow();
      expect(() => continuationPayload(entry, () => new Uint8Array())).toThrow("do not match");
    }
  }
  expect(puts).toBe(2);
  expect(() => ContinuationSchema.parse({ provider: googleGenerateV2.id, owner })).toThrow();
});

function setup(profile: CompletionProfile) {
  const base = createMemoryPersistence();
  const bodies: any[] = [];
  const lifecycle: string[] = [];
  const secret = "X".repeat(70 * 1024);
  let count = 0;
  const opts: BoundSessionOptions = {
    persistence: {
      ...base,
      putBlob: async (...args) => {
        lifecycle.push("put");
        return base.putBlob(...args);
      },
      getBlob: async (...args) => {
        lifecycle.push("get");
        return base.getBlob(...args);
      },
      append: async (request, abort) => {
        for (const raw of request.records) {
          const event = JSON.parse(raw).body.event?.event;
          if (event?.type === "prepared") lifecycle.push("prepared");
          if (event?.continuation) lifecycle.push("settled");
        }
        return base.append(request, abort);
      },
    },
    configuration: {
      agent: "a",
      agents: new Map([["a", { model: "fixture-model", tools: ["echo"], successors: [] }]]),
      steps: 4,
      policy: {
        provider: profile.id,
        thinking: profile === googleGenerateV2 ? "adaptive" : "high",
      },
    },
    bindings: {
      id: deterministicIds(),
      tools: new Map([
        [
          "echo",
          defineTool({
            input: z.object({}),
            run: () => {
              lifecycle.push("tool");
              return "ok";
            },
          }),
        ],
      ]),
      providers: new Map([
        [
          profile.id,
          {
            profile,
            transport: {
              baseUrl: "https://example.invalid",
              fetch: (async (_url, init) => {
                lifecycle.push("fetch");
                bodies.push(JSON.parse(String(init?.body)));
                const round = count++;
                return Response.json(
                  profile === googleGenerateV2
                    ? {
                        candidates: [
                          {
                            finishReason: "STOP",
                            content: {
                              role: "model",
                              parts:
                                round === 0
                                  ? [
                                      {
                                        functionCall: { id: "c", name: "echo", args: {} },
                                        thoughtSignature: secret,
                                      },
                                    ]
                                  : [{ text: "done" }],
                            },
                          },
                        ],
                      }
                    : {
                        status: "completed",
                        output:
                          round === 0
                            ? [
                                {
                                  type: "reasoning",
                                  id: "rs_0",
                                  summary: [],
                                  encrypted_content: secret,
                                },
                                {
                                  type: "function_call",
                                  call_id: "c",
                                  name: "echo",
                                  arguments: "{}",
                                },
                              ]
                            : [
                                {
                                  type: "message",
                                  role: "assistant",
                                  content: [{ type: "output_text", text: "done" }],
                                },
                              ],
                      },
                );
              }) as typeof fetch,
            },
          },
        ],
      ]),
    },
  };
  return { opts, bodies, lifecycle, secret, base };
}

for (const profile of [googleGenerateV2, openaiResponsesV2])
  test(`${profile.id}: large continuations journal refs, restore lazily, fork copies and compact drops`, async () => {
    const { opts, bodies, lifecycle, secret, base } = setup(profile);
    const session = await createSession(opts);
    const result = await session.input("Go").settled;
    expect(result.kind === "terminal" && result.record.outcome.kind).toBe("completed");
    expect(JSON.stringify(bodies[1])).toContain(secret);
    const durable = session.snapshot.durable;
    const entry = durable.continuations![0]!;
    expect(entry.payload).toBeUndefined();
    expect(entry.payloadBlob).toBeDefined();
    expect(journalJSONL(durable)).not.toContain(secret);
    expect(lifecycle).toEqual([
      "prepared",
      "fetch",
      "put",
      "settled",
      "tool",
      "prepared",
      "get",
      "fetch",
    ]);
    const settled = durable.records.find(
      (record) =>
        record.body.kind === "event" &&
        record.body.event.type === "child" &&
        record.body.event.event.type === "model_settled" &&
        record.body.event.event.continuation,
    )!;
    expect(settled.version).toBe(5);
    expect(() => decodeRecord(JSON.stringify({ ...settled, version: 4 }))).toThrow();
    const prepared = durable.records.findLast(
      (record) =>
        record.body.kind === "event" &&
        record.body.event.type === "child" &&
        record.body.event.event.type === "prepared",
    )!;
    expect(() => decodeRecord(JSON.stringify({ ...prepared, version: 4 }))).toThrow();
    const before = lifecycle.length;
    const restored = await restoreSession(opts, durable.conversation.sessionId);
    expect(lifecycle.length).toBe(before);
    expect(restored.snapshot.durable.continuations).toEqual(durable.continuations);
    const fork = await session.fork();
    expect(
      await base.getBlob(
        fork.snapshot.durable.conversation.sessionId,
        entry.payloadBlob!.id,
        signal(),
      ),
    ).not.toEqual({ kind: "not_found" });
    const created = fork.snapshot.durable.records[0]!;
    expect(() => decodeRecord(JSON.stringify({ ...created, version: 4 }))).toThrow();
    await fork.input("Next").settled;
    expect(JSON.stringify(bodies.at(-1))).toContain(secret);
    const compact = await session.compact([]);
    expect(compact.snapshot.durable.continuations ?? []).toEqual([]);
    expect(
      await base.getBlob(
        compact.snapshot.durable.conversation.sessionId,
        entry.payloadBlob!.id,
        signal(),
      ),
    ).toEqual({ kind: "not_found" });
    await Promise.all([session, restored, fork, compact].map((item) => item.close()));
  });

test("blob write failure or cancellation cannot journal a continuation or release tools", async () => {
  for (const cancel of [false, true]) {
    const { opts, lifecycle } = setup(openaiResponsesV2);
    const gate = deferred<void>();
    let writeSignal: AbortSignal | undefined;
    const session = await createSession({
      ...opts,
      persistence: {
        ...opts.persistence,
        putBlob: async (...args) => {
          writeSignal = args[3];
          if (cancel) await gate.promise;
          throw new Error("write failed");
        },
      },
    });
    const pending = session.input("Go").settled;
    await until(() => !!writeSignal);
    if (cancel) {
      await session.dispatch({ type: "abort" });
      await until(() => writeSignal!.aborted);
      expect(writeSignal!.aborted).toBe(true);
      gate.resolve();
    }
    const result = await pending;
    expect(result.kind === "terminal" && result.record.outcome.kind).toBe(
      cancel ? "aborted" : "failed",
    );
    expect(session.snapshot.durable.continuations ?? []).toEqual([]);
    expect(lifecycle).not.toContain("tool");
    await session.close();
  }
});
