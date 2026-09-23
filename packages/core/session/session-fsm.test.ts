import { expect, test } from "bun:test";
import { createSession } from "./session-runtime.ts";
import { testOptions, deferred, until } from "./test-support.ts";
import { decideSession, type SessionState, type SessionEvent } from "./session-fsm.ts";
import { AppendIdSchema, RevisionSchema } from "./persistence.ts";
import { createMemoryPersistence } from "./testing/memory-persistence.ts";

async function initial(): Promise<SessionState> {
  return (await createSession(testOptions())).snapshot;
}
function submission(state: SessionState, id = "append"): SessionEvent {
  return {
    type: "submit",
    submission: {
      id,
      appendId: AppendIdSchema.parse(id),
      input: {
        kind: "event",
        event: { type: "user", text: "Go" },
        systemVersion: state.durable.systemVersion,
      },
    },
  };
}
test("stage separates pending state from durable state and emits only append", async () => {
  const before = await initial();
  const staged = decideSession(before, submission(before));
  expect(staged.state.status).toBe("committing");
  expect(staged.state.durable).toBe(before.durable);
  expect(staged.commands.map((command) => command.type)).toEqual(["append"]);
  if (staged.state.status !== "committing") throw new Error("Expected committing");
  expect(staged.state.pending.next.conversation.turn.status).toBe("preparing_model");
  const stale = decideSession(staged.state, {
    type: "appended",
    appendId: AppendIdSchema.parse("stale"),
    result: { kind: "rejected", message: "no" },
  });
  expect(stale.state).toBe(staged.state);
  const result = decideSession(staged.state, {
    type: "appended",
    appendId: staged.state.pending.request.appendId,
    result: {
      kind: "committed",
      receipt: {
        sessionId: before.durable.conversation.sessionId,
        appendId: staged.state.pending.request.appendId,
        revision: staged.state.pending.next.revision,
      },
    },
  });
  expect(result.state.status).toBe("ready");
  expect(result.commands.map((command) => command.type)).toEqual(["dispatch", "reply", "drain"]);
});
test("rejected writes stop work and settle queued callers", async () => {
  const before = await initial();
  const staged = decideSession(before, submission(before));
  const queued = decideSession(staged.state, submission(before, "queued"));
  const failed = decideSession(queued.state, {
    type: "appended",
    appendId: AppendIdSchema.parse("append"),
    result: { kind: "rejected", message: "offline" },
  });
  expect(failed.state.status).toBe("failed");
  expect(failed.commands.map((command) => command.type)).toEqual(["stop", "reply", "reply"]);
  expect(failed.state.durable).toBe(before.durable);
});
test("uncertain writes load before retrying; repeated uncertainty fails without dispatch", async () => {
  const before = await initial();
  let state = decideSession(before, submission(before)).state;
  const lost: SessionEvent = {
    type: "appended",
    appendId: AppendIdSchema.parse("append"),
    result: { kind: "indeterminate", message: "lost" },
  };
  const loaded = {
    kind: "loaded" as const,
    revision: before.durable.revision,
    batches: [
      {
        sessionId: before.durable.conversation.sessionId,
        expectedRevision: RevisionSchema.parse(0),
        appendId: before.durable.records[0]!.appendId,
        records: before.durable.records.map((record) => JSON.stringify(record)),
        revision: before.durable.revision,
      },
    ],
  };
  const reconcile = decideSession(state, lost);
  expect(reconcile.commands[0]?.type).toBe("load");
  state = reconcile.state;
  state = decideSession(state, {
    type: "loaded",
    appendId: AppendIdSchema.parse("append"),
    result: loaded,
  }).state;
  expect(state.status).toBe("committing");
  state = decideSession(state, lost).state;
  state = decideSession(state, {
    type: "loaded",
    appendId: AppendIdSchema.parse("append"),
    result: loaded,
  }).state;
  expect(state.status).toBe("failed");
});
test("abort queued behind a delayed committed input cannot dispatch early", async () => {
  const port = createMemoryPersistence();
  const release = deferred<void>();
  let writing = false;
  let calls = 0;
  const runtime = await createSession(
    testOptions({
      persistence: {
        ...port,
        async append(request, signal) {
          const result = await port.append(request, signal);
          if (request.expectedRevision === 1) {
            writing = true;
            await release.promise;
          }
          return result;
        },
      },
      complete: () => {
        calls++;
        return { kind: "answer", text: "late" };
      },
    }),
  );
  const input = runtime.input("Go");
  await until(() => writing);
  const abort = runtime.fire({ type: "abort" });
  expect(calls).toBe(0);
  expect(runtime.snapshot.durable.conversation.turn.status).toBe("idle");
  release.resolve();
  await abort;
  expect(await input.settled).toMatchObject({
    kind: "terminal",
    record: { outcome: { kind: "aborted" } },
  });
});
test("close settles callers promptly even when storage acknowledgement is delayed", async () => {
  const port = createMemoryPersistence();
  const release = deferred<void>();
  let writing = false;
  const runtime = await createSession(
    testOptions({
      persistence: {
        ...port,
        async append(request, signal) {
          const result = await port.append(request, signal);
          if (request.expectedRevision === 1) {
            writing = true;
            await release.promise;
          }
          return result;
        },
      },
    }),
  );
  const input = runtime.input("Go");
  await until(() => writing);
  await runtime.close();
  expect((await input.accepted).kind).toBe("closed");
  expect((await input.settled).kind).toBe("closed");
  release.resolve();
  expect(
    (await port.load(runtime.snapshot.durable.conversation.sessionId, new AbortController().signal))
      .kind,
  ).toBe("loaded");
});

test("duplicate matching receipt cannot redispatch commands after commit", async () => {
  const before = await initial();
  const staged = decideSession(before, submission(before));
  if (staged.state.status !== "committing") throw new Error("Expected pending append");
  const event: SessionEvent = {
    type: "appended",
    appendId: staged.state.pending.request.appendId,
    result: {
      kind: "committed",
      receipt: {
        sessionId: before.durable.conversation.sessionId,
        appendId: staged.state.pending.request.appendId,
        revision: staged.state.pending.next.revision,
      },
    },
  };
  const committed = decideSession(staged.state, event);
  const repeated = decideSession(committed.state, event);
  expect(repeated.state).toBe(committed.state);
  expect(repeated.commands).toHaveLength(0);
});

test("invalid internal event drained from a queue fails and settles remaining queued callers", async () => {
  const before = await initial();
  const staged = decideSession(before, submission(before));
  if (staged.state.status !== "committing") throw new Error("Expected pending append");
  const active = staged.state.pending.next;
  if (active.conversation.turn.status !== "preparing_model") throw new Error("Expected preparing");
  const corrupt: SessionEvent = {
    type: "submit",
    submission: {
      id: "bad",
      appendId: AppendIdSchema.parse("bad"),
      input: {
        kind: "event",
        systemVersion: active.systemVersion,
        event: {
          type: "child",
          turnId: active.conversation.turnId,
          event: {
            type: "prepared",
            child: active.conversation.turn.child,
            result: { kind: "succeeded", value: { model: "wrong", messages: [] } },
          },
        },
      },
    },
  };
  const next: SessionEvent = submission(before, "next");
  if (next.type !== "submit") throw new Error("Expected submit");
  const queued = decideSession(
    { status: "ready", durable: active, queue: [corrupt.submission, next.submission] },
    { type: "drain" },
  );
  expect(queued.state.status).toBe("failed");
  expect(queued.state.queue).toHaveLength(0);
  expect(
    queued.commands.filter((command) => command.type === "reply").map((command) => command.id),
  ).toEqual(["bad", "next"]);
});
