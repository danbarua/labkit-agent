import { getLogger } from "@logtape/logtape";
import { expect, spyOn, test } from "@logtape/testing-bun/autoload";
import { z } from "zod";

import { AppendIdSchema, RevisionSchema, type CommittedBatch } from "./persistence.ts";
import {
  decodeRecord,
  JournalIntegrityError,
  replay,
  stage,
  stageCreation,
  type JournalIntegrityRule,
  type JournalLocation,
} from "./session-log.ts";
import { createSession, restoreSession, type SessionOptions } from "./session-runtime.ts";
import { scriptedCompletion, testOptions } from "./test-support.ts";

type Edit = readonly [path: readonly (string | number)[], value: unknown];

function scripted() {
  return testOptions({
    complete: scriptedCompletion([
      { kind: "tools", text: "work", calls: [{ id: "c", name: "echo", args: { text: "result" } }] },
      { kind: "answer", text: "done" },
    ]),
  });
}

async function committed(options: SessionOptions = scripted()) {
  const session = await createSession(options);
  await session.updatePolicy({});
  await session.input("Go").settled;
  const durable = session.snapshot.durable;
  await session.close();
  const loaded = await options.persistence.load(
    durable.conversation.sessionId,
    new AbortController().signal,
  );
  if (loaded.kind !== "loaded") throw new Error("Expected a committed journal");
  return { options, durable, batches: loaded.batches };
}

/** Index of the nth batch holding a record of this kind; event records go by their event type. */
function position(batches: readonly CommittedBatch[], kind: string, nth = 0): number {
  const found = batches.flatMap((batch, index) =>
    batch.records.some((raw) => {
      const body = decodeRecord(raw).body;
      const recorded =
        body.kind !== "event"
          ? body.kind
          : body.event.type === "child"
            ? body.event.event.type
            : body.event.type;
      return recorded === kind;
    })
      ? [index]
      : [],
  )[nth];
  if (found === undefined) throw new Error(`No ${kind} record ${nth}`);
  return found;
}

/** Rewrite one record's bytes, as a damaged store or a writer with other rules would store them. */
function rewrite(
  batches: readonly CommittedBatch[],
  at: number,
  edits: readonly Edit[],
  index = 0,
): CommittedBatch[] {
  return batches.map((batch, current) =>
    current !== at
      ? batch
      : {
          ...batch,
          records: batch.records.map((raw, entry) => {
            if (entry !== index) return raw;
            const record: unknown = JSON.parse(raw);
            for (const [path, value] of edits) {
              let node = record as Record<string | number, unknown>;
              for (const key of path.slice(0, -1))
                node = node[key] as Record<string | number, unknown>;
              node[path.at(-1)!] = value;
            }
            return JSON.stringify(record);
          }),
        },
  );
}

function located(batches: readonly CommittedBatch[], at: number, index = 0): JournalLocation {
  const record = decodeRecord(batches[at]!.records[index]!);
  return { revision: record.revision, appendId: record.appendId, entryId: record.entryId };
}

/** Options whose store loads these batches, as a store holding exactly those bytes would. */
function serving(options: SessionOptions, batches: readonly CommittedBatch[]): SessionOptions {
  const port = options.persistence;
  return {
    ...options,
    persistence: {
      lifetime: port.lifetime,
      putBlob: port.putBlob.bind(port),
      getBlob: port.getBlob.bind(port),
      append: port.append.bind(port),
      async load(sessionId, signal) {
        const loaded = await port.load(sessionId, signal);
        return loaded.kind === "loaded" ? { ...loaded, batches } : loaded;
      },
    },
  };
}

function violation(load: () => unknown): JournalIntegrityError {
  try {
    load();
  } catch (error) {
    if (error instanceof JournalIntegrityError) return error;
    throw error;
  }
  throw new Error("The journal loaded");
}

const prompt = ["body", "event", "event", "result", "value"] as const;

test("a captured prompt that no longer matches today's projection loads as written", async () => {
  const { options, durable, batches } = await committed();
  const at = position(batches, "prepared");
  const changed = rewrite(batches, at, [
    [[...prompt, "model"], "retired-model"],
    [[...prompt, "messages", 0, "content"], "Agent A, as projected when the prompt was captured"],
    [[...prompt, "tools"], []],
  ]);
  const stored = decodeRecord(changed[at]!.records[0]!);
  const state = replay(changed);
  expect(state.records.find((record) => record.entryId === stored.entryId)).toEqual(stored);
  expect(state.conversation).toEqual(durable.conversation);
  const restored = await restoreSession(serving(options, changed), durable.conversation.sessionId);
  try {
    expect(
      restored.snapshot.durable.records.find((record) => record.entryId === stored.entryId),
    ).toEqual(stored);
  } finally {
    await restored.close();
  }
});

test("a policy record loads its stored policy, not the policy its patch derives today", async () => {
  const { durable, batches } = await committed();
  const at = position(batches, "policy");
  const changed = rewrite(batches, at, [
    [["body", "policy", "bargeIn"], false],
    [["body", "policy", "toolFailure"], "return-error-and-continue"],
  ]);
  const stored = decodeRecord(changed[at]!.records[0]!).body;
  if (stored.kind !== "policy") throw new Error("Expected the policy record");
  const state = replay(changed);
  expect(state.policy).toEqual(stored.policy);
  expect(state.policy).not.toEqual(durable.policy);
});

test("a terminal record is the log entry as committed, not the entry the fold derives", async () => {
  const { options, durable, batches } = await committed();
  const at = position(batches, "terminal");
  const index = batches[at]!.records.length - 1;
  const original = decodeRecord(batches[at]!.records[index]!).body;
  if (original.kind !== "terminal") throw new Error("Expected the terminal record");
  const changed = rewrite(
    batches,
    at,
    [[["body", "record", "messages", original.record.messages.length - 1, "text"], "as committed"]],
    index,
  );
  const stored = decodeRecord(changed[at]!.records[index]!).body;
  if (stored.kind !== "terminal") throw new Error("Expected the terminal record");
  const state = replay(changed);
  expect(state.conversation.log.at(-1)).toEqual(stored.record);
  expect(state.conversation.log.at(-1)?.messages.at(-1)).toMatchObject({ text: "as committed" });
  expect(durable.conversation.log.at(-1)?.messages.at(-1)).toMatchObject({ text: "done" });
  const restored = await restoreSession(serving(options, changed), durable.conversation.sessionId);
  try {
    expect(restored.snapshot.durable.conversation.log.at(-1)).toEqual(stored.record);
  } finally {
    await restored.close();
  }
});

const violations: readonly (readonly [
  name: string,
  corrupt: (batches: readonly CommittedBatch[]) => readonly CommittedBatch[],
  rule: JournalIntegrityRule,
  offending: (batches: readonly CommittedBatch[]) => JournalLocation,
])[] = [
  [
    "a revision gap",
    (batches) => batches.filter((_, index) => index !== position(batches, "model_settled")),
    "batch_continuity",
    (batches) => located(batches, position(batches, "model_settled") + 1),
  ],
  [
    "a record revision out of sequence",
    (batches) => rewrite(batches, position(batches, "user"), [[["revision"], 7]]),
    "revision_sequence",
    (batches) => ({ ...located(batches, position(batches, "user")), revision: 7 }),
  ],
  [
    "a duplicate appendId",
    (batches) => [...batches, batches.at(-1)!],
    "append_unique",
    (batches) => located(batches, batches.length - 1),
  ],
  [
    "a record of another session",
    (batches) =>
      rewrite(batches, position(batches, "user"), [
        [["sessionId"], "00000000-0000-4000-8000-999999999999"],
      ]),
    "session_identity",
    (batches) => located(batches, position(batches, "user")),
  ],
  [
    "a record of another append",
    (batches) => rewrite(batches, position(batches, "user"), [[["appendId"], "different"]]),
    "append_identity",
    (batches) => ({ ...located(batches, position(batches, "user")), appendId: "different" }),
  ],
  [
    "an entry ID out of format",
    (batches) => rewrite(batches, position(batches, "user"), [[["entryId"], "entry"]]),
    "entry_format",
    (batches) => ({ ...located(batches, position(batches, "user")), entryId: "entry" }),
  ],
  [
    "an undecodable record",
    (batches) =>
      batches.map((batch, index) =>
        index === position(batches, "user") ? { ...batch, records: ["{"] } : batch,
      ),
    "record_decode",
    (batches) => located(batches, position(batches, "user")),
  ],
  [
    "an unsupported record version",
    (batches) => rewrite(batches, position(batches, "user"), [[["version"], 2]]),
    "record_decode",
    (batches) => located(batches, position(batches, "user")),
  ],
  [
    "a credential field in a captured prompt",
    (batches) => rewrite(batches, position(batches, "prepared"), [[[...prompt, "apiKey"], "x"]]),
    "record_decode",
    (batches) => located(batches, position(batches, "prepared")),
  ],
  [
    "a missing creation record",
    (batches) => rewrite(batches, 0, [[["body"], { kind: "system", inputs: [], version: 1 }]]),
    "creation_first",
    (batches) => located(batches, 0),
  ],
  [
    "a missing terminal record",
    (batches) =>
      batches.map((batch, index) =>
        index === position(batches, "terminal")
          ? {
              ...batch,
              records: batch.records.slice(0, -1),
              revision: RevisionSchema.parse(batch.revision - 1),
            }
          : batch,
      ),
    "terminal_same_batch",
    (batches) => located(batches, position(batches, "terminal")),
  ],
  [
    "a terminal record of another turn",
    (batches) =>
      rewrite(batches, position(batches, "terminal"), [[["body", "turnId"], "other-turn"]], 1),
    "terminal_required",
    (batches) => located(batches, position(batches, "terminal"), 1),
  ],
  [
    "a terminal record without a turn transition",
    (batches) =>
      rewrite(batches, position(batches, "policy"), [
        [["body"], decodeRecord(batches[position(batches, "terminal")]!.records[1]!).body],
      ]),
    "terminal_unexpected",
    (batches) => located(batches, position(batches, "policy")),
  ],
  [
    "a tool result for a call the batch lacks",
    (batches) => rewrite(batches, position(batches, "tool"), [[["body", "callId"], "unknown"]]),
    "record_applicable",
    (batches) => located(batches, position(batches, "tool")),
  ],
];

for (const [name, corrupt, rule, offending] of violations)
  test(`load rejects ${name}, naming the rule and the record`, async () => {
    const { batches } = await committed();
    expect(violation(() => replay(corrupt(batches)))).toMatchObject({
      rule,
      ...offending(batches),
    });
  });

test("an empty journal has no creation record", () => {
  expect(violation(() => replay([]))).toMatchObject({ rule: "creation_first" });
});

test("staging still rejects records that break commit-time rules", async () => {
  const echo = testOptions().bindings.tools!.get("echo")!;
  const { batches } = await committed(
    testOptions({
      agents: new Map([
        ["a", { model: "m", systemPrompt: "Agent A", tools: ["echo", "other"] }],
        ["b", { model: "m", tools: ["echo"] }],
      ]),
      tools: new Map([
        ["echo", echo],
        ["other", echo],
      ]),
    }),
  );
  const staged = (at: number, edits: readonly Edit[]) => {
    const body = decodeRecord(rewrite(batches, at, edits)[at]!.records[0]!).body;
    if (body.kind !== "event") throw new Error("Expected an event record");
    return () =>
      stage(replay(batches.slice(0, at)), body, AppendIdSchema.parse(batches[at]!.appendId));
  };
  const prepared = position(batches, "prepared");
  expect(staged(prepared, [])().records).toEqual([...batches[prepared]!.records]);
  expect(staged(prepared, [[[...prompt, "model"], "retired-model"]])).toThrow(
    "Prompt model mismatch",
  );
  expect(staged(prepared, [[[...prompt, "messages", 0, "content"], "Agent A, reworded"]])).toThrow(
    "Prompt differs from captured session projection",
  );
  const advertised = decodeRecord(batches[prepared]!.records[0]!).body;
  if (
    advertised.kind !== "event" ||
    advertised.event.type !== "child" ||
    advertised.event.event.type !== "prepared" ||
    advertised.event.event.result.kind !== "succeeded"
  )
    throw new Error("Expected the captured prompt");
  expect(
    staged(prepared, [
      [[...prompt, "tools"], advertised.event.event.result.value.tools?.toReversed()],
    ]),
  ).toThrow("Prompt tool permissions mismatch");
  expect(staged(prepared, [[["body", "systemVersion"], 1]])).toThrow(
    "Turn system version mismatch",
  );
  expect(
    staged(position(batches, "model_settled"), [
      [["body", "event", "event", "permissionRequired"], true],
    ]),
  ).toThrow("Permission phase differs from captured policy");
  const created = decodeRecord(batches[0]!.records[0]!).body;
  if (created.kind !== "created") throw new Error("Expected the creation record");
  const tools = Object.fromEntries(
    Object.entries(created.seed.policy.tools).filter(([agent]) => agent !== "b"),
  );
  expect(() =>
    stageCreation(
      { ...created.seed, policy: { ...created.seed.policy, tools } },
      AppendIdSchema.parse(batches[0]!.appendId),
    ),
  ).toThrow("capabilities");
});

test("a restore that fails integrity logs the rule and the offending record", async () => {
  const records: { event: string; fields: Record<string, unknown> }[] = [];
  const logger = getLogger(["labkit", "session"]);
  const emit = logger.emit.bind(logger);
  const spy = spyOn(logger, "emit").mockImplementation((record) => {
    records.push({ event: String(record.rawMessage), fields: record.properties });
    emit(record);
  });
  try {
    const { options, durable, batches } = await committed();
    const sessionId = durable.conversation.sessionId;
    const dropped = position(batches, "model_settled");
    const gap = batches.filter((_, index) => index !== dropped);
    const offending = located(batches, dropped + 1);
    const error = await restoreSession(serving(options, gap), sessionId).catch(
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(JournalIntegrityError);
    expect(error).toMatchObject({ rule: "batch_continuity", ...offending });
    expect(
      records.find((record) => record.event === "session.restore_failed")?.fields,
    ).toMatchObject({
      sessionId,
      stage: "replay_journal",
      rule: "batch_continuity",
      ...offending,
      error: { name: "JournalIntegrityError" },
    });
  } finally {
    spy.mockRestore();
  }
});

const newerBuild: readonly (readonly [name: string, edits: readonly Edit[], named: string])[] = [
  ["an unknown record kind", [[["body"], { kind: "future_kind" }]], 'kind "future_kind"'],
  ["a newer record version", [[["version"], 2]], "version 2"],
];

for (const [name, edits, named] of newerBuild)
  test(`load reports ${name} as written by a newer Labkit build`, async () => {
    const records: { event: string; fields: Record<string, unknown> }[] = [];
    const logger = getLogger(["labkit", "session"]);
    const emit = logger.emit.bind(logger);
    const spy = spyOn(logger, "emit").mockImplementation((record) => {
      records.push({ event: String(record.rawMessage), fields: record.properties });
      emit(record);
    });
    try {
      const { options, durable, batches } = await committed();
      const sessionId = durable.conversation.sessionId;
      const at = position(batches, "user");
      const offending = located(batches, at);
      const error = await restoreSession(
        serving(options, rewrite(batches, at, edits)),
        sessionId,
      ).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(JournalIntegrityError);
      expect(error).toMatchObject({ rule: "record_decode", ...offending });
      const message = (error as Error).message;
      expect(message).toContain(named);
      expect(message).toContain("written by a newer Labkit build");
      expect(message).toContain("restart the launcher on current code");
      expect((error as Error).cause).toBeInstanceOf(z.ZodError);
      expect(
        records.find((record) => record.event === "session.restore_failed")?.fields,
      ).toMatchObject({
        sessionId,
        stage: "replay_journal",
        rule: "record_decode",
        ...offending,
        error: { name: "JournalIntegrityError", message },
      });
    } finally {
      spy.mockRestore();
    }
  });

test("load reports a record that is not JSON as unreadable, not as a newer build", async () => {
  const { batches } = await committed();
  const at = position(batches, "user");
  const error = violation(() =>
    replay(batches.map((batch, index) => (index === at ? { ...batch, records: ["{"] } : batch))),
  );
  expect(error).toMatchObject({ rule: "record_decode", ...located(batches, at) });
  expect(error.message).toContain("not valid JSON");
  expect(error.message).not.toContain("newer Labkit build");
});
