import { expect, test } from "bun:test";
import { createAgentRuntime, type RuntimeOptions, type Tool } from "./agent-runtime.ts";
import type { ChatCompletionRequest } from "./agent.ts";
import type { Completion } from "./types.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("Runtime did not reach the expected state");
}
function harness(overrides: Partial<RuntimeOptions> = {}) {
  const requests: Array<{ request: ChatCompletionRequest } & ReturnType<typeof deferred<Completion>>> = [];
  const runtime = createAgentRuntime({
    agent: "writer", baseUrl: "http://localhost/v1", budget: { steps: 6, usd: 1 },
    agents: new Map([
      ["writer", { model: "writer-model", systemPrompt: "Write.", tools: ["search"] }],
      ["reviewer", { model: "reviewer-model", systemPrompt: "Review." }],
    ]),
    tools: new Map([["search", { parameters: {}, run: () => "result" }]]),
    complete: request => {
      const response = deferred<Completion>();
      requests.push({ request, ...response });
      return response.promise;
    },
    ...overrides,
  });
  return { runtime, requests };
}

test("two turns retain assistant history and reset the step allowance", async () => {
  const { runtime, requests } = harness();
  await runtime.fire({ type: "user", text: "first" });
  await until(() => requests.length === 1);
  requests[0]!.resolve({ text: "first answer" });
  await until(() => runtime.snapshot.log.length === 1);
  expect(runtime.snapshot.agentContext.budget.steps).toBe(6);
  await runtime.fire({ type: "user", text: "second" });
  await until(() => requests.length === 2);
  expect(requests[1]!.request.messages).toEqual([
    { role: "system", content: "Write." }, { role: "user", content: "first" },
    { role: "assistant", content: "first answer" }, { role: "user", content: "second" },
  ]);
  requests[1]!.resolve({ text: "second answer" });
  await until(() => runtime.snapshot.log.length === 2);
  expect(runtime.snapshot.log.map(turn => turn.completion)).toEqual(["completed", "completed"]);
});

test("tool entry fans out once, ignores duplicate results and resumes after the last result", async () => {
  const calls: Array<{ args: unknown; signal: AbortSignal } & ReturnType<typeof deferred<unknown>>> = [];
  const tool: Tool = { parameters: {}, run: (args, signal) => {
    const response = deferred<unknown>(); calls.push({ args, signal, ...response }); return response.promise;
  } };
  const { runtime, requests } = harness({ tools: new Map([["search", tool]]) });
  await runtime.fire({ type: "user", text: "search twice" });
  await until(() => requests.length === 1);
  requests[0]!.resolve({ text: "", toolCalls: [
    { id: "a", name: "search", args: { query: 1 } }, { id: "b", name: "search", args: { query: 2 } },
  ] });
  await until(() => calls.length === 2);
  const operationId = runtime.snapshot.agentContext.operation!.id;
  expect(calls[0]!.signal).toBe(calls[1]!.signal);
  calls[1]!.resolve({ value: 2 });
  await until(() => runtime.snapshot.agentContext.pendingTools.length === 1);
  await runtime.fire({ type: "agent", turnId: 1, operationId, event: { type: "tool_done", id: "b", result: "duplicate" } });
  expect(calls).toHaveLength(2);
  expect(requests).toHaveLength(1);
  calls[0]!.resolve("one");
  await until(() => requests.length === 2);
  expect(requests[1]!.request.messages.slice(-2)).toEqual([
    { role: "tool", content: '{"value":2}', tool_call_id: "b" },
    { role: "tool", content: "one", tool_call_id: "a" },
  ]);
  expect(runtime.snapshot.agentContext.budget.steps).toBe(4);
  requests[1]!.resolve({ text: "done" });
  await until(() => runtime.snapshot.log.length === 1);
});

test("handoff immediately requests the successor using a slim packet and keeps the full log", async () => {
  const { runtime, requests } = harness();
  await runtime.fire({ type: "user", text: "old instruction" });
  await until(() => requests.length === 1);
  await runtime.fire({ type: "user", text: "new instruction" });
  await until(() => requests.length === 2);
  requests[1]!.resolve({ text: "Review this draft", handoff: "reviewer" });
  await until(() => requests.length === 3);
  expect(runtime.snapshot.agentContext.agent).toBe("reviewer");
  expect(requests[2]!.request.model).toBe("reviewer-model");
  expect(requests[2]!.request.messages).toEqual([
    { role: "system", content: "Review." }, { role: "user", content: "new instruction" },
    { role: "assistant", content: "Review this draft" },
  ]);
  requests[2]!.resolve({ text: "Approved" });
  await until(() => runtime.snapshot.log.length === 1);
  expect(runtime.snapshot.log[0]!.messages.map(message => message.text)).toEqual([
    "old instruction", "new instruction", "Review this draft", "Approved",
  ]);
});

test("barge-in aborts real fetch once and its AbortError cannot abort the replacement", async () => {
  const fetches: Array<{ signal: AbortSignal; aborts: number } & ReturnType<typeof deferred<Response>>> = [];
  const { runtime } = harness({ complete: undefined, fetch: (async (_, init) => {
    const response = deferred<Response>();
    const call = { signal: init!.signal!, aborts: 0, ...response };
    fetches.push(call);
    call.signal.addEventListener("abort", () => { call.aborts++; response.reject(new DOMException("cancelled", "AbortError")); });
    return response.promise;
  }) as typeof fetch });
  await runtime.fire({ type: "user", text: "first" });
  await until(() => fetches.length === 1);
  await runtime.fire({ type: "user", text: "replacement" });
  await until(() => fetches.length === 2);
  expect(fetches[0]!.aborts).toBe(1);
  expect(fetches[1]!.signal.aborted).toBe(false);
  expect(runtime.snapshot.log).toHaveLength(0);
  fetches[1]!.resolve(Response.json({ choices: [{ message: { content: "answer" } }] }));
  await until(() => runtime.snapshot.log.length === 1);
  expect(runtime.snapshot.log[0]!.completion).toBe("completed");
});

test("a client ignoring cancellation cannot deliver a stale answer into the new request or child", async () => {
  const { runtime, requests } = harness();
  await runtime.fire({ type: "user", text: "first" });
  await until(() => requests.length === 1);
  await runtime.fire({ type: "user", text: "replacement" });
  await until(() => requests.length === 2);
  requests[0]!.resolve({ text: "stale" });
  requests[1]!.resolve({ text: "current" });
  await until(() => runtime.snapshot.log.length === 1);
  expect(runtime.snapshot.log[0]!.messages.at(-1)?.text).toBe("current");
  await runtime.fire({ type: "user", text: "next turn" });
  await until(() => requests.length === 3);
  const oldTurn = runtime.snapshot.turnId;
  await runtime.fire({ type: "abort" });
  await runtime.fire({ type: "user", text: "another turn" });
  await until(() => requests.length === 4);
  requests[2]!.reject(new Error("late old failure"));
  requests[3]!.resolve({ text: "final" });
  await until(() => runtime.snapshot.log.length === 3);
  expect(runtime.snapshot.turnId).toBe(oldTurn + 2);
  expect(runtime.snapshot.log.map(turn => turn.completion)).toEqual(["completed", "aborted", "completed"]);
});

test("step exhaustion starts no extra request, including handoff and tool continuations", async () => {
  for (const result of [
    { text: "handoff", handoff: "reviewer" },
    { text: "", toolCalls: [{ id: "a", name: "search", args: {} }] },
  ]) {
    const { runtime, requests } = harness({ budget: { steps: 1, usd: 1 } });
    await runtime.fire({ type: "user", text: "work" });
    await until(() => requests.length === 1);
    requests[0]!.resolve(result);
    await until(() => runtime.snapshot.log.length === 1);
    expect(requests).toHaveLength(1);
    expect(runtime.snapshot.log[0]!.completion).toBe("exhausted");
  }
  const { runtime, requests } = harness({ budget: { steps: 0, usd: 1 } });
  await runtime.fire({ type: "user", text: "work" });
  await until(() => runtime.snapshot.log.length === 1);
  expect(requests).toHaveLength(0);
  expect(runtime.snapshot.log[0]!.completion).toBe("exhausted");
});

test("unpermitted tools, duplicate IDs and unknown handoffs fail without running tools", async () => {
  let ran = 0;
  for (const result of [
    { text: "", handoff: "missing" },
    { text: "", toolCalls: [{ id: "a", name: "missing", args: {} }] },
    { text: "", toolCalls: [{ id: "a", name: "search", args: {} }, { id: "a", name: "search", args: {} }] },
    { text: "", handoff: "reviewer", toolCalls: [{ id: "a", name: "search", args: {} }] },
  ]) {
    const { runtime, requests } = harness({ tools: new Map([["search", { parameters: {}, run: () => { ran++; } }]]) });
    await runtime.fire({ type: "user", text: "work" });
    await until(() => requests.length === 1);
    requests[0]!.resolve(result);
    await until(() => runtime.snapshot.log.length === 1);
    expect(runtime.snapshot.log[0]!.completion).toBe("failed");
  }
  expect(ran).toBe(0);
});

test("tool failure cancels its siblings and leaves usable history for the next turn", async () => {
  const calls: Array<{ signal: AbortSignal } & ReturnType<typeof deferred<unknown>>> = [];
  const { runtime, requests } = harness({ tools: new Map([["search", { parameters: {}, run: (_, signal) => {
    const response = deferred<unknown>(); calls.push({ signal, ...response }); return response.promise;
  } }]]) });
  await runtime.fire({ type: "user", text: "work" });
  await until(() => requests.length === 1);
  requests[0]!.resolve({ text: "searching", toolCalls: [
    { id: "a", name: "search", args: {} }, { id: "b", name: "search", args: {} },
  ] });
  await until(() => calls.length === 2);
  calls[0]!.reject(new Error("tool unavailable"));
  await until(() => runtime.snapshot.log.length === 1);
  expect(calls[1]!.signal.aborted).toBe(true);
  expect(runtime.snapshot.log[0]!.error).toBe("tool unavailable");
  await runtime.fire({ type: "user", text: "try again" });
  await until(() => requests.length === 2);
  expect(requests[1]!.request.messages.some(message => message.tool_calls || message.role === "tool")).toBe(false);
  calls[1]!.resolve("late");
  requests[1]!.resolve({ text: "recovered" });
  await until(() => runtime.snapshot.log.length === 2);
  expect(runtime.snapshot.log[1]!.completion).toBe("completed");
});

test("completion and projector failures record failures instead of successful empty answers", async () => {
  for (const overrides of [
    { complete: () => { throw new Error("offline"); } },
    { projectPrompt: () => { throw new Error("projection failed"); } },
  ]) {
    const { runtime } = harness(overrides);
    await runtime.fire({ type: "user", text: "work" });
    await until(() => runtime.snapshot.log.length === 1);
    expect(runtime.snapshot.log[0]!.completion).toBe("failed");
    expect(runtime.snapshot.log[0]!.messages).toHaveLength(1);
  }
  const { runtime, requests } = harness({ projectHandoff: () => { throw new Error("handoff projection failed"); } });
  await runtime.fire({ type: "user", text: "work" });
  await until(() => requests.length === 1);
  requests[0]!.resolve({ text: "handoff", handoff: "reviewer" });
  await until(() => runtime.snapshot.log.length === 1);
  expect(runtime.snapshot.log[0]!.error).toBe("handoff projection failed");
});

test("queued stale operation events cannot mutate the replacement request", async () => {
  const { runtime, requests } = harness({ budget: { steps: 1, usd: 1 } });
  await runtime.fire({ type: "user", text: "first" });
  await until(() => requests.length === 1);
  const old = runtime.snapshot.agentContext.operation!.id;
  await Promise.all([
    runtime.fire({ type: "user", text: "replacement" }),
    runtime.fire({ type: "agent", turnId: 1, operationId: old, event: { type: "model_done", text: "stale" } }),
  ]);
  await until(() => runtime.snapshot.log.length === 1);
  expect(runtime.snapshot.log[0]!.completion).toBe("exhausted");
  expect(runtime.snapshot.log[0]!.messages.map(message => message.text)).toEqual(["first", "replacement"]);
  expect(requests).toHaveLength(1);
});

test("explicit abort cancels a tool batch and rejects late results after child replacement", async () => {
  let signal!: AbortSignal;
  const toolResult = deferred<unknown>();
  const { runtime, requests } = harness({ tools: new Map([["search", { parameters: {}, run: (_, currentSignal) => {
    signal = currentSignal; return toolResult.promise;
  } }]]) });
  await runtime.fire({ type: "user", text: "work" });
  await until(() => requests.length === 1);
  requests[0]!.resolve({ text: "", toolCalls: [{ id: "a", name: "search", args: {} }] });
  await until(() => Boolean(signal));
  await runtime.fire({ type: "abort" });
  expect(signal.aborted).toBe(true);
  expect(runtime.snapshot.log[0]!.completion).toBe("aborted");
  await runtime.fire({ type: "user", text: "next" });
  await until(() => requests.length === 2);
  toolResult.resolve("late");
  requests[1]!.resolve({ text: "new answer" });
  await until(() => runtime.snapshot.log.length === 2);
  expect(runtime.snapshot.log[1]!.messages).toEqual([
    { role: "user", text: "next" }, { role: "assistant", text: "new answer" },
  ]);
});
