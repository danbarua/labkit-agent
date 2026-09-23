import { expect, test } from "bun:test";
import { persistenceContract } from "./testing/persistence-contract.ts";
import { createMemoryBacking, createMemoryPersistence } from "./testing/memory-persistence.ts";
import { lostAcknowledgement, testOptions } from "./test-support.ts";
import { createSession } from "./session-runtime.ts";
persistenceContract("process-local reference", () => {
  const backing = createMemoryBacking();
  return {
    writer: createMemoryPersistence(backing),
    reader: () => createMemoryPersistence(backing),
  };
});
test("creation reconciles a committed write with a lost acknowledgement", async () => {
  const port = createMemoryPersistence();
  const session = await createSession(testOptions({ persistence: lostAcknowledgement(port) }));
  expect(Number(session.snapshot.durable.revision)).toBe(1);
});

test("lost acknowledgements expose committed append IDs to independent readers", async () => {
  const backing = createMemoryBacking();
  const writer = lostAcknowledgement(createMemoryPersistence(backing));
  const reader = createMemoryPersistence(backing);
  const session = await createSession(testOptions({ persistence: writer }));
  const loaded = await reader.load(
    session.snapshot.durable.conversation.sessionId,
    new AbortController().signal,
  );
  expect(loaded.kind).toBe("loaded");
  if (loaded.kind !== "loaded") throw new Error("Expected committed stream");
  const batch = loaded.batches[0]!;
  const { revision, ...request } = batch;
  expect(await reader.append(request, new AbortController().signal)).toMatchObject({
    kind: "committed",
    receipt: { revision },
  });
  expect(await reader.load(request.sessionId, new AbortController().signal)).toEqual(loaded);
});
