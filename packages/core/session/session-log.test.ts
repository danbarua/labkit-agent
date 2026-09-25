import { expect, test } from "@logtape/testing-bun/autoload";

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

test("codec round trips frozen values and replay reproduces durable state", async () => {
  const { session, batches } = await fixture();
  expect(replay(batches)).toEqual(session.snapshot.durable);
  const record = decodeRecord(batches[0]!.records[0]!);
  expect(Object.isFrozen(record.body)).toBe(true);
  expect(encodeRecord(record)).toBe(batches[0]!.records[0]!);
});
