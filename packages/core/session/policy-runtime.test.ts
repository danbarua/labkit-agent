import { expect, test } from "bun:test";

import { z } from "zod";

import { builtinResolvers } from "../policy/policy.ts";
import { journalJSONL } from "./session-log.ts";
import {
  createSession,
  defineTool,
  restoreSession,
  type BoundSessionOptions,
} from "./session-runtime.ts";
import { deferred, testOptions, until } from "./test-support.ts";

export function boundOptions(): BoundSessionOptions {
  const legacy = testOptions();
  return {
    persistence: legacy.persistence,
    configuration: { agent: legacy.agent, agents: legacy.agents, steps: legacy.steps },
    bindings: {
      tools: legacy.tools,
      id: legacy.id,
      complete: (request, signal) =>
        legacy.complete!({ ...request, baseUrl: legacy.baseUrl, apiKey: legacy.apiKey, signal }),
    },
  };
}
test("v2 policy changes allowance and tools only after idle commit, restores and forks", async () => {
  const options = boundOptions();
  const requests: any[] = [];
  const session = await createSession({
    ...options,
    bindings: {
      ...options.bindings,
      complete: (request) => {
        requests.push(request);
        return { kind: "answer", text: "ok" };
      },
    },
  });
  expect(session.snapshot.durable.records[0]?.version).toBe(2);
  const before = session.snapshot;
  expect((await session.updatePolicy({ steps: 1, tools: { a: [] } })).kind).toBe("accepted");
  const turn = session.input("Go");
  expect((await turn.settled).kind).toBe("terminal");
  expect(requests[0].tools).toEqual([]);
  expect(Number(session.snapshot.durable.policy?.version)).toBe(1);
  expect(Number(before.durable.policy?.version)).toBe(0);
  const restored = await restoreSession(options, session.snapshot.durable.conversation.sessionId);
  expect(restored.snapshot.durable).toEqual(session.snapshot.durable);
  const child = await session.compact([]);
  expect(child.snapshot.durable.policy).toEqual(session.snapshot.durable.policy);
  expect((await session.updatePolicy({ tools: { a: ["undeclared"] } })).kind).toBe("failed");
});
test("v1 upgrades append-only through explicit policy boundary", async () => {
  const options = testOptions();
  const session = await createSession(options);
  await session.input("legacy").settled;
  const bytes = journalJSONL(session.snapshot.durable);
  await session.updatePolicy({ steps: 2 });
  expect(journalJSONL(session.snapshot.durable).startsWith(bytes)).toBe(true);
  expect(session.snapshot.durable.records.slice(-2).map((record) => record.body.kind)).toEqual([
    "upgrade",
    "policy",
  ]);
  await session.input("new").settled;
  expect(
    (await restoreSession(options, session.snapshot.durable.conversation.sessionId)).snapshot
      .durable,
  ).toEqual(session.snapshot.durable);
});
test("queue-user persists admission and settles each input with its own turn", async () => {
  const options = boundOptions();
  const first = deferred<unknown>();
  let calls = 0;
  const session = await createSession({
    ...options,
    configuration: {
      ...options.configuration,
      policy: { admission: "queue-user", bargeIn: false },
    },
    bindings: {
      ...options.bindings,
      complete: () => (++calls === 1 ? first.promise : { kind: "answer", text: "second" }),
    },
  });
  const a = session.input("first");
  await until(() => calls === 1);
  const b = session.input("second");
  expect((await b.accepted).kind).toBe("accepted");
  expect(session.snapshot.durable.pendingInputs).toHaveLength(1);
  expect((await session.updatePolicy({ steps: 7 })).kind).toBe("busy");
  first.resolve({ kind: "answer", text: "first" });
  const one = await a.settled;
  const two = await b.settled;
  expect(one.kind === "terminal" && one.turnId).not.toBe(two.kind === "terminal" && two.turnId);
  expect(
    session.snapshot.durable.conversation.log.map((record) => record.messages[0]?.text),
  ).toEqual(["first", "second"]);
  expect(session.snapshot.durable.pendingInputs).toHaveLength(0);
});
test("recovery cancels durably queued inputs without starting them", async () => {
  const options = boundOptions();
  const first = deferred<unknown>();
  let calls = 0;
  const session = await createSession({
    ...options,
    configuration: {
      ...options.configuration,
      policy: { admission: "queue-user", bargeIn: false },
    },
    bindings: {
      ...options.bindings,
      complete: () => {
        calls++;
        return first.promise;
      },
    },
  });
  session.input("first");
  await until(() => calls === 1);
  const queued = session.input("second");
  await queued.accepted;
  await session.close();
  const restored = await restoreSession(options, session.snapshot.durable.conversation.sessionId);
  expect(restored.snapshot.durable.records.at(-1)?.body.kind).toBe("input_cancelled");
  expect(restored.snapshot.durable.pendingInputs).toHaveLength(0);
  expect(calls).toBe(1);
  expect((await queued.settled).kind).toBe("closed");
});
test("abort-tools-on-user settles the interrupted turn before starting its successor", async () => {
  const options = boundOptions();
  const slow = deferred<string>();
  let started = false;
  let calls = 0;
  const session = await createSession({
    ...options,
    configuration: { ...options.configuration, policy: { admission: "abort-tools-on-user" } },
    bindings: {
      ...options.bindings,
      tools: new Map([
        [
          "echo",
          defineTool({
            input: z.object({ text: z.string() }),
            run: () => {
              started = true;
              return slow.promise;
            },
          }),
        ],
      ]),
      complete: () =>
        ++calls === 1
          ? {
              kind: "tools",
              text: "work",
              calls: [{ id: "x", name: "echo", args: { text: "slow" } }],
            }
          : { kind: "answer", text: "new" },
    },
  });
  const first = session.input("first");
  await until(() => started);
  const second = session.input("second");
  await second.accepted;
  expect(await first.settled).toMatchObject({ record: { outcome: { kind: "aborted" } } });
  expect(await second.settled).toMatchObject({ record: { outcome: { kind: "completed" } } });
  slow.resolve("late");
});
test("tool failure continuation preserves raw evidence and deterministic correlated error", async () => {
  const options = boundOptions();
  let calls = 0;
  const session = await createSession({
    ...options,
    configuration: {
      ...options.configuration,
      policy: { toolFailure: "return-error-and-continue" },
    },
    bindings: {
      ...options.bindings,
      tools: new Map([
        [
          "echo",
          defineTool({
            input: z.object({ text: z.string() }),
            run: ({ text }) => {
              if (text === "bad") throw new Error("broken");
              return text;
            },
          }),
        ],
      ]),
      complete: () =>
        ++calls === 1
          ? {
              kind: "tools",
              text: "work",
              calls: [
                { id: "a", name: "echo", args: { text: "bad" } },
                { id: "b", name: "echo", args: { text: "ok" } },
              ],
            }
          : { kind: "answer", text: "done" },
    },
  });
  expect(await session.input("Go").settled).toMatchObject({
    record: { outcome: { kind: "completed" } },
  });
  expect(
    session.snapshot.durable.records.some(
      (record) => record.body.kind === "tool" && record.body.result.kind === "failed",
    ),
  ).toBe(true);
  expect(
    session.snapshot.durable.conversation.log[0]?.messages
      .filter((message) => message.role === "tool")
      .map((message) => message.text),
  ).toEqual(['{"error":"broken"}', "ok"]);
  expect(
    (await restoreSession(options, session.snapshot.durable.conversation.sessionId)).snapshot
      .durable,
  ).toEqual(session.snapshot.durable);
});
test("named pure projection is required at restore and observer errors cannot fail a session", async () => {
  const options = boundOptions();
  const seen: string[] = [];
  const policies = {
    projections: new Map([
      ...builtinResolvers.projections,
      ["custom@1", () => [{ role: "user" as const, content: "custom" }]],
    ]),
    handoffs: builtinResolvers.handoffs,
  };
  const configured = {
    ...options,
    configuration: { ...options.configuration, policy: { project: "custom@1" } },
    bindings: {
      ...options.bindings,
      policies,
      observe: (snapshot: any) => {
        seen.push(snapshot.status);
        throw new Error("observer only");
      },
    },
  };
  const session = await createSession(configured);
  await session.input("Go").settled;
  expect(seen).toContain("committing");
  await expect(
    restoreSession(options, session.snapshot.durable.conversation.sessionId),
  ).rejects.toThrow("resolver");
  expect(
    (await restoreSession(configured, session.snapshot.durable.conversation.sessionId)).snapshot
      .durable,
  ).toEqual(session.snapshot.durable);
});

test("rejected and uncertain policy appends preserve commit gating", async () => {
  const options = boundOptions();
  const base = options.persistence;
  const release = deferred<void>();
  let writing = false;
  const session = await createSession({
    ...options,
    persistence: {
      ...base,
      async append(request, signal) {
        const result = await base.append(request, signal);
        if (request.records.some((record) => JSON.parse(record).body.kind === "policy")) {
          writing = true;
          await release.promise;
          return { kind: "indeterminate", message: "lost" };
        }
        return result;
      },
    },
  });
  const before = session.snapshot.durable;
  const update = session.updatePolicy({ steps: 0 });
  await until(() => writing);
  const turn = session.input("Go");
  expect(session.snapshot.durable).toBe(before);
  release.resolve();
  expect((await update).kind).toBe("accepted");
  expect(await turn.settled).toMatchObject({ record: { outcome: { kind: "exhausted" } } });
  expect(
    session.snapshot.durable.records.filter((record) => record.body.kind === "policy"),
  ).toHaveLength(1);
  const rejectedOptions = boundOptions();
  const rejected = await createSession({
    ...rejectedOptions,
    persistence: {
      ...rejectedOptions.persistence,
      append: (request, signal) =>
        request.records.some((record) => JSON.parse(record).body.kind === "policy")
          ? Promise.resolve({ kind: "rejected", message: "offline" })
          : rejectedOptions.persistence.append(request, signal),
    },
  });
  expect((await rejected.updatePolicy({ steps: 0 })).kind).toBe("failed");
  expect(Number(rejected.snapshot.durable.policy?.steps)).toBe(4);
});

test("context-only omits logged history but retains context and current input", async () => {
  const options = boundOptions();
  const requests: any[] = [];
  const session = await createSession({
    ...options,
    bindings: {
      ...options.bindings,
      complete: (request) => {
        requests.push(request);
        return { kind: "answer", text: "ok" };
      },
    },
  });
  await session.input("old history").settled;
  await session.updatePolicy({ project: "context-only@1" });
  await session.input("current").settled;
  expect(requests[1].messages.map((message: any) => message.content)).toEqual([
    "Agent A",
    "current",
  ]);
  const child = await session.compact([{ role: "user", text: "replacement" }]);
  await child.input("new current").settled;
  expect(requests[2].messages.map((message: any) => message.content)).toEqual([
    "Agent A",
    "replacement",
    "new current",
  ]);
});

test("bound callbacks cannot be replaced by mutating the caller's bindings", async () => {
  const options = boundOptions();
  const mutable = { ...options.bindings };
  const session = await createSession({ ...options, bindings: mutable });
  mutable.complete = () => {
    throw new Error("replacement must not run");
  };
  expect(await session.input("Go").settled).toMatchObject({
    record: { outcome: { kind: "completed" } },
  });
});

test("observer reentrancy enters the mailbox and sees frozen snapshots", async () => {
  const options = boundOptions();
  let session: Awaited<ReturnType<typeof createSession>> | undefined;
  let changed = false;
  const seen: number[] = [];
  const configured = {
    ...options,
    bindings: {
      ...options.bindings,
      observe(snapshot: any) {
        expect(Object.isFrozen(snapshot)).toBe(true);
        seen.push(snapshot.durable.revision);
        if (
          session &&
          !changed &&
          snapshot.durable.conversation.log.length === 1 &&
          snapshot.status === "ready"
        ) {
          changed = true;
          void session.updateSystem(["from observer"]);
        }
      },
    },
  };
  session = await createSession(configured);
  await session.input("Go").settled;
  await until(() => session!.snapshot.durable.systemInputs.length === 1);
  expect(seen).toEqual([...seen].sort((a, b) => a - b));
});

test("policy changes during a staged active turn are busy before its receipt arrives", async () => {
  const options = boundOptions();
  const release = deferred<void>();
  let writing = false;
  const session = await createSession({
    ...options,
    persistence: {
      ...options.persistence,
      async append(request, signal) {
        const result = await options.persistence.append(request, signal);
        if (request.records.some((record) => JSON.parse(record).body.event?.type === "user")) {
          writing = true;
          await release.promise;
        }
        return result;
      },
    },
  });
  const turn = session.input("Go");
  await until(() => writing);
  expect((await session.updatePolicy({ steps: 0 })).kind).toBe("busy");
  release.resolve();
  await turn.settled;
});

test("restore binds historical resolvers without requiring unrelated creation defaults", async () => {
  const options = boundOptions();
  const policies = {
    handoffs: builtinResolvers.handoffs,
    projections: new Map([["only@1", () => [{ role: "user" as const, content: "fixed" }]]]),
  };
  const session = await createSession({
    ...options,
    configuration: { ...options.configuration, policy: { project: "only@1" } },
    bindings: { ...options.bindings, policies },
  });
  await session.input("Go").settled;
  const restored = await restoreSession(
    { ...options, bindings: { ...options.bindings, policies } },
    session.snapshot.durable.conversation.sessionId,
  );
  expect(restored.snapshot.durable).toEqual(session.snapshot.durable);
});

class NonJsonToolOutput {
  value = "not a plain object";
}
for (const [name, value] of [
  ["undefined", undefined],
  ["Date", new Date(0)],
  ["class instance", new NonJsonToolOutput()],
] as const) {
  test(`non-JSON ${name} tool output is a correlated failure and honors continuation`, async () => {
    const options = boundOptions();
    let completions = 0;
    const session = await createSession({
      ...options,
      configuration: { ...options.configuration, policy: { id: "tolerant@1" } },
      bindings: {
        ...options.bindings,
        tools: new Map([
          ["echo", defineTool({ input: z.object({ text: z.string() }), run: () => value })],
        ]),
        complete: () =>
          ++completions === 1
            ? {
                kind: "tools",
                text: "run",
                calls: [{ id: "call", name: "echo", args: { text: "go" } }],
              }
            : { kind: "answer", text: "continued" },
      },
    });
    expect(await session.input("go").settled).toMatchObject({
      record: { outcome: { kind: "completed" } },
    });
    const tool = session.snapshot.durable.records.find(
      (record) => record.body.kind === "tool",
    )?.body;
    expect(tool).toMatchObject({ kind: "tool", callId: "call", result: { kind: "failed" } });
    if (tool?.kind !== "tool" || tool.result.kind !== "failed")
      throw new Error("Expected tool failure");
    expect(tool.result.error.message).toContain("Tool output must be a JSON value");
    expect(
      session.snapshot.durable.conversation.log[0]!.messages.find(
        (message) => message.role === "tool",
      )?.text,
    ).toContain("Tool output must be a JSON value");
    await session.close();
  });
}

test("malformed projected arguments fail preparation without inventing tool results", async () => {
  const options = boundOptions();
  let completions = 0;
  const policies = {
    ...builtinResolvers,
    projections: new Map([
      ...builtinResolvers.projections,
      [
        "malformed@1",
        () => [
          {
            role: "assistant" as const,
            content: "bad",
            tool_calls: [
              {
                id: "bad-call",
                type: "function" as const,
                function: { name: "echo", arguments: "{" },
              },
            ],
          },
          { role: "tool" as const, content: "result", tool_call_id: "bad-call" },
        ],
      ],
    ]),
  };
  const session = await createSession({
    ...options,
    configuration: {
      ...options.configuration,
      policy: { id: "tolerant@1", project: "malformed@1" },
    },
    bindings: {
      ...options.bindings,
      policies,
      complete: () => {
        completions++;
        return { kind: "answer", text: "unexpected" };
      },
    },
  });
  expect(await session.input("go").settled).toMatchObject({
    record: {
      outcome: {
        kind: "failed",
        error: { message: "Invalid JSON arguments for projected tool call bad-call" },
      },
    },
  });
  expect(completions).toBe(0);
  expect(session.snapshot.durable.records.some((record) => record.body.kind === "tool")).toBe(
    false,
  );
  await session.close();
});

test("malformed provider arguments fail completion even under tool-error continuation", async () => {
  let tools = 0;
  const options = testOptions({
    complete: undefined,
    fetch: (async (_url: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        choices: [
          {
            message: {
              content: "bad",
              tool_calls: [
                { id: "bad", type: "function", function: { name: "echo", arguments: "{" } },
              ],
            },
          },
        ],
      })) as typeof fetch,
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
  });
  const session = await createSession(options);
  await session.updatePolicy({ id: "tolerant@1" });
  expect(await session.input("go").settled).toMatchObject({
    record: { outcome: { kind: "failed" } },
  });
  expect(tools).toBe(0);
  expect(session.snapshot.durable.records.some((record) => record.body.kind === "tool")).toBe(
    false,
  );
  await session.close();
});
