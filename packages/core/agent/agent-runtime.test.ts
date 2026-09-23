import { expect, test } from "bun:test";

import { z } from "zod";

import { createAgentRuntime, defineTool, type RuntimeOptions } from "./agent-runtime.ts";
import type { ChatCompletionRequest } from "./agent.ts";
import { deferred, until } from "./test-support.ts";
import { MessageSchema } from "./types.ts";

function harness(overrides: Partial<RuntimeOptions> = {}) {
  const requests: Array<{ request: ChatCompletionRequest } & ReturnType<typeof deferred<unknown>>> =
    [];
  const runtime = createAgentRuntime({
    agent: "writer",
    baseUrl: "http://localhost/v1",
    steps: 6,
    agents: new Map([
      ["writer", { model: "writer-model", systemPrompt: "Write.", tools: ["search"] }],
      ["reviewer", { model: "reviewer-model", systemPrompt: "Review." }],
    ]),
    tools: new Map([
      [
        "search",
        defineTool({ input: z.object({ query: z.number().optional() }), run: () => "result" }),
      ],
    ]),
    complete: (request) => {
      const result = deferred<unknown>();
      requests.push({ request, ...result });
      return result.promise;
    },
    ...overrides,
  });
  return { runtime, requests, state: () => runtime.snapshot.conversation };
}
const answer = (text: string) => ({ kind: "answer", text });
const calls = (...ids: string[]) => ({
  kind: "tools",
  text: "searching",
  calls: ids.map((id) => ({ id, name: "search", args: {} })),
});

test("two turns retain history, immutable snapshots and fresh per-turn budgets", async () => {
  const { runtime, requests, state } = harness();
  await runtime.fire({ type: "user", text: "first" });
  await until(() => requests.length === 1);
  requests[0]!.resolve(answer("first answer"));
  await until(() => state().log.length === 1);
  const previous = state();
  expect(previous.turn.status === "idle" && Number(previous.turn.steps)).toBe(6);
  await runtime.fire({ type: "user", text: "second" });
  await until(() => requests.length === 2);
  expect(requests[1]!.request.messages).toEqual([
    { role: "system", content: "Write." },
    { role: "user", content: "first" },
    { role: "assistant", content: "first answer" },
    { role: "user", content: "second" },
  ]);
  requests[1]!.resolve(answer("second answer"));
  await until(() => state().log.length === 2);
  expect(previous.log).toHaveLength(1);
  expect(Object.isFrozen(previous.log[0]!.messages)).toBe(true);
  expect(state().log.map((record) => record.outcome.kind)).toEqual(["completed", "completed"]);
  expect(runtime.snapshot.children).toHaveLength(0);
});

test("tool child actors fan out once and resume only after the complete batch", async () => {
  const executions: Array<{ signal: AbortSignal } & ReturnType<typeof deferred<unknown>>> = [];
  const { runtime, requests, state } = harness({
    tools: new Map([
      [
        "search",
        defineTool({
          input: z.object({}),
          run: (_, signal) => {
            const response = deferred<unknown>();
            executions.push({ signal, ...response });
            return response.promise;
          },
        }),
      ],
    ]),
  });
  await runtime.fire({ type: "user", text: "search" });
  await until(() => requests.length === 1);
  requests[0]!.resolve(calls("a", "b"));
  await until(() => executions.length === 2);
  expect(runtime.snapshot.children.filter((child) => child.ref.kind === "tool")).toHaveLength(2);
  expect(executions[0]!.signal).not.toBe(executions[1]!.signal);
  executions[1]!.resolve({ value: 2 });
  await until(
    () => runtime.snapshot.children.filter((child) => child.ref.kind === "tool").length === 1,
  );
  expect(requests).toHaveLength(1);
  await expect(runtime.fire({ type: "user", text: "too soon" })).rejects.toThrow(
    "tools are active",
  );
  executions[0]!.resolve("one");
  await until(() => requests.length === 2);
  expect(requests[1]!.request.messages.slice(-2)).toEqual([
    { role: "tool", content: '{"value":2}', tool_call_id: "b" },
    { role: "tool", content: "one", tool_call_id: "a" },
  ]);
  expect(executions).toHaveLength(2);
  requests[1]!.resolve(answer("done"));
  await until(() => state().log.length === 1);
});

test("handoff prepares a slim packet and starts the successor without further user input", async () => {
  const { runtime, requests, state } = harness();
  await runtime.fire({ type: "user", text: "old" });
  await until(() => requests.length === 1);
  await runtime.fire({ type: "user", text: "new" });
  await until(() => requests.length === 2);
  requests[1]!.resolve({ kind: "handoff", text: "Review this draft", agent: "reviewer" });
  await until(() => requests.length === 3);
  expect(requests[2]!.request.model).toBe("reviewer-model");
  expect(requests[2]!.request.messages).toEqual([
    { role: "system", content: "Review." },
    { role: "user", content: "new" },
    { role: "assistant", content: "Review this draft" },
  ]);
  requests[2]!.resolve(answer("Approved"));
  await until(() => state().log.length === 1);
  expect(state().log[0]!.messages.map((message) => message.text)).toEqual([
    "old",
    "new",
    "Review this draft",
    "Approved",
  ]);
});

test("barge-in aborts real fetch once; its AbortError cannot stop the replacement", async () => {
  const fetches: Array<
    { signal: AbortSignal; aborts: number } & ReturnType<typeof deferred<Response>>
  > = [];
  const { runtime, state } = harness({
    complete: undefined,
    fetch: (async (_, init) => {
      const response = deferred<Response>();
      const call = { signal: init!.signal!, aborts: 0, ...response };
      fetches.push(call);
      call.signal.addEventListener("abort", () => {
        call.aborts++;
        response.reject(new DOMException("cancelled", "AbortError"));
      });
      return response.promise;
    }) as typeof fetch,
  });
  await runtime.fire({ type: "user", text: "first" });
  await until(() => fetches.length === 1);
  await runtime.fire({ type: "user", text: "replacement" });
  await until(() => fetches.length === 2);
  expect(fetches[0]!.aborts).toBe(1);
  expect(fetches[1]!.signal.aborted).toBe(false);
  fetches[1]!.resolve(Response.json({ choices: [{ message: { content: "answer" } }] }));
  await until(() => state().log.length === 1);
  expect(state().log[0]!.outcome.kind).toBe("completed");
});

test("late success and failure from cancelled requests cannot alter replacement work", async () => {
  const { runtime, requests, state } = harness();
  await runtime.fire({ type: "user", text: "first" });
  await until(() => requests.length === 1);
  await runtime.fire({ type: "user", text: "replacement" });
  await until(() => requests.length === 2);
  requests[0]!.resolve(answer("stale"));
  requests[1]!.resolve(answer("current"));
  await until(() => state().log.length === 1);
  expect(state().log[0]!.messages.at(-1)?.text).toBe("current");
  await runtime.fire({ type: "user", text: "cancel me" });
  await until(() => requests.length === 3);
  await runtime.fire({ type: "abort" });
  await runtime.fire({ type: "user", text: "next turn" });
  await until(() => requests.length === 4);
  requests[2]!.reject(new Error("late failure"));
  requests[3]!.resolve(answer("done"));
  await until(() => state().log.length === 3);
  expect(state().log.map((record) => record.outcome.kind)).toEqual([
    "completed",
    "aborted",
    "completed",
  ]);
});

test("budgets cover handoff, post-tool and barge-in launches without extra requests", async () => {
  for (const result of [calls("a"), { kind: "handoff", text: "review", agent: "reviewer" }]) {
    const { runtime, requests, state } = harness({ steps: 1 });
    await runtime.fire({ type: "user", text: "work" });
    await until(() => requests.length === 1);
    requests[0]!.resolve(result);
    await until(() => state().log.length === 1);
    expect(requests).toHaveLength(1);
    expect(state().log[0]!.outcome.kind).toBe("exhausted");
  }
  const { runtime, requests, state } = harness({ steps: 1 });
  await runtime.fire({ type: "user", text: "first" });
  await until(() => requests.length === 1);
  await runtime.fire({ type: "user", text: "replacement" });
  await until(() => state().log.length === 1);
  expect(state().log[0]!.outcome.kind).toBe("exhausted");
  expect(requests).toHaveLength(1);
  const zero = harness({ steps: 0 });
  await zero.runtime.fire({ type: "user", text: "no budget" });
  expect(zero.requests).toHaveLength(0);
  expect(zero.state().log[0]!.outcome.kind).toBe("exhausted");
});

test("Zod rejects malformed, mixed and unpermitted completions before tool execution", async () => {
  let ran = 0;
  for (const result of [
    null,
    { text: "missing discriminant" },
    { kind: "tools", text: "", calls: [] },
    calls("a", "a"),
    { kind: "handoff", text: "", agent: "missing" },
    { kind: "tools", text: "", calls: [{ id: "a", name: "missing", args: {} }] },
    { ...calls("a"), agent: "reviewer" },
  ]) {
    const { runtime, requests, state } = harness({
      tools: new Map([
        [
          "search",
          defineTool({
            input: z.object({}),
            run: () => {
              ran++;
              return "ok";
            },
          }),
        ],
      ]),
    });
    await runtime.fire({ type: "user", text: "work" });
    await until(() => requests.length === 1);
    requests[0]!.resolve(result);
    await until(() => state().log.length === 1);
    expect(state().log[0]!.outcome.kind).toBe("failed");
  }
  expect(ran).toBe(0);
});

test("tool argument validation fails its actor before invoking the tool", async () => {
  let ran = false;
  const { runtime, requests, state } = harness({
    tools: new Map([
      [
        "search",
        defineTool({
          input: z.object({ query: z.string() }),
          run: ({ query }) => {
            ran = true;
            return query;
          },
        }),
      ],
    ]),
  });
  await runtime.fire({ type: "user", text: "work" });
  await until(() => requests.length === 1);
  requests[0]!.resolve(calls("a"));
  await until(() => state().log.length === 1);
  expect(ran).toBe(false);
  expect(state().log[0]!.outcome.kind).toBe("failed");
});

test("tool failure cancels siblings and preserves results already settled", async () => {
  const executions: Array<{ signal: AbortSignal } & ReturnType<typeof deferred<unknown>>> = [];
  const { runtime, requests, state } = harness({
    tools: new Map([
      [
        "search",
        defineTool({
          input: z.object({}),
          run: (_, signal) => {
            const result = deferred<unknown>();
            executions.push({ signal, ...result });
            return result.promise;
          },
        }),
      ],
    ]),
  });
  await runtime.fire({ type: "user", text: "work" });
  await until(() => requests.length === 1);
  requests[0]!.resolve(calls("a", "b", "c"));
  await until(() => executions.length === 3);
  executions[0]!.resolve("found");
  await until(
    () => runtime.snapshot.children.filter((child) => child.ref.kind === "tool").length === 2,
  );
  executions[1]!.reject(new Error("offline"));
  await until(() => state().log.length === 1);
  expect(executions[2]!.signal.aborted).toBe(true);
  expect(state().log[0]!.outcome).toEqual({ kind: "failed", error: { message: "offline" } });
  expect(state().log[0]!.messages.at(-1)).toEqual(
    MessageSchema.parse({ role: "tool", callId: "a", text: "found" }),
  );
  await runtime.fire({ type: "user", text: "again" });
  await until(() => requests.length === 2);
  executions[2]!.resolve("late");
  requests[1]!.resolve(answer("recovered"));
  await until(() => state().log.length === 2);
  expect(state().log[1]!.outcome.kind).toBe("completed");
});

test("explicit tool-batch abort preserves partial results and cancels every remaining child", async () => {
  const executions: Array<{ signal: AbortSignal } & ReturnType<typeof deferred<unknown>>> = [];
  const { runtime, requests, state } = harness({
    tools: new Map([
      [
        "search",
        defineTool({
          input: z.object({}),
          run: (_, signal) => {
            const result = deferred<unknown>();
            executions.push({ signal, ...result });
            return result.promise;
          },
        }),
      ],
    ]),
  });
  await runtime.fire({ type: "user", text: "work" });
  await until(() => requests.length === 1);
  requests[0]!.resolve(calls("a", "b"));
  await until(() => executions.length === 2);
  executions[0]!.resolve("found");
  await until(
    () => runtime.snapshot.children.filter((child) => child.ref.kind === "tool").length === 1,
  );
  await runtime.fire({ type: "abort" });
  await until(() => state().log.length === 1 && runtime.snapshot.children.length === 0);
  expect(executions[1]!.signal.aborted).toBe(true);
  expect(state().log[0]!.messages.at(-1)).toEqual(
    MessageSchema.parse({ role: "tool", callId: "a", text: "found" }),
  );
  expect(state().log[0]!.outcome.kind).toBe("aborted");
});

test("projection and handoff failures are actor outcomes and preserve a valid terminal record", async () => {
  for (const overrides of [
    {
      complete: () => {
        throw new Error("offline");
      },
    },
    {
      projectPrompt: () => {
        throw new Error("projection failed");
      },
    },
    { projectPrompt: () => "invalid prompt" },
  ]) {
    const { runtime, state } = harness(overrides);
    await runtime.fire({ type: "user", text: "work" });
    await until(() => state().log.length === 1);
    expect(state().log[0]!.outcome.kind).toBe("failed");
  }
  const { runtime, requests, state } = harness({
    projectHandoff: () => {
      throw new Error("packet failed");
    },
  });
  await runtime.fire({ type: "user", text: "work" });
  await until(() => requests.length === 1);
  requests[0]!.resolve({ kind: "handoff", text: "draft", agent: "reviewer" });
  await until(() => state().log.length === 1);
  expect(state().log[0]!.outcome).toEqual({ kind: "failed", error: { message: "packet failed" } });
});

test("cancelling prompt preparation prevents a late projection from launching HTTP", async () => {
  const projection = deferred<unknown>();
  let signal!: AbortSignal;
  const { runtime, requests, state } = harness({
    projectPrompt: (_, current) => {
      signal = current;
      return projection.promise;
    },
  });
  await runtime.fire({ type: "user", text: "work" });
  await until(() => Boolean(signal));
  await runtime.fire({ type: "abort" });
  projection.resolve([]);
  await until(() => runtime.snapshot.children.length === 0);
  expect(signal.aborted).toBe(true);
  expect(requests).toHaveLength(0);
  expect(state().log[0]!.outcome.kind).toBe("aborted");
});

test("public inputs cannot forge child messages or bypass validation", async () => {
  const { runtime, state } = harness();
  const before = state();
  await expect(
    runtime.fire({ type: "child", turnId: "turn/1", event: { type: "abort" } }),
  ).rejects.toThrow();
  await expect(runtime.fire({ type: "user", text: 42 })).rejects.toThrow();
  expect(state()).toBe(before);
  expect(() => harness({ steps: -1 })).toThrow();
});

test("runtime copies tool definitions so caller mutation cannot change admitted execution", async () => {
  const definition = {
    parameters: { type: "object" },
    parseInput: async (value: unknown) => value,
    run: () => "original",
  };
  const registry = new Map([["search", definition]]);
  const { runtime, requests, state } = harness({ tools: registry });
  definition.run = () => "mutated";
  definition.parameters.type = "string";
  registry.clear();
  await runtime.fire({ type: "user", text: "work" });
  await until(() => requests.length === 1);
  expect(requests[0]!.request.tools?.[0]?.function.parameters).toEqual({ type: "object" });
  requests[0]!.resolve(calls("a"));
  await until(() => requests.length === 2);
  expect(requests[1]!.request.messages.at(-1)).toEqual({
    role: "tool",
    content: "original",
    tool_call_id: "a",
  });
  requests[1]!.resolve(answer("done"));
  await until(() => state().log.length === 1);
});
