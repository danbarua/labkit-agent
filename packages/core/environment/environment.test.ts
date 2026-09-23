import { expect, test } from "bun:test";

import { deferred } from "../agent/test-support.ts";
import type { EnvEvent } from "../session/events.ts";
import { createSession } from "../session/session-runtime.ts";
import { createMemoryPersistence } from "../session/testing/memory-persistence.ts";
import { startEnvironment, type EnvironmentUpdate } from "./environment.ts";

test("event loop receives abort during an unsettled completion and renders correlated outcomes", async () => {
  const started = deferred<void>();
  const pending = deferred<unknown>();
  const updates: EnvironmentUpdate[] = [];
  async function* events(): AsyncGenerator<EnvEvent> {
    yield { type: "system", inputs: ["instruction"] };
    yield { type: "user", text: "go" };
    await started.promise;
    yield { type: "abort" };
    yield { type: "close" };
  }
  await startEnvironment(
    {
      persistence: createMemoryPersistence(),
      configuration: { agent: "a", agents: new Map([["a", { model: "m" }]]), steps: 2 },
      bindings: {
        complete: () => {
          started.resolve();
          return pending.promise;
        },
      },
    },
    {
      events: events(),
      render: (update) => {
        updates.push(update);
      },
    },
  );
  expect(
    updates.some(
      (update) =>
        update.kind === "settled" &&
        update.outcome.kind === "terminal" &&
        update.outcome.record.outcome.kind === "aborted",
    ),
  ).toBe(true);
  expect(
    updates.some(
      (update) => update.kind === "receipt" && update.receipt.kind === "close_acknowledged",
    ),
  ).toBe(true);
  expect(updates.some((update) => update.kind === "snapshot")).toBe(true);
});
test("one public boundary validates events, publishes branches, and rejects child forgery", async () => {
  const session = await createSession({
    persistence: createMemoryPersistence(),
    configuration: { agent: "a", agents: new Map([["a", { model: "m" }]]), steps: 1 },
    bindings: { complete: () => ({ kind: "answer", text: "ok" }) },
  });
  expect(() => session.dispatch({ type: "child", event: {} })).toThrow();
  expect((await session.fire({ type: "policy", patch: { steps: 2 } })).kind).toBe("accepted");
  const branch = session.dispatch({ type: "compact", context: [] });
  expect((await branch.accepted).kind).toBe("accepted");
  const result = await branch.settled;
  expect(result.kind).toBe("branch");
  if (result.kind === "branch") {
    expect(result.session.snapshot.durable.conversation.origin.kind).toBe("compaction");
    await result.session.close();
  }
  await session.close();
});
