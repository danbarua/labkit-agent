import { expect, spyOn, test } from "@logtape/testing-bun/autoload";
import { z } from "zod";

import * as sessionLog from "./session-log.ts";
import { journalJSONL } from "./session-log.ts";
import { createSession, defineTool, restoreSession } from "./session-runtime.ts";
import {
  deferred,
  lostAcknowledgement,
  scriptedCompletion,
  testOptions,
  until,
} from "./test-support.ts";
import { createMemoryBacking, createMemoryPersistence } from "./testing/memory-persistence.ts";

test("answers, immutable snapshots, system updates and idle restoration without effects", async () => {
  const requests: unknown[] = [];
  const options = testOptions({
    complete: scriptedCompletion(
      [
        { kind: "answer", text: "One" },
        { kind: "answer", text: "Two" },
      ],
      requests,
    ),
  });
  const session = await createSession(options);
  const before = session.snapshot;
  expect((await session.input("Hi").settled).kind).toBe("terminal");
  expect((await session.updateSystem(["Be brief"])).kind).toBe("accepted");
  await session.input("Again").settled;
  const restored = await restoreSession(
    {
      ...options,
      bindings: {
        ...options.bindings,
        complete: () => {
          throw new Error("Unexpected completion");
        },
      },
    },
    session.snapshot.durable.conversation.sessionId,
  );
  expect(restored.snapshot.durable).toEqual(session.snapshot.durable);
  expect(before.durable.conversation.log).toHaveLength(0);
  expect(JSON.stringify(requests)).toContain("Be brief");
  expect(journalJSONL(restored.snapshot.durable)).not.toContain("SECRET_SENTINEL");
  expect(journalJSONL(restored.snapshot.durable)).not.toContain("baseUrl");
});

test("tool loop journals each result before batch settlement and completion", async () => {
  const session = await createSession(
    testOptions({
      complete: scriptedCompletion([
        {
          kind: "tools",
          text: "Calling",
          calls: [{ id: "c1", name: "echo", args: { text: "result" } }],
        },
        { kind: "answer", text: "Done" },
      ]),
    }),
  );
  const result = await session.input("Tool please").settled;
  expect(result.kind === "terminal" && result.record.outcome.kind).toBe("completed");
  const bodies = session.snapshot.durable.records.map((record) => record.body);
  expect(bodies.filter((body) => body.kind === "tool")).toHaveLength(1);
  expect(
    session.snapshot.durable.conversation.log[0]!.messages.map((message) => message.role),
  ).toEqual(["user", "assistant", "tool", "assistant"]);
});

test("handoff, exhausted turns and completion failure", async () => {
  const session = await createSession(
    testOptions({ steps: 1, complete: () => ({ kind: "handoff", agent: "b", text: "Delegate" }) }),
  );
  const result = await session.input("Go").settled;
  expect(result.kind === "terminal" && result.record).toMatchObject({
    agent: "b",
    outcome: { kind: "exhausted" },
  });
  const failed = await createSession(
    testOptions({
      complete: () => {
        throw new Error("offline");
      },
    }),
  );
  expect(await failed.input("Go").settled).toMatchObject({
    kind: "terminal",
    record: { outcome: { kind: "failed", error: { message: "offline" } } },
  });
});

test("barge-in cancels the old completion, correlates waiters and ignores late outcomes", async () => {
  const pending = deferred<unknown>();
  let calls = 0;
  const session = await createSession(
    testOptions({
      complete: () => (++calls === 1 ? pending.promise : { kind: "answer", text: "new" }),
    }),
  );
  const first = session.input("first");
  await until(() => calls === 1);
  const second = session.input("second");
  const result = await second.settled;
  expect(await first.settled).toEqual(result);
  pending.resolve({ kind: "answer", text: "late" });
  await Promise.resolve();
  expect(
    session.snapshot.durable.conversation.log[0]!.messages.map((message) => message.text),
  ).toEqual(["first", "second", "new"]);
});

test("active forks capture the exact boundary before queued next input; branches are independent", async () => {
  const pending = deferred<unknown>();
  let calls = 0;
  const options = testOptions({
    complete: () => (++calls === 1 ? pending.promise : { kind: "answer", text: "next" }),
  });
  const session = await createSession(options);
  const first = session.input("first");
  await until(() => calls === 1);
  const branch = session.fork();
  expect((await session.updateSystem(["busy"])).kind).toBe("busy");
  pending.resolve({ kind: "answer", text: "first answer" });
  await first.settled;
  const next = session.input("next");
  const child = await branch;
  expect(child.snapshot.durable.conversation.log).toHaveLength(1);
  await next.settled;
  await child.updateSystem(["child"]);
  expect(session.snapshot.durable.systemInputs).toEqual([]);
  const ancestor = journalJSONL(session.snapshot.durable);
  const compacted = await child.compact([{ role: "user", text: "summary" }]);
  expect(compacted.snapshot.durable.conversation).toMatchObject({
    sequence: 1,
    log: [],
    context: [{ role: "user", text: "summary" }],
  });
  const reset = await compacted.compact([]);
  expect([...reset.snapshot.durable.conversation.context]).toEqual([]);
  expect(journalJSONL(session.snapshot.durable)).toBe(ancestor);
  expect(() => child.compact([{ role: "tool", callId: "orphan", text: "x" }])).toThrow();
});

test("partial tool cancellation persists results and ignores late effects", async () => {
  const slow = deferred<string>();
  let started = 0;
  const options = testOptions({
    tools: new Map([
      [
        "echo",
        defineTool({
          input: z.object({ text: z.string() }),
          run: ({ text }) => {
            started++;
            return text === "slow" ? slow.promise : text;
          },
        }),
      ],
    ]),
    complete: () => ({
      kind: "tools",
      text: "work",
      calls: [
        { id: "fast", name: "echo", args: { text: "fast" } },
        { id: "slow", name: "echo", args: { text: "slow" } },
      ],
    }),
  });
  const session = await createSession(options);
  const turn = session.input("Go");
  await until(() => started === 2 && session.snapshot.durable.partial.length === 1);
  await session.fire({ type: "abort" });
  expect(await turn.settled).toMatchObject({ record: { outcome: { kind: "aborted" } } });
  const snapshot = session.snapshot.durable;
  expect(
    snapshot.conversation.log[0]!.messages.filter((m) => m.role === "tool").map((m) => m.text),
  ).toEqual(["fast"]);
  slow.resolve("late");
  await Promise.resolve();
  expect(session.snapshot.durable).toEqual(snapshot);
});

test("rejected input append starts no external work; lost receipt dispatches exactly once", async () => {
  const base = createMemoryPersistence();
  let calls = 0;
  const rejected = await createSession(
    testOptions({
      complete: () => {
        calls++;
        return { kind: "answer", text: "x" };
      },
      persistence: {
        lifetime: base.lifetime,
        putBlob: base.putBlob.bind(base),
        getBlob: base.getBlob.bind(base),
        load: base.load,
        append: (request, signal) =>
          request.expectedRevision > 0
            ? Promise.resolve({ kind: "rejected", message: "offline" })
            : base.append(request, signal),
      },
    }),
  );
  expect((await rejected.input("Go").accepted).kind).toBe("failed");
  expect(calls).toBe(0);
  const session = await createSession(
    testOptions({
      persistence: lostAcknowledgement(createMemoryPersistence(), (records) =>
        records.some((record) => record.includes('"type":"user"')),
      ),
      complete: () => {
        calls++;
        return { kind: "answer", text: "x" };
      },
    }),
  );
  await session.input("Go").settled;
  expect(calls).toBe(1);
  expect(
    session.snapshot.durable.records.filter(
      (record) => record.body.kind === "event" && record.body.event.type === "user",
    ),
  ).toHaveLength(1);
});

test("fresh adapter restores interrupted partial tools, records one recovery, never replays", async () => {
  const backing = createMemoryBacking();
  const slow = deferred<string>();
  const options = testOptions({
    persistence: createMemoryPersistence(backing),
    tools: new Map([
      [
        "echo",
        defineTool({
          input: z.object({ text: z.string() }),
          run: ({ text }) => (text === "slow" ? slow.promise : text),
        }),
      ],
    ]),
    complete: () => ({
      kind: "tools",
      text: "work",
      calls: [
        { id: "fast", name: "echo", args: { text: "fast" } },
        { id: "slow", name: "echo", args: { text: "slow" } },
      ],
    }),
  });
  const session = await createSession(options);
  session.input("Go");
  await until(() => session.snapshot.durable.partial.length === 1);
  const sessionId = session.snapshot.durable.conversation.sessionId;
  await session.close();
  const restoreOptions = {
    ...options,
    persistence: lostAcknowledgement(createMemoryPersistence(backing), (records) =>
      records.some((record) => record.includes('"kind":"recovery"')),
    ),
    complete: () => {
      throw new Error("MUST NOT RUN");
    },
  };
  const restored = await restoreSession(restoreOptions, sessionId);
  expect(restored.snapshot.durable.conversation.log[0]!).toMatchObject({
    outcome: { kind: "failed" },
  });
  expect(
    restored.snapshot.durable.conversation.log[0]!.messages.filter((m) => m.role === "tool"),
  ).toHaveLength(1);
  expect(
    restored.snapshot.durable.records.filter((record) => record.body.kind === "recovery"),
  ).toHaveLength(1);
  expect((await restoreSession(restoreOptions, sessionId)).snapshot.durable).toEqual(
    restored.snapshot.durable,
  );
});

test("abort overtaking a tool outcome does not accept a result into a settled batch", async () => {
  const port = createMemoryPersistence();
  const releaseAbort = deferred<void>();
  const tool = deferred<string>();
  let started = false;
  let abortWriting = false;
  const session = await createSession(
    testOptions({
      persistence: {
        ...port,
        async append(request, signal) {
          const result = await port.append(request, signal);
          if (request.records.some((record) => JSON.parse(record).body.event?.type === "abort")) {
            abortWriting = true;
            await releaseAbort.promise;
          }
          return result;
        },
      },
      tools: new Map([
        [
          "echo",
          defineTool({
            input: z.object({ text: z.string() }),
            run: () => {
              started = true;
              return tool.promise;
            },
          }),
        ],
      ]),
      complete: () => ({
        kind: "tools",
        text: "work",
        calls: [{ id: "c", name: "echo", args: { text: "x" } }],
      }),
    }),
  );
  const turn = session.input("Go");
  await until(() => started);
  const abort = session.fire({ type: "abort" });
  await until(() => abortWriting);
  tool.resolve("too late");
  await until(() => session.snapshot.queue.some((submission) => submission.input.kind === "tool"));
  releaseAbort.resolve();
  await abort;
  expect(await turn.settled).toMatchObject({ record: { outcome: { kind: "aborted" } } });
  expect(
    session.snapshot.durable.conversation.log[0]!.messages.filter(
      (message) => message.role === "tool",
    ),
  ).toHaveLength(0);
  expect(session.snapshot.status).toBe("ready");
});

test("captured registries survive caller mutation; incompatible restored configuration rejects", async () => {
  const options = testOptions();
  const session = await createSession(options);
  (options.configuration.agents as Map<string, unknown>).clear();
  (options.bindings.tools as Map<string, unknown>).clear();
  expect(await session.input("Go").settled).toMatchObject({
    record: { outcome: { kind: "completed" } },
  });
  const incompatible = testOptions({
    persistence: options.persistence,
    agents: new Map([["a", { model: "changed", tools: [] }]]),
  });
  await expect(
    restoreSession(incompatible, session.snapshot.durable.conversation.sessionId),
  ).rejects.toThrow("configuration");
});

test("closing a parent settles a fork whose child initialization receipt is delayed", async () => {
  const port = createMemoryPersistence();
  const release = deferred<void>();
  let initializing = false;
  let root = "";
  const session = await createSession(
    testOptions({
      persistence: {
        ...port,
        async append(request, signal) {
          const result = await port.append(request, signal);
          if (root && request.sessionId !== root) {
            initializing = true;
            await release.promise;
          }
          return result;
        },
      },
    }),
  );
  root = session.snapshot.durable.conversation.sessionId;
  const rejected = session.fork().then(
    () => "published",
    (error) => String(error),
  );
  await until(() => initializing);
  await session.close();
  expect(await rejected).toContain("closed");
  release.resolve();
});

for (const boundary of ["input", "prompt", "tool-intent"] as const) {
  test(`recovery after ${boundary} commit but before acknowledgement dispatches no dependent work`, async () => {
    const backing = createMemoryBacking();
    const port = createMemoryPersistence(backing);
    const release = deferred<void>();
    let interrupted = false;
    let completions = 0;
    let tools = 0;
    const options = testOptions({
      persistence: {
        ...port,
        async append(request, signal) {
          const result = await port.append(request, signal);
          const matched = request.records.some((serialized) => {
            const body = JSON.parse(serialized).body;
            return boundary === "input"
              ? body.event?.type === "user"
              : boundary === "prompt"
                ? body.event?.event?.type === "prepared"
                : body.event?.event?.type === "model_settled";
          });
          if (matched) {
            interrupted = true;
            await release.promise;
            return { kind: "indeterminate", message: "Lost receipt" };
          }
          return result;
        },
      },
      tools: new Map([
        [
          "echo",
          defineTool({
            input: z.object({ text: z.string() }),
            run: () => {
              tools++;
              return "unexpected";
            },
          }),
        ],
      ]),
      complete: () => {
        completions++;
        return {
          kind: "tools",
          text: "work",
          calls: [{ id: "c", name: "echo", args: { text: "x" } }],
        };
      },
    });
    const session = await createSession(options);
    const turn = session.input("Go");
    await until(() => interrupted);
    await session.close();
    const restored = await restoreSession(
      {
        ...options,
        persistence: createMemoryPersistence(backing),
        bindings: {
          ...options.bindings,
          complete: () => {
            throw new Error("No replay");
          },
        },
      },
      session.snapshot.durable.conversation.sessionId,
    );
    expect(restored.snapshot.durable.conversation.log[0]!.outcome.kind).toBe("failed");
    expect(restored.snapshot.durable.conversation.log[0]!.messages[0]?.text).toBe("Go");
    expect(completions).toBe(boundary === "tool-intent" ? 1 : 0);
    expect(tools).toBe(0);
    expect((await turn.settled).kind).toBe("closed");
    release.resolve();
  });
}

test("idle system changes and queued user inputs capture the committed system version", async () => {
  const port = createMemoryPersistence();
  const release = deferred<void>();
  let updating = false;
  const requests: any[] = [];
  const session = await createSession(
    testOptions({
      persistence: {
        ...port,
        async append(request, signal) {
          const result = await port.append(request, signal);
          if (request.records.some((record) => JSON.parse(record).body.kind === "system")) {
            updating = true;
            await release.promise;
          }
          return result;
        },
      },
      complete: scriptedCompletion([{ kind: "answer", text: "done" }], requests),
    }),
  );
  const update = session.updateSystem(["queued instruction"]);
  await until(() => updating);
  const turn = session.input("Go");
  release.resolve();
  await update;
  expect(await turn.settled).toMatchObject({ record: { outcome: { kind: "completed" } } });
  expect(requests[0].messages[1]).toEqual({ role: "system", content: "queued instruction" });
});

test("fork after partial-tool abort preserves source evidence and valid child prompts", async () => {
  const slow = deferred<string>();
  const requests: any[] = [];
  const session = await createSession(
    testOptions({
      tools: new Map([
        [
          "echo",
          defineTool({
            input: z.object({ text: z.string() }),
            run: ({ text }) => (text === "slow" ? slow.promise : text),
          }),
        ],
      ]),
      complete: scriptedCompletion(
        [
          {
            kind: "tools",
            text: "work",
            calls: [
              { id: "fast", name: "echo", args: { text: "fast" } },
              { id: "slow", name: "echo", args: { text: "slow" } },
            ],
          },
          { kind: "answer", text: "child answer" },
        ],
        requests,
      ),
    }),
  );
  const turn = session.input("Go");
  await until(() => session.snapshot.durable.partial.length === 1);
  const branch = session.fork();
  await session.fire({ type: "abort" });
  await turn.settled;
  const child = await branch;
  const ancestor = journalJSONL(session.snapshot.durable);
  await child.input("Continue").settled;
  const callMessage = requests[1].messages.find((message: any) => message.tool_calls);
  expect(callMessage.tool_calls.map((call: any) => call.id)).toEqual(["fast"]);
  expect(journalJSONL(session.snapshot.durable)).toBe(ancestor);
  slow.resolve("late");
});

test("synchronous fork publication failure rejects its caller without poisoning later forks", async () => {
  const session = await createSession(testOptions());
  const seed = spyOn(sessionLog, "toSeed").mockImplementationOnce(() => {
    throw new Error("Seed construction failed");
  });
  try {
    await expect(session.fork()).rejects.toThrow("Seed construction failed");
    expect(session.snapshot.status).toBe("ready");
  } finally {
    seed.mockRestore();
  }
  const child = await session.fork();
  expect(child.snapshot.durable.conversation.origin.kind).toBe("fork");
  await child.close();
  await session.close();
});
