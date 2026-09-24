import { expect, test } from "@logtape/testing-bun/autoload";
import { z } from "zod";

import { createAgentRuntime } from "../agent/agent-runtime.ts";
import type { HostToolNotification } from "../host/host.ts";
import { journalJSONL } from "./session-log.ts";
import {
  createSession,
  defineTool,
  restoreSession,
  type SessionOptions,
} from "./session-runtime.ts";
import { deferred, deterministicIds, testOptions, until } from "./test-support.ts";
import { createMemoryPersistence } from "./testing/memory-persistence.ts";

const calls = {
  kind: "tools",
  text: "Review",
  calls: [{ id: "same-call", name: "echo", args: { path: "/tmp/DESIGN.md" } }],
};

const answer = { kind: "answer", text: "done" };

const tool = () =>
  defineTool({
    input: z.object({ path: z.string() }),
    kind: "read",
    locations: ({ path }) => [{ path, line: 2 }],
    run: () => "contents",
  });

test("session tool notifications respect intent receipt but never certify result commit; restore is silent", async () => {
  const base = createMemoryPersistence();
  const intent = deferred<void>();
  const result = deferred<void>();
  let awaitingIntent = false;
  let awaitingResult = false;
  let completions = 0;
  const updates: HostToolNotification[] = [];
  const opts: SessionOptions = {
    persistence: {
      ...base,
      append: async (request, signal) => {
        const bodies = request.records.map((raw) => JSON.parse(raw).body);
        if (
          !awaitingIntent &&
          bodies.some(
            (body) =>
              body.event?.event?.type === "model_settled" &&
              body.event.event.result?.value?.kind === "tools",
          )
        ) {
          awaitingIntent = true;
          await intent.promise;
        }
        if (!awaitingResult && bodies.some((body) => body.kind === "tool")) {
          awaitingResult = true;
          await result.promise;
        }
        return base.append(request, signal);
      },
    },
    configuration: {
      agent: "a",
      agents: new Map([["a", { model: "m", tools: ["echo"] }]]),
      steps: 4,
    },
    bindings: {
      id: deterministicIds(),
      tools: new Map([["echo", tool()]]),
      complete: () => (++completions % 2 ? calls : answer),
      toolUpdate: (event) => {
        updates.push(event);
      },
    },
  };
  const session = await createSession(opts);
  const pending = session.input("Review").settled;
  await until(() => awaitingIntent);
  expect(updates).toEqual([]);
  intent.resolve();
  await until(() => awaitingResult);
  expect(updates.map((event) => event.status).filter(Boolean)).toEqual([
    "pending",
    "in_progress",
    "completed",
  ]);
  expect(completions).toBe(1);
  expect(session.snapshot.durable.records.some((record) => record.body.kind === "tool")).toBe(
    false,
  );
  result.resolve();
  await pending;
  expect(completions).toBe(2);
  const serialized = journalJSONL(session.snapshot.durable);
  expect(serialized).not.toContain('"sessionUpdate"');
  expect(serialized).not.toContain('"locations"');
  const count = updates.length;
  const restored = await restoreSession(opts, session.snapshot.durable.conversation.sessionId);
  expect(updates).toHaveLength(count);
  const fork = await session.fork();
  // Binding callbacks are captured at construction, including for children.
  (opts.bindings as { toolUpdate: unknown }).toolUpdate = () => {
    throw new Error("replacement");
  };
  await fork.input("Again").settled;
  expect(updates).toHaveLength(count * 2);
  expect(
    new Set(
      updates
        .filter((event) => event.sessionUpdate === "tool_call")
        .map((event) => event.toolCallId),
    ).size,
  ).toBe(2);
  expect(updates.at(-1)?.sessionId).toBe(fork.snapshot.durable.conversation.sessionId);
  await Promise.all([session.close(), restored.close(), fork.close()]);
});

test("session and nonjournaled runtime expose the same optional tool sink", async () => {
  for (const journaled of [true, false]) {
    const updates: HostToolNotification[] = [];
    let completions = 0;
    const options = testOptions({
      tools: new Map([["echo", tool()]]),
      complete: () => (++completions % 2 ? calls : answer),
      toolUpdate: (event) => {
        updates.push(event);
      },
    });
    if (journaled) {
      const session = await createSession(options);
      await session.input("Review").settled;
      expect(updates.at(-1)?.status).toBe("completed");
      await session.close();
    } else {
      const runtime = createAgentRuntime({
        ...options.configuration,
        ...options.bindings,
        baseUrl: "https://example.invalid",
        complete: () => (++completions % 2 ? calls : answer),
      });
      await runtime.fire({ type: "user", text: "Review" });
      await until(() => runtime.snapshot.conversation.log.length === 1);
      expect(updates.at(-1)?.status).toBe("completed");
      expect(updates[0]?.sessionId).toBe(runtime.snapshot.conversation.sessionId);
    }
  }
});
