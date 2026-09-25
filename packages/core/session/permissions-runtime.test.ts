import { expect, test } from "@logtape/testing-bun/autoload";
import { z } from "zod";

import { createAgentRuntime } from "../agent/agent-runtime.ts";
import type { HostToolNotification } from "../host/host.ts";
import type { PermissionPort, PermissionRequest } from "../host/ports.ts";
import { builtinResolvers } from "../policy/policy.ts";
import { openaiChat } from "../providers/index.ts";
import { journalJSONL, replay } from "./session-log.ts";
import {
  createSession,
  defineTool,
  restoreSession,
  type SessionOptions,
} from "./session-runtime.ts";
import { deferred, deterministicIds, lostAcknowledgement, until } from "./test-support.ts";
import { createMemoryBacking, createMemoryPersistence } from "./testing/memory-persistence.ts";
import { JournalRecordSchema } from "./types.ts";

const allow = { outcome: { outcome: "selected", optionId: "allow-once" } };

const reject = { outcome: { outcome: "selected", optionId: "reject-once" } };

const calls = {
  kind: "tools",
  text: "Read",
  calls: [
    { id: "one", name: "echo", args: { path: "/tmp/one" } },
    { id: "two", name: "echo", args: { path: "/tmp/two" } },
  ],
};

function setup(permission: PermissionPort = () => allow) {
  const backing = createMemoryBacking();
  const updates: HostToolNotification[] = [];
  const requests: PermissionRequest[] = [];
  const ran: string[] = [];
  let parses = 0;
  let completions = 0;
  const options: SessionOptions = {
    persistence: createMemoryPersistence(backing),
    configuration: {
      agent: "a",
      agents: new Map([["a", { model: "m", tools: ["echo"] }]]),
      steps: 4,
      policy: { permissions: "ask" },
    },
    bindings: {
      id: deterministicIds(),
      complete: () => (++completions % 2 ? calls : { kind: "answer", text: "Done" }),
      requestPermission: (request, signal) => {
        requests.push(request);
        return permission(request, signal);
      },
      toolUpdate: (event) => {
        updates.push(event);
      },
      tools: new Map([
        [
          "echo",
          defineTool({
            input: z
              .object({ path: z.string() })
              .transform(({ path }) => ({ path: `${path}/${++parses}` })),
            kind: "read",
            locations: ({ path }) => [{ path }],
            run: ({ path }) => {
              ran.push(path);
              return path;
            },
          }),
        ],
      ]),
    },
  };
  return { options, backing, updates, requests, ran, parses: () => parses };
}

test("intent and permission receipts gate prompts and the entire batch; parsed input is reused", async () => {
  const second = deferred<unknown>();
  const { options, requests, ran, updates, parses } = setup(() =>
    requests.length === 2 ? second.promise : allow,
  );
  const base = options.persistence;
  const intent = deferred<void>();
  const approval = deferred<void>();
  let waitingIntent = false;
  let waitingApproval = false;
  const session = await createSession({
    ...options,
    persistence: {
      ...base,
      append: async (request, signal) => {
        const records = request.records.map((raw) => JSON.parse(raw));
        if (records.some((r) => r.body.event?.event?.permissionRequired)) {
          waitingIntent = true;
          await intent.promise;
        }
        if (records.some((r) => r.body.event?.event?.type === "permission_settled")) {
          waitingApproval = true;
          await approval.promise;
        }
        return base.append(request, signal);
      },
    },
  });
  const settled = session.input("Read").settled;
  await until(() => waitingIntent);
  expect(requests).toHaveLength(0);
  expect(ran).toEqual([]);
  intent.resolve();
  await until(() => requests.length === 2);
  expect(ran).toEqual([]);
  expect(session.snapshot.durable.conversation.turn.status).toBe("awaiting_permission");
  expect(Object.isFrozen(requests[0]?.toolCall)).toBe(true);
  expect(requests[0]?.toolCall.locations).toEqual([{ path: "/tmp/one/1" }]);
  second.resolve(allow);
  await until(() => waitingApproval);
  expect(ran).toEqual([]);
  approval.resolve();
  const result = await settled;
  expect(result.kind === "terminal" && result.record.outcome.kind).toBe("completed");
  expect(ran).toEqual(["/tmp/one/1", "/tmp/two/2"]);
  expect(parses()).toBe(2);
  for (const request of requests) {
    const group = updates.filter((event) => event.toolCallId === request.toolCall.toolCallId);
    expect(group.map((event) => event.status).filter(Boolean)).toEqual([
      "pending",
      "in_progress",
      "completed",
    ]);
  }
  expect(session.snapshot.durable.records.every((record) => record.version === 1)).toBe(true);
  expect(journalJSONL(session.snapshot.durable)).toContain('"decision":"allow_once"');
  expect(journalJSONL(session.snapshot.durable)).not.toContain('"locations"');
  const restored = await restoreSession(options, session.snapshot.durable.conversation.sessionId);
  expect(requests).toHaveLength(2);
  await Promise.all([session.close(), restored.close()]);
});

for (const [label, response, outcome] of [
  ["reject", reject, "failed"],
  ["cancel", { outcome: { outcome: "cancelled" } }, "aborted"],
  ["unknown option", { outcome: { outcome: "selected", optionId: "allow-always" } }, "failed"],
  ["malformed response", {}, "failed"],
  ["exception", new Error("port failed"), "failed"],
] as const)
  test(`${label} on second permission prevents all tool execution`, async () => {
    const { options, requests, ran, updates } = setup(() => {
      if (requests.length === 1) return allow;
      if (response instanceof Error) throw response;
      return response;
    });
    const session = await createSession(options);
    const result = await session.input("Read").settled;
    expect(result.kind === "terminal" && result.record.outcome.kind).toBe(outcome);
    expect(ran).toEqual([]);
    expect(updates.filter((event) => event.status === "failed")).toHaveLength(2);
    expect(session.snapshot.durable.records.some((record) => record.body.kind === "tool")).toBe(
      false,
    );
    await session.close();
  });

test("abort signals permission port, rejects ordinary barge-in, and ignores late approval", async () => {
  const pending = deferred<unknown>();
  let signal: AbortSignal | undefined;
  const { options, requests, ran } = setup((_, value) => {
    signal = value;
    return pending.promise;
  });
  const session = await createSession(options);
  const turn = session.input("Read");
  await until(() => requests.length === 1);
  expect((await session.input("Wait").accepted).kind).toBe("failed");
  await session.fire({ type: "abort" });
  const result = await turn.settled;
  expect(result.kind === "terminal" && result.record.outcome.kind).toBe("aborted");
  expect(signal?.aborted).toBe(true);
  pending.resolve({ outcome: { outcome: "selected", optionId: "allow-session" } });
  await Bun.sleep(5);
  expect(requests).toHaveLength(1);
  expect(ran).toEqual([]);
  await session.close();
});

for (const approved of [false, true])
  test(`restore interrupted ${approved ? "approved" : "pending"} permission never reasks or runs`, async () => {
    const response = deferred<unknown>();
    const { options, requests, ran } = setup(() => (approved ? allow : response.promise));
    const base = options.persistence;
    const delayed = deferred<void>();
    let waiting = false;
    const session = await createSession({
      ...options,
      persistence: {
        ...base,
        append: async (request, signal) => {
          const result = await base.append(request, signal);
          if (
            approved &&
            request.records.some(
              (raw) => JSON.parse(raw).body.event?.event?.type === "permission_settled",
            )
          ) {
            waiting = true;
            await delayed.promise;
          }
          return result;
        },
      },
    });
    const turn = session.input("Read");
    await until(() => (approved ? waiting : requests.length === 1));
    const id = session.snapshot.durable.conversation.sessionId;
    await session.close();
    expect((await turn.settled).kind).toBe("closed");
    response.resolve(allow);
    delayed.resolve();
    const count = requests.length;
    const restored = await restoreSession(options, id);
    expect(requests).toHaveLength(count);
    expect(ran).toEqual([]);
    expect(restored.snapshot.durable.conversation.log.at(-1)?.outcome.kind).toBe("failed");
    await restored.close();
  });

test("missing binding fails create/restore; journal version, marker, and owner decisions cannot be forged", async () => {
  const { options, backing } = setup();
  await expect(
    createSession({ ...options, bindings: { ...options.bindings, requestPermission: undefined } }),
  ).rejects.toThrow("Missing permission");
  const session = await createSession(options);
  await session.input("Read").settled;
  const id = session.snapshot.durable.conversation.sessionId;
  await expect(
    restoreSession(
      { ...options, bindings: { ...options.bindings, requestPermission: undefined } },
      id,
    ),
  ).rejects.toThrow("Missing permission");
  const batches = backing.get(id)!;
  const resolvers = { ...builtinResolvers, permissionRequests: true };
  for (const mutate of [
    (r: any) => {
      if (r.body.event?.event?.permissionRequired) delete r.body.event.event.permissionRequired;
    },
    (r: any) => {
      if (r.body.event?.event?.type === "permission_settled")
        r.body.event.event.result.value[0].callId = "forged";
    },
    (r: any) => {
      if (r.body.event?.event?.type === "permission_settled") r.body.event.event.result.value.pop();
    },
  ]) {
    const changed = batches.map((batch) => ({
      ...batch,
      records: batch.records.map((raw) => {
        const record = JSON.parse(raw);
        mutate(record);
        return JSON.stringify(record);
      }),
    }));
    expect(() => replay(changed, resolvers)).toThrow();
  }
  expect(() =>
    JournalRecordSchema.parse({ ...session.snapshot.durable.records[0], version: 5 }),
  ).toThrow();
  await session.close();
});

test("lost approval receipt reconciles once; forks require new approvals", async () => {
  const { options, requests, ran } = setup();
  const session = await createSession({
    ...options,
    persistence: lostAcknowledgement(options.persistence, (records) =>
      records.some((raw) => raw.includes('"permission_settled"')),
    ),
  });
  await session.input("Read").settled;
  expect(ran).toHaveLength(2);
  const child = await session.fork();
  await child.input("Again").settled;
  expect(ran).toHaveLength(4);
  expect(requests).toHaveLength(4);
  expect(requests[2]?.sessionId).not.toBe(requests[0]?.sessionId);
  await Promise.all([session.close(), child.close()]);
});

test("nonjournaled runtime uses the same permission phase and port", async () => {
  const pending = deferred<unknown>();
  const { options, requests, ran } = setup(() => pending.promise);
  const runtime = createAgentRuntime({
    ...options.configuration,
    ...options.bindings,
    baseUrl: "https://example.invalid",
    complete: () => calls,
  });
  await runtime.fire({ type: "user", text: "Read" });
  await until(() => requests.length === 1);
  expect(runtime.snapshot.conversation.turn.status).toBe("awaiting_permission");
  pending.resolve(reject);
  await until(() => runtime.snapshot.conversation.log.length === 1);
  expect(ran).toEqual([]);
});

for (const admission of ["queue-user", "abort-tools-on-user"] as const)
  test(`${admission} applies while awaiting permission`, async () => {
    const pending = deferred<unknown>();
    const { options, requests, ran } = setup(() => pending.promise);
    const session = await createSession({
      ...options,
      configuration: {
        ...options.configuration,
        policy: { permissions: "ask", admission, bargeIn: admission !== "queue-user" },
      },
    });
    const first = session.input("Read");
    await until(() => requests.length === 1);
    const second = session.input("Next");
    expect((await second.accepted).kind).toBe("accepted");
    if (admission === "queue-user") {
      expect(session.snapshot.durable.conversation.turn.status).toBe("awaiting_permission");
      pending.resolve(reject);
    }
    const firstResult = await first.settled;
    expect(firstResult.kind === "terminal" && firstResult.record.outcome.kind).toBe(
      admission === "queue-user" ? "failed" : "aborted",
    );
    const secondResult = await second.settled;
    expect(secondResult.kind === "terminal" && secondResult.record.outcome.kind).toBe("completed");
    expect(ran).toEqual([]);
    pending.resolve(allow);
    await session.close();
  });

test("rejected approval append never executes tools", async () => {
  const { options, ran } = setup();
  const base = options.persistence;
  const session = await createSession({
    ...options,
    persistence: {
      ...base,
      append: (request, signal) =>
        request.records.some(
          (raw) => JSON.parse(raw).body.event?.event?.type === "permission_settled",
        )
          ? Promise.resolve({ kind: "rejected", message: "No approval receipt" })
          : base.append(request, signal),
    },
  });
  expect((await session.input("Read").settled).kind).toBe("failed");
  expect(ran).toEqual([]);
  await session.close();
});

test("permission mode changes only at idle policy boundaries; off keeps existing execution", async () => {
  const { options, requests, ran } = setup();
  const session = await createSession({
    ...options,
    configuration: { ...options.configuration, policy: {} },
  });
  await session.input("Read").settled;
  expect(requests).toHaveLength(0);
  expect(ran).toHaveLength(2);
  expect(session.snapshot.durable.records[0]?.version).toBe(1);
  await session.updatePolicy({ permissions: "ask" });
  await session.input("Ask").settled;
  expect(requests).toHaveLength(2);
  expect(session.snapshot.durable.records.at(-1)?.version).toBe(1);
  await session.updatePolicy({ permissions: "off" });
  await session.input("Off").settled;
  expect(requests).toHaveLength(2);
  expect(ran).toHaveLength(6);
  const restored = await restoreSession(options, session.snapshot.durable.conversation.sessionId);
  await Promise.all([session.close(), restored.close()]);
});

test("session tool approval is committed before reuse, retained across model changes, explicitly revoked, and absent on restore", async () => {
  const { withFixtureDiagnostics } = await import("../logging/fixture-capture.ts");
  const directory = `.session-artifacts/permission-grants/${crypto.randomUUID()}`;
  await withFixtureDiagnostics(directory, {}, async () => {
    const setupResult = setup(() => ({
      outcome: { outcome: "selected", optionId: "allow-session" },
    }));
    const { options: originalOptions, requests, ran, parses } = setupResult;
    let httpCalls = 0;
    const options: SessionOptions = {
      ...originalOptions,
      configuration: {
        ...originalOptions.configuration,
        policy: { permissions: "ask", provider: "scripted" },
      },
      bindings: {
        ...originalOptions.bindings,
        complete: undefined,
        providers: new Map([
          [
            "scripted",
            {
              profile: openaiChat,
              transport: {
                baseUrl: "https://scripted.invalid/v1",
                fetch: (async () =>
                  Response.json({
                    choices: [
                      {
                        finish_reason: ++httpCalls % 2 ? "tool_calls" : "stop",
                        message:
                          httpCalls % 2
                            ? {
                                content: calls.text,
                                tool_calls: calls.calls.map((call) => ({
                                  id: call.id,
                                  type: "function",
                                  function: {
                                    name: call.name,
                                    arguments: JSON.stringify(call.args),
                                  },
                                })),
                              }
                            : { content: "Done" },
                      },
                    ],
                  })) as unknown as typeof fetch,
              },
            },
          ],
        ]),
      },
    };
    const base = options.persistence;
    const receipt = deferred<void>();
    let awaitingReceipt = false;
    const resetReceipt = deferred<void>();
    let awaitingReset = false;
    const session = await createSession({
      ...options,
      persistence: {
        ...base,
        async append(request, signal) {
          if (
            !awaitingReceipt &&
            request.records.some(
              (raw) => JSON.parse(raw).body.event?.event?.type === "permission_settled",
            )
          ) {
            awaitingReceipt = true;
            await receipt.promise;
          }
          if (
            request.records.some((raw) => {
              const body = JSON.parse(raw).body;
              return body.kind === "policy" && body.patch.permissions === "ask";
            })
          ) {
            awaitingReset = true;
            await resetReceipt.promise;
          }
          return base.append(request, signal);
        },
      },
    });
    try {
      const first = session.input("Read both files");
      await until(() => awaitingReceipt);
      expect(requests).toHaveLength(1);
      expect(ran).toHaveLength(0);
      receipt.resolve();
      await first.settled;
      await session.input("Read them again").settled;
      expect(requests).toHaveLength(1);
      expect(ran).toHaveLength(4);
      expect(parses()).toBe(4);
      expect(journalJSONL(session.snapshot.durable)).toContain('"source":"remembered"');
      for (const patch of [
        { model: "another-model" },
        { thinking: "off" as const },
        { steps: 8, completionTimeoutMs: 1000, toolTimeoutMs: 1000 },
        { tools: { a: ["echo"] } },
      ]) {
        expect((await session.updatePolicy(patch)).kind).toBe("accepted");
        expect(await session.input("Keep the existing tool approval").settled).toMatchObject({
          kind: "terminal",
          record: { outcome: { kind: "completed" } },
        });
        expect(requests).toHaveLength(1);
      }
      const beforeReset = session.snapshot.durable.policy!.version;
      const reset = session.updatePolicy({ permissions: "ask" });
      await until(() => awaitingReset);
      expect(session.snapshot.durable.policy!.version).toBe(beforeReset);
      expect(await Bun.file(`${directory}/diagnostics.jsonl`).text()).not.toContain(
        '"event":"permission.grants_cleared"',
      );
      resetReceipt.resolve();
      expect((await reset).kind).toBe("accepted");
      await session.input("Ask again after revocation").settled;
      expect(requests).toHaveLength(2);
      expect((await session.updatePolicy({ tools: { a: [] } })).kind).toBe("accepted");
      expect((await session.updatePolicy({ tools: { a: ["echo"] } })).kind).toBe("accepted");
      await session.input("Ask after removing and re-enabling the tool").settled;
      expect(requests).toHaveLength(3);
      const restored = await restoreSession(
        options,
        session.snapshot.durable.conversation.sessionId,
      );
      try {
        expect(requests).toHaveLength(3);
        await restored.input("Ask again after reopening").settled;
        expect(requests).toHaveLength(4);
      } finally {
        await restored.close();
      }
    } finally {
      receipt.resolve();
      resetReceipt.resolve();
      await session.close();
    }
  });
  const logs = (await Bun.file(`${directory}/diagnostics.jsonl`).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    logs.some(
      (entry) =>
        entry.event === "permission.granted" &&
        entry.toolName === "echo" &&
        entry.scope === "live-session-tool",
    ),
  ).toBe(true);
  expect(
    logs.some(
      (entry) =>
        entry.event === "permission.reused" && entry.grantId && entry.turnId && entry.toolCallId,
    ),
  ).toBe(true);
  const resets = logs.filter((entry) => entry.event === "permission.grants_cleared");
  expect(resets).toHaveLength(3);
  expect(resets[0].reason).toContain("Permission mode explicitly committed");
  expect(resets[0].toolNames).toEqual(["echo"]);
  expect(resets[1].reason).toContain("Allowed tool scope changed");
  for (const reset of resets) {
    expect(reset.sessionId).toBeTruthy();
    expect(reset.policyVersion).toBeGreaterThan(0);
    const persisted = logs.findIndex(
      (entry) =>
        entry.event === "append.settled" &&
        entry.appendId === reset.appendId &&
        entry.outcome === "committed",
    );
    expect(persisted).toBeGreaterThanOrEqual(0);
    expect(persisted).toBeLessThan(logs.indexOf(reset));
  }
  expect(logs.filter((entry) => ["warning", "error"].includes(entry.level))).toEqual([]);
});

test("refused batch discards uncommitted remembered approvals and tool scopes do not cross", async () => {
  let round = 0;
  const fixture = setup((request) =>
    request.toolCall.name === "other"
      ? reject
      : { outcome: { outcome: "selected", optionId: "allow-session" } },
  );
  const echo = fixture.options.bindings.tools!.get("echo")!;
  const session = await createSession({
    ...fixture.options,
    configuration: {
      ...fixture.options.configuration,
      agents: new Map([["a", { model: "m", tools: ["echo", "other"] }]]),
    },
    bindings: {
      ...fixture.options.bindings,
      tools: new Map([
        ["echo", echo],
        ["other", echo],
      ]),
      complete: () => {
        round++;
        return { ...calls, calls: [calls.calls[0], { ...calls.calls[1], name: "other" }] };
      },
    },
  });
  try {
    await session.input("First refused batch").settled;
    await session.input("New explicit invocation").settled;
    expect(round).toBe(2);
    expect(fixture.requests.map((request) => request.toolCall.name)).toEqual([
      "echo",
      "other",
      "echo",
      "other",
    ]);
    expect(fixture.ran).toEqual([]);
  } finally {
    await session.close();
  }
});

test("tolerant validation failures commit tool errors without permission or execution and restore without effects", async () => {
  const { withFixtureDiagnostics } = await import("../logging/fixture-capture.ts");
  const directory = `.session-artifacts/tool-validation/${crypto.randomUUID()}`;
  await withFixtureDiagnostics(directory, {}, async () => {
    const f = setup();
    let completions = 0;
    const permissionReceipt = deferred<void>();
    let waitingForReceipt = false;
    const options: SessionOptions = {
      ...f.options,
      persistence: {
        ...f.options.persistence,
        append: async (request, signal) => {
          if (
            request.records.some(
              (raw) => JSON.parse(raw).body.event?.event?.type === "permission_settled",
            )
          ) {
            waitingForReceipt = true;
            await permissionReceipt.promise;
          }
          return f.options.persistence.append(request, signal);
        },
      },
      configuration: {
        ...f.options.configuration,
        policy: { permissions: "ask", toolFailure: "return-error-and-continue" },
      },
      bindings: {
        ...f.options.bindings,
        complete: (request) => {
          completions++;
          if (completions === 1)
            return {
              kind: "tools",
              text: "Read files",
              calls: [
                { id: "invalid", name: "echo", args: { path: 42 } },
                { id: "valid", name: "echo", args: { path: "/tmp/valid" } },
              ],
            };
          const results = request.messages.filter((message) => message.role === "tool");
          expect(results).toHaveLength(2);
          const invalid = JSON.parse(
            results.find((message) => message.tool_call_id === "invalid")!.content,
          );
          expect(invalid.failure).toMatchObject({
            classification: "invalid_input",
            phase: "validate_input",
            operation: { kind: "tool", callId: "invalid", toolName: "echo" },
          });
          expect(invalid.failure.cause.issues).toEqual([
            expect.objectContaining({ path: ["path"], code: "invalid_type", expected: "string" }),
          ]);
          expect(invalid.error).toContain("path");
          expect(invalid.error).toContain("string");
          return {
            kind: "answer",
            text: "The invalid call was rejected; the valid read completed.",
          };
        },
      },
    };
    const session = await createSession(options);
    const sessionId = session.snapshot.durable.conversation.sessionId;
    try {
      const turn = session.input("Read");
      await until(() => waitingForReceipt);
      expect(completions).toBe(1);
      expect(f.ran).toHaveLength(0);
      permissionReceipt.resolve();
      expect(await turn.settled).toMatchObject({
        record: { outcome: { kind: "completed" } },
      });
      expect(f.requests).toHaveLength(1);
      expect(f.requests[0]!.toolCall.toolCallId).toEndWith("/valid");
      expect(f.ran).toEqual(["/tmp/valid/1"]);
      expect(completions).toBe(2);
      expect(journalJSONL(session.snapshot.durable)).toContain('"decision":"invalid_input"');
    } finally {
      permissionReceipt.resolve();
      await session.close();
    }
    const restored = await restoreSession(options, sessionId);
    await restored.close();
    expect(f.requests).toHaveLength(1);
    expect(f.ran).toHaveLength(1);
    expect(completions).toBe(2);
  });
  const records = (await Bun.file(`${directory}/diagnostics.jsonl`).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const rejected = records.find((record) => record.event === "tool.input_rejected");
  expect(rejected).toMatchObject({ level: "warning", toolName: "echo", callId: "invalid" });
  expect(rejected.toolCallId).toEndWith("/invalid");
  expect(rejected.error.message).toContain("path");
  expect(rejected.consequence).toContain("will not execute or request approval");
});
