import { expect, test } from "@logtape/testing-bun/autoload";
import { z } from "zod";

import { createAgentRuntime } from "../agent/agent-runtime.ts";
import type { HostToolNotification } from "../host/host.ts";
import type { PermissionPort, PermissionRequest } from "../host/ports.ts";
import { builtinResolvers } from "../policy/policy.ts";
import { journalJSONL, replay } from "./session-log.ts";
import {
  createSession,
  defineTool,
  restoreSession,
  type BoundSessionOptions,
} from "./session-runtime.ts";
import {
  deferred,
  deterministicIds,
  lostAcknowledgement,
  testOptions,
  until,
} from "./test-support.ts";
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
  const options: BoundSessionOptions = {
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
  expect(session.snapshot.durable.records.every((record) => record.version === 6)).toBe(true);
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
  pending.resolve(allow);
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
  const runtime = createAgentRuntime(testOptions({ ...options.bindings, complete: () => calls }));
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
  expect(session.snapshot.durable.records[0]?.version).toBe(2);
  await session.updatePolicy({ permissions: "ask" });
  await session.input("Ask").settled;
  expect(requests).toHaveLength(2);
  expect(session.snapshot.durable.records.at(-1)?.version).toBe(6);
  await session.updatePolicy({ permissions: "off" });
  await session.input("Off").settled;
  expect(requests).toHaveLength(2);
  expect(ran).toHaveLength(6);
  const restored = await restoreSession(options, session.snapshot.durable.conversation.sessionId);
  await Promise.all([session.close(), restored.close()]);
});
