import { expect, test } from "@logtape/testing-bun/autoload";

import { RevisionSchema, type CommittedBatch } from "./persistence.ts";
import { decodeRecord, encodeRecord, replay } from "./session-log.ts";
import { createSession } from "./session-runtime.ts";
import { scriptedCompletion, testOptions } from "./test-support.ts";

async function fixture() {
  const options = testOptions({
    complete: scriptedCompletion([
      { kind: "tools", text: "work", calls: [{ id: "c", name: "echo", args: { text: "result" } }] },
      { kind: "answer", text: "done" },
    ]),
  });
  const session = await createSession(options);
  await session.input("Go").settled;
  const loaded = await options.persistence.load(
    session.snapshot.durable.conversation.sessionId,
    new AbortController().signal,
  );
  if (loaded.kind !== "loaded") throw new Error("Expected stream");
  return { session, batches: loaded.batches };
}
function corrupt(batches: readonly CommittedBatch[], change: (record: any) => void) {
  return batches.map((batch) => ({
    ...batch,
    records: batch.records.map((serialized) => {
      const record = JSON.parse(serialized);
      change(record);
      return JSON.stringify(record);
    }),
  }));
}
test("codec round trips frozen values and replay reproduces durable state", async () => {
  const { session, batches } = await fixture();
  expect(replay(batches)).toEqual(session.snapshot.durable);
  const record = decodeRecord(batches[0]!.records[0]!);
  expect(Object.isFrozen(record.body)).toBe(true);
  expect(encodeRecord(record)).toBe(batches[0]!.records[0]!);
});
test("rejects unsupported versions, changed identities, discontinuity and duplicate entries", async () => {
  const { batches } = await fixture();
  for (const mutate of [
    (r: any) => {
      r.version = 2;
    },
    (r: any) => {
      r.sessionId = "00000000-0000-4000-8000-999999999999";
    },
    (r: any) => {
      r.revision++;
    },
    (r: any) => {
      r.entryId = "duplicate";
    },
    (r: any) => {
      r.appendId = "different";
    },
  ])
    expect(() => replay(corrupt(batches, mutate))).toThrow();
});
test("rejects corrupted terminal, system version, tool correlation and credential fields", async () => {
  const { batches } = await fixture();
  for (const mutate of [
    (r: any) => {
      if (r.body.kind === "terminal") r.body.record.messages = [];
    },
    (r: any) => {
      if (r.body.kind === "event") r.body.systemVersion++;
    },
    (r: any) => {
      if (r.body.kind === "tool") r.body.callId = "unknown";
    },
    (r: any) => {
      if (r.body.event?.event?.type === "prepared")
        r.body.event.event.result.value.apiKey = "secret";
    },
  ])
    expect(() => replay(corrupt(batches, mutate))).toThrow();
});
test("terminal and transition share a batch; duplicate append batches are rejected", async () => {
  const { batches } = await fixture();
  const last = batches.at(-1)!;
  expect(() => replay([...batches, last])).toThrow();
  const records = last.records.slice(0, -1);
  expect(() =>
    replay([
      ...batches.slice(0, -1),
      { ...last, records, revision: RevisionSchema.parse(last.expectedRevision + records.length) },
    ]),
  ).toThrow();
});

test("v2 replay rejects policy version drift, downgrade, and advertised tool escalation", async () => {
  const options = testOptions();
  const session = await createSession(options);
  await session.updatePolicy({ tools: { a: [] } });
  await session.input("Go").settled;
  const loaded = await options.persistence.load(
    session.snapshot.durable.conversation.sessionId,
    new AbortController().signal,
  );
  if (loaded.kind !== "loaded") throw new Error("Expected stream");
  for (const mutate of [
    (r: any) => {
      if (r.body.kind === "policy") r.body.policy.version++;
    },
    (r: any) => {
      if (r.body.kind === "event") r.body.policyVersion++;
    },
    (r: any) => {
      if (r.body.kind === "policy") r.version = 1;
    },
    (r: any) => {
      if (r.body.event?.event?.type === "prepared")
        r.body.event.event.result.value.tools = [
          { type: "function", function: { name: "echo", parameters: {} } },
        ];
    },
  ])
    expect(() => replay(corrupt(loaded.batches, mutate))).toThrow();
});

test("replay requires policy agent coverage and the original advertised tool ordering", async () => {
  const original = testOptions();
  const options = testOptions({
    agents: new Map([
      ["a", { model: "m", tools: ["echo", "other"] }],
      ["b", { model: "m", tools: ["echo"] }],
    ]),
    tools: new Map([
      ["echo", original.tools!.get("echo")!],
      ["other", original.tools!.get("echo")!],
    ]),
  });
  const session = await createSession(options);
  await session.updatePolicy({});
  await session.input("go").settled;
  const loaded = await options.persistence.load(
    session.snapshot.durable.conversation.sessionId,
    new AbortController().signal,
  );
  if (loaded.kind !== "loaded") throw new Error("Expected stream");
  expect(replay(loaded.batches)).toEqual(session.snapshot.durable);
  expect(() =>
    replay(
      corrupt(loaded.batches, (record) => {
        if (record.body.kind === "upgrade") delete record.body.policy.tools.b;
      }),
    ),
  ).toThrow("capabilities");
  expect(() =>
    replay(
      corrupt(loaded.batches, (record) => {
        if (record.body.event?.event?.type === "prepared")
          record.body.event.event.result.value.tools.reverse();
      }),
    ),
  ).toThrow("Prompt tool permissions mismatch");
  await session.close();
});
