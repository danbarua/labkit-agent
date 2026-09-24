import { expect, test } from "@logtape/testing-bun/autoload";
import { z } from "zod";

import { BlobRefSchema, hashBlob } from "../agent/content.ts";
import { builtinResolvers } from "../policy/policy.ts";
import { anthropicMessagesV2, openaiChat, type CompletionProfile } from "../providers/index.ts";
import { decodeRecord, journalJSONL, replay } from "./session-log.ts";
import {
  createSession,
  defineTool,
  restoreSession,
  type BoundSessionOptions,
} from "./session-runtime.ts";
import { deferred, deterministicIds, testOptions, until } from "./test-support.ts";
import { createMemoryPersistence } from "./testing/memory-persistence.ts";

function setup(profile: CompletionProfile = openaiChat) {
  const bodies: any[] = [];
  const port = createMemoryPersistence();
  let reads = 0;
  const opts: BoundSessionOptions = {
    persistence: {
      ...port,
      getBlob: async (...args) => {
        reads++;
        return port.getBlob(...args);
      },
    },
    configuration: {
      agent: "a",
      agents: new Map([["a", { model: "fixture-model", tools: [], successors: [] }]]),
      steps: 3,
      policy: {
        provider: profile.id,
        ...(profile === anthropicMessagesV2 ? { thinking: "adaptive", maxOutputTokens: 2048 } : {}),
      },
    },
    bindings: {
      id: deterministicIds(),
      providers: new Map([
        [
          profile.id,
          {
            profile,
            transport: {
              baseUrl: "https://example.invalid",
              fetch: (async (_url, init) => {
                bodies.push(JSON.parse(String(init?.body)));
                return Response.json(
                  profile === anthropicMessagesV2
                    ? {
                        role: "assistant",
                        stop_reason: "end_turn",
                        content: [
                          { type: "thinking", thinking: "private", signature: "sig" },
                          { type: "text", text: "done" },
                        ],
                      }
                    : { choices: [{ message: { content: "done" } }] },
                );
              }) as typeof fetch,
            },
          },
        ],
      ]),
    },
  };
  return { opts, bodies, reads: () => reads };
}
const signal = () => new AbortController().signal;
const bytes = new TextEncoder().encode("# DESIGN\nAttachment bytes stay outside the journal.");

test("markdown refs commit without bytes, restore does not read blobs, fork and compact copy cited refs", async () => {
  const { opts, bodies, reads } = setup();
  const session = await createSession(opts);
  const id = session.snapshot.durable.conversation.sessionId;
  const ref = await opts.persistence.putBlob(
    id,
    bytes,
    { media: "text/markdown", name: "DESIGN.md" },
    signal(),
  );
  const unused = await opts.persistence.putBlob(
    id,
    new Uint8Array([9]),
    { media: "image/png" },
    signal(),
  );
  const result = await session.input({ text: "Review", attachments: [ref] }).settled;
  expect(result.kind === "terminal" && result.record.outcome.kind).toBe("completed");
  expect(bodies[0].messages).toContainEqual({
    role: "user",
    content: `Review\n${new TextDecoder().decode(bytes)}`,
  });
  expect(journalJSONL(session.snapshot.durable)).toContain(ref.id);
  expect(journalJSONL(session.snapshot.durable)).not.toContain("Attachment bytes stay");
  const v5 = session.snapshot.durable.records.find(
    (r) => r.body.kind === "event" && r.body.event.type === "user",
  )!;
  expect(v5.version).toBe(5);
  expect(() => decodeRecord(JSON.stringify({ ...v5, version: 4 }))).toThrow();
  const before = reads();
  const restored = await restoreSession(opts, id);
  expect(reads()).toBe(before);
  expect(bodies).toHaveLength(1);
  const fork = await session.fork();
  expect(
    await opts.persistence.getBlob(fork.snapshot.durable.conversation.sessionId, ref.id, signal()),
  ).toEqual({ meta: ref, bytes });
  await fork.input("Next").settled;
  expect(JSON.stringify(bodies.at(-1))).toContain("Attachment bytes stay");
  const compact = await session.compact([
    { role: "user", text: "", parts: [{ type: "blob", ref }] },
  ]);
  const compactId = compact.snapshot.durable.conversation.sessionId;
  expect(await opts.persistence.getBlob(compactId, ref.id, signal())).toEqual({ meta: ref, bytes });
  expect(await opts.persistence.getBlob(compactId, unused.id, signal())).toEqual({
    kind: "not_found",
  });
  const empty = await session.compact([]);
  expect(
    await opts.persistence.getBlob(empty.snapshot.durable.conversation.sessionId, ref.id, signal()),
  ).toEqual({ kind: "not_found" });
  expect(await opts.persistence.getBlob(id, unused.id, signal())).not.toEqual({
    kind: "not_found",
  });
  await compact.input("Review compacted").settled;
  expect(JSON.stringify(bodies.at(-1))).toContain("Attachment bytes stay");
  const reopened = await restoreSession(opts, id);
  const continued = await reopened.input("Restored next").settled;
  expect(continued.kind === "terminal" && continued.record.outcome.kind).toBe("completed");
  expect(JSON.stringify(bodies.at(-1))).toContain("Attachment bytes stay");
  await Promise.all([session, restored, reopened, fork, compact, empty].map((s) => s.close()));
});

for (const kind of ["missing", "unsupported", "pdf"] as const)
  test(`${kind} attachment fails prepare without HTTP`, async () => {
    const { opts, bodies, reads } = setup();
    const session = await createSession(opts);
    const id = session.snapshot.durable.conversation.sessionId;
    const ref =
      kind === "missing"
        ? BlobRefSchema.parse({ id: hashBlob(bytes), bytes: bytes.length, media: "text/plain" })
        : await opts.persistence.putBlob(
            id,
            bytes,
            { media: kind === "pdf" ? "application/pdf" : "image/png" },
            signal(),
          );
    const result = await session.input({ attachments: [ref] }).settled;
    expect(result.kind === "terminal" && result.record.outcome.kind).toBe("failed");
    expect(bodies).toHaveLength(0);
    if (kind !== "missing") expect(reads()).toBe(0);
    const prepared = session.snapshot.durable.records.find(
      (r) =>
        r.body.kind === "event" &&
        r.body.event.type === "child" &&
        r.body.event.event.type === "prepared",
    );
    expect(prepared).toMatchObject({ body: { event: { event: { result: { kind: "failed" } } } } });
    await session.close();
  });

test("thinking and image attachments retain independent owners and refs across turns", async () => {
  const { opts, bodies } = setup(anthropicMessagesV2);
  const session = await createSession(opts);
  const ref = await opts.persistence.putBlob(
    session.snapshot.durable.conversation.sessionId,
    new Uint8Array([1, 2, 3]),
    { media: "image/png" },
    signal(),
  );
  await session.input({ attachments: [ref] }).settled;
  await session.input("Next").settled;
  expect(bodies[0].messages[0].content).toEqual([
    { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
  ]);
  expect(bodies[1].messages[1].content[0]).toEqual({
    type: "thinking",
    thinking: "private",
    signature: "sig",
  });
  const [user, assistant] = session.snapshot.durable.conversation.log[0]!.messages;
  expect(user).toMatchObject({ role: "user", parts: [{ type: "blob", ref }] });
  expect(assistant).not.toHaveProperty("parts");
  expect(assistant).toHaveProperty("owner");
  const loaded = await opts.persistence.load(
    session.snapshot.durable.conversation.sessionId,
    signal(),
  );
  if (loaded.kind !== "loaded") throw new Error("Missing journal");
  expect(
    replay(loaded.batches, { ...builtinResolvers, providerIds: new Set([anthropicMessagesV2.id]) }),
  ).toEqual(session.snapshot.durable);
  const restored = await restoreSession(opts, session.snapshot.durable.conversation.sessionId);
  await Promise.all([session.close(), restored.close()]);
});

test("queued attachment input retains refs until its turn", async () => {
  const { opts, bodies } = setup();
  const release = deferred<Response>();
  const profileBinding = opts.bindings.providers!.get(openaiChat.id)!;
  let started = false;
  const session = await createSession({
    ...opts,
    configuration: {
      ...opts.configuration,
      policy: { ...opts.configuration.policy, id: "queued@1" },
    },
    bindings: {
      ...opts.bindings,
      providers: new Map([
        [
          openaiChat.id,
          {
            ...profileBinding,
            transport: {
              ...profileBinding.transport,
              fetch: (async (...args: Parameters<typeof fetch>) => {
                if (!started) {
                  started = true;
                  return release.promise;
                }
                return profileBinding.transport.fetch!(...args);
              }) as typeof fetch,
            },
          },
        ],
      ]),
    },
  });
  const ref = await opts.persistence.putBlob(
    session.snapshot.durable.conversation.sessionId,
    bytes,
    { media: "text/markdown" },
    signal(),
  );
  const first = session.input("First");
  await until(() => started);
  const queued = session.input({ attachments: [ref] });
  expect((await queued.accepted).kind).toBe("accepted");
  release.resolve(Response.json({ choices: [{ message: { content: "done" } }] }));
  await first.settled;
  const result = await queued.settled;
  expect(result.kind === "terminal" && result.record.outcome.kind).toBe("completed");
  expect(JSON.stringify(bodies.at(-1))).toContain("Attachment bytes stay");
  const restored = await restoreSession(opts, session.snapshot.durable.conversation.sessionId);
  await Promise.all([session.close(), restored.close()]);
});

test("prepared refs commit before completion reads bytes or fetches", async () => {
  const { opts, bodies, reads } = setup();
  const release = deferred<void>();
  let blocked = false;
  let preparedJSON = "";
  const backing = opts.persistence;
  const session = await createSession({
    ...opts,
    persistence: {
      ...backing,
      async append(request, signal) {
        if (request.records.some((raw) => JSON.parse(raw).body.event?.event?.type === "prepared")) {
          preparedJSON = request.records.join("\n");
          blocked = true;
          await release.promise;
        }
        return backing.append(request, signal);
      },
    },
  });
  const ref = await backing.putBlob(
    session.snapshot.durable.conversation.sessionId,
    bytes,
    { media: "text/plain" },
    signal(),
  );
  const handle = session.input({ attachments: [ref] });
  await until(() => blocked);
  expect(reads()).toBe(1);
  expect(bodies).toHaveLength(0);
  expect(preparedJSON).toContain(ref.id);
  expect(preparedJSON).not.toContain("Attachment bytes stay");
  release.resolve();
  const result = await handle.settled;
  expect(result.kind === "terminal" && result.record.outcome.kind).toBe("completed");
  expect(reads()).toBe(2);
  expect(bodies).toHaveLength(1);
  await session.close();
});

test("abort during a blob read cancels preparation and prevents late HTTP", async () => {
  const { opts, bodies } = setup();
  const backing = opts.persistence;
  const release = deferred<void>();
  let readSignal: AbortSignal | undefined;
  const session = await createSession({
    ...opts,
    persistence: {
      ...backing,
      async getBlob(sessionId, id, signal) {
        readSignal = signal;
        await release.promise;
        return backing.getBlob(sessionId, id, new AbortController().signal);
      },
    },
  });
  const ref = await backing.putBlob(
    session.snapshot.durable.conversation.sessionId,
    bytes,
    { media: "text/markdown" },
    signal(),
  );
  const handle = session.input({ attachments: [ref] });
  await until(() => readSignal !== undefined);
  await session.fire({ type: "abort" });
  expect(readSignal!.aborted).toBe(true);
  release.resolve();
  const outcome = await handle.settled;
  expect(outcome.kind === "terminal" && outcome.record.outcome.kind).toBe("aborted");
  await session.close();
  expect(bodies).toHaveLength(0);
});

test("v5 structural gate covers created, prepared, terminal and compact context refs", async () => {
  const { opts } = setup();
  const session = await createSession(opts);
  const ref = await opts.persistence.putBlob(
    session.snapshot.durable.conversation.sessionId,
    bytes,
    { media: "text/plain" },
    signal(),
  );
  await session.input({ attachments: [ref] }).settled;
  const child = await session.compact([{ role: "user", text: "", parts: [{ type: "blob", ref }] }]);
  for (const entry of [...session.snapshot.durable.records, ...child.snapshot.durable.records]) {
    if (JSON.stringify(entry.body).includes(ref.id))
      expect(() => decodeRecord(JSON.stringify({ ...entry, version: 4 }))).toThrow();
  }
  await Promise.all([session.close(), child.close()]);
});

test("legacy attachment admission upgrades before v5 without rewriting old records", async () => {
  const opts = testOptions();
  const session = await createSession(opts);
  const old = journalJSONL(session.snapshot.durable);
  const ref = await opts.persistence.putBlob(
    session.snapshot.durable.conversation.sessionId,
    bytes,
    { media: "text/plain" },
    signal(),
  );
  await session.input({ attachments: [ref] }).settled;
  expect(journalJSONL(session.snapshot.durable).startsWith(old)).toBe(true);
  expect(session.snapshot.durable.records.slice(0, 3).map((r) => r.version)).toEqual([1, 2, 5]);
  const restored = await restoreSession(opts, session.snapshot.durable.conversation.sessionId);
  expect(restored.snapshot.durable).toEqual(session.snapshot.durable);
  await Promise.all([session.close(), restored.close()]);
});

test("attachment queued while aborting tools keeps both records in v5", async () => {
  const { opts } = setup(anthropicMessagesV2);
  let toolStarted = false;
  let attempts = 0;
  const binding = opts.bindings.providers!.get(anthropicMessagesV2.id)!;
  const configured: BoundSessionOptions = {
    ...opts,
    configuration: {
      ...opts.configuration,
      agents: new Map([["a", { model: "fixture-model", tools: ["wait"], successors: [] }]]),
      policy: { ...opts.configuration.policy, admission: "abort-tools-on-user" },
    },
    bindings: {
      ...opts.bindings,
      tools: new Map([
        [
          "wait",
          defineTool({
            input: z.object({}),
            run: (_, signal) => {
              toolStarted = true;
              return new Promise((_, reject) =>
                signal.addEventListener("abort", () => reject(new Error("cancelled")), {
                  once: true,
                }),
              );
            },
          }),
        ],
      ]),
      providers: new Map([
        [
          anthropicMessagesV2.id,
          {
            ...binding,
            transport: {
              ...binding.transport,
              fetch: (async () =>
                Response.json({
                  role: "assistant",
                  stop_reason: attempts === 0 ? "tool_use" : "end_turn",
                  content: [
                    attempts++ === 0
                      ? { type: "tool_use", id: "call", name: "wait", input: {} }
                      : { type: "text", text: "done" },
                  ],
                })) as unknown as typeof fetch,
            },
          },
        ],
      ]),
    },
  };
  const session = await createSession(configured);
  const ref = await opts.persistence.putBlob(
    session.snapshot.durable.conversation.sessionId,
    bytes,
    { media: "text/markdown" },
    signal(),
  );
  const first = session.input("Wait");
  await until(() => toolStarted);
  const next = session.input({ attachments: [ref] });
  const result = await next.settled;
  await first.settled;
  expect(result.kind === "terminal" && result.record.outcome.kind).toBe("completed");
  const queued = session.snapshot.durable.records.find((r) => r.body.kind === "queued")!;
  const batch = session.snapshot.durable.records.filter((r) => r.appendId === queued.appendId);
  expect(batch).toHaveLength(2);
  expect(batch.map((r) => r.version)).toEqual([5, 5]);
  const restored = await restoreSession(
    configured,
    session.snapshot.durable.conversation.sessionId,
  );
  expect(restored.snapshot.durable).toEqual(session.snapshot.durable);
  await Promise.all([session.close(), restored.close()]);
});

test("public user input requires content, accepts empty attachment lists with text, and rejects raw bytes", async () => {
  const { opts } = setup();
  const session = await createSession(opts);
  expect(() => session.input({})).toThrow("requires text or attachments");
  expect(() => session.input({ attachments: [] })).toThrow("requires text or attachments");
  expect(() => session.dispatch({ type: "user", attachments: [bytes] })).toThrow();
  const result = await session.input({ text: "Text only", attachments: [] }).settled;
  expect(result.kind === "terminal" && result.record.outcome.kind).toBe("completed");
  expect(session.snapshot.durable.records.every((record) => record.version === 3)).toBe(true);
  await session.close();
});
