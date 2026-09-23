import { expect, test } from "bun:test";
import { z } from "zod";
import { createAgentRuntime, defineTool, type AgentRuntime, type RuntimeOptions } from "./agent-runtime.ts";
import type { ChatCompletionRequest } from "./agent.ts";
import { deferred, until } from "./test-support.ts";

function harness(overrides: Partial<RuntimeOptions> = {}) {
  const requests: Array<{ request: ChatCompletionRequest } & ReturnType<typeof deferred<unknown>>> = [];
  const runtime = createAgentRuntime({
    agent: "writer", agents: new Map([["writer", { model: "write", tools: ["lookup"] }], ["reviewer", { model: "review" }]]),
    tools: new Map([["lookup", defineTool({ input: z.object({}), run: () => "found" })]]),
    baseUrl: "http://localhost/v1", steps: 4,
    complete: request => { const response = deferred<unknown>(); requests.push({ request, ...response }); return response.promise; },
    ...overrides,
  });
  return { runtime, requests };
}
const answer = (text: string) => ({ kind: "answer", text });
const toolCalls = (...ids: string[]) => ({ kind: "tools", text: "searching", calls: ids.map(id => ({ id, name: "lookup", args: {} })) });
async function finish(h: ReturnType<typeof harness>, text = "first") {
  await h.runtime.fire({ type: "user", text });
  await until(() => h.requests.length > 0);
  h.requests.at(-1)!.resolve(answer("answer"));
  await until(() => h.runtime.snapshot.conversation.turn.status === "idle");
}

test("fork clones a completed session under fresh identities and continues independently", async () => {
  const h = harness();
  await finish(h);
  const before = h.runtime.snapshot.conversation;
  const fork = await h.runtime.fork();
  const cloned = fork.snapshot.conversation;
  expect(cloned.sessionId).not.toBe(before.sessionId);
  expect(cloned.turnId).not.toBe(before.turnId);
  expect(cloned.log).toEqual(before.log);
  expect(cloned.context).toEqual(before.context);
  expect(cloned.origin).toEqual({ kind: "fork", parent: before.sessionId, sequence: before.sequence });
  expect(cloned.pending).toEqual([]);
  expect(fork.snapshot.children).toEqual([]);
  expect(h.runtime.snapshot.conversation.log).toBe(before.log);
  await h.runtime.fire({ type: "user", text: "original branch" });
  await fork.fire({ type: "user", text: "fork branch" });
  await until(() => h.requests.length === 3);
  expect(h.requests[1]!.request.signal).not.toBe(h.requests[2]!.request.signal);
  expect(h.requests[2]!.request.messages.map(message => message.content)).toEqual(["first", "answer", "fork branch"]);
  await h.runtime.fire({ type: "abort" });
  expect(h.requests[1]!.request.signal?.aborted).toBe(true);
  expect(h.requests[2]!.request.signal?.aborted).toBe(false);
  h.requests[1]!.resolve(answer("late original"));
  h.requests[2]!.resolve(answer("fork answer"));
  await until(() => fork.snapshot.conversation.log.length === 2);
  expect(fork.snapshot.conversation.log[1]?.outcome.kind).toBe("completed");
  expect(h.runtime.snapshot.conversation.log[1]?.outcome.kind).toBe("aborted");
  expect(before.log).toHaveLength(1);
});

test("fork waits for Done, includes the settled answer, and preserves barge-in", async () => {
  const h = harness();
  await h.runtime.fire({ type: "user", text: "first" });
  await until(() => h.requests.length === 1);
  let published = false;
  const pending = h.runtime.fork().then(fork => { published = true; return fork; });
  await until(() => h.runtime.snapshot.conversation.pending.length === 1);
  expect(published).toBe(false);
  await h.runtime.fire({ type: "user", text: "replacement" });
  await until(() => h.requests.length === 2);
  expect(h.requests[0]!.request.signal?.aborted).toBe(true);
  h.requests[0]!.resolve(answer("stale"));
  expect(published).toBe(false);
  h.requests[1]!.resolve(answer("current"));
  const fork = await pending;
  expect(fork.snapshot.conversation.log[0]?.messages.map(message => message.text)).toEqual(["first", "replacement", "current"]);
  expect(fork.snapshot.conversation.turn.status).toBe("idle");
  expect(fork.snapshot.children).toEqual([]);
});

test("fork and compaction wait through the complete tool/model loop without replaying tools", async () => {
  const tools: Array<ReturnType<typeof deferred<string>>> = [];
  const h = harness({ tools: new Map([["lookup", defineTool({ input: z.object({}), run: () => {
    const call = deferred<string>(); tools.push(call); return call.promise;
  } })]]) });
  await h.runtime.fire({ type: "user", text: "lookup" });
  await until(() => h.requests.length === 1);
  h.requests[0]!.resolve(toolCalls("a", "b"));
  await until(() => tools.length === 2);
  const sourceId = h.runtime.snapshot.conversation.sessionId;
  let forks = 0;
  const normal = h.runtime.fork().then(value => { forks++; return value; });
  const compacted = h.runtime.compact([{ role: "user", text: "Condensed context" }]).then(value => { forks++; return value; });
  await until(() => h.runtime.snapshot.conversation.pending.length === 2);
  tools[0]!.resolve("one");
  await until(() => h.runtime.snapshot.children.filter(child => child.ref.kind === "tool").length === 1);
  expect(forks).toBe(0);
  tools[1]!.resolve("two");
  await until(() => h.requests.length === 2);
  expect(forks).toBe(0);
  h.requests[1]!.resolve(answer("finished"));
  const [fork, compact] = await Promise.all([normal, compacted]);
  expect(fork.snapshot.conversation.log[0]?.messages.map(message => message.text)).toEqual(["lookup", "searching", "one", "two", "finished"]);
  expect(compact.snapshot.conversation.log).toEqual([]);
  expect(compact.snapshot.conversation.context).toMatchObject([{ role: "user", text: "Condensed context" }]);
  expect(compact.snapshot.conversation.origin).toMatchObject({ kind: "compaction", parent: sourceId });
  expect(compact.snapshot.conversation.sessionId).not.toBe(fork.snapshot.conversation.sessionId);
  expect(h.runtime.snapshot.conversation.log).toHaveLength(1);
  expect(tools).toHaveLength(2);
  await compact.fire({ type: "user", text: "continue" });
  await until(() => h.requests.length === 3);
  expect(h.requests[2]!.request.messages.map(message => message.content)).toEqual(["Condensed context", "continue"]);
  h.requests[2]!.resolve(answer("done"));
  await until(() => compact.snapshot.conversation.log.length === 1);
});

test("compaction replaces earlier context and history without mutating any ancestor", async () => {
  const h = harness();
  await finish(h);
  const first = await h.runtime.compact([{ role: "user", text: "old summary" }]);
  const replacement = [{ role: "user", text: "new summary" }];
  const compacting = first.compact(replacement);
  replacement[0]!.text = "mutated by caller";
  const second = await compacting;
  const clone = await second.fork();
  expect(second.snapshot.conversation.context).toMatchObject([{ text: "new summary" }]);
  expect(Object.isFrozen(second.snapshot.conversation.context[0])).toBe(true);
  expect(first.snapshot.conversation.context).toMatchObject([{ text: "old summary" }]);
  expect(h.runtime.snapshot.conversation.log).toHaveLength(1);
  expect(clone.snapshot.conversation.context).toEqual(second.snapshot.conversation.context);
  await clone.fire({ type: "user", text: "next" });
  await until(() => h.requests.length === 2);
  expect(h.requests[1]!.request.messages.map(message => message.content)).toEqual(["new summary", "next"]);
  h.requests[1]!.resolve(answer("done"));
  await until(() => clone.snapshot.conversation.log.length === 1);
});

test("invalid compaction is rejected atomically without changing source state or starting I/O", async () => {
  const h = harness();
  await finish(h);
  const before = h.runtime.snapshot.conversation;
  for (const context of [null, [{ role: "user", text: 42 }], [{ role: "tool", callId: "a", text: "orphan" }],
    [{ role: "assistant", text: "incomplete", calls: [{ id: "a", name: "lookup", args: {} }] }],
  ]) {
    await expect(h.runtime.compact(context)).rejects.toThrow();
    expect(h.runtime.snapshot.conversation).toBe(before);
    expect(h.runtime.snapshot.children).toHaveLength(0);
    expect(h.requests).toHaveLength(1);
  }
  const fork = await h.runtime.fork();
  expect(fork.snapshot.conversation.log).toEqual(before.log);
});

test("aborting a tool batch releases pending forks with partial history and isolates late outcomes", async () => {
  const calls: Array<ReturnType<typeof deferred<string>>> = [];
  const h = harness({ tools: new Map([["lookup", defineTool({ input: z.object({}), run: () => {
    const result = deferred<string>(); calls.push(result); return result.promise;
  } })]]) });
  await h.runtime.fire({ type: "user", text: "lookup" });
  await until(() => h.requests.length === 1);
  h.requests[0]!.resolve(toolCalls("a", "b"));
  await until(() => calls.length === 2);
  calls[0]!.resolve("found");
  await until(() => h.runtime.snapshot.children.filter(child => child.ref.kind === "tool").length === 1);
  const pending = h.runtime.fork();
  await h.runtime.fire({ type: "abort" });
  const fork = await pending;
  expect(fork.snapshot.conversation.log[0]?.outcome.kind).toBe("aborted");
  expect(fork.snapshot.conversation.log[0]?.messages.at(-1)?.text).toBe("found");
  calls[1]!.resolve("late");
  await fork.fire({ type: "user", text: "continue" });
  await until(() => h.requests.length === 2);
  expect(h.requests[1]!.request.messages.some(message => message.content === "late")).toBe(false);
  h.requests[1]!.resolve(answer("done"));
  await until(() => fork.snapshot.conversation.log.length === 2);
  expect(h.runtime.snapshot.conversation.log).toHaveLength(1);
});

test("handoff and exhausted turns publish forks with the final agent and fresh allowance", async () => {
  const h = harness({ steps: 1 });
  await h.runtime.fire({ type: "user", text: "handoff" });
  await until(() => h.requests.length === 1);
  const pending = h.runtime.fork();
  h.requests[0]!.resolve({ kind: "handoff", text: "review", agent: "reviewer" });
  const fork = await pending;
  expect(fork.snapshot.conversation.log[0]?.outcome.kind).toBe("exhausted");
  expect(fork.snapshot.conversation.turn).toMatchObject({ status: "idle", agent: "reviewer", steps: 1 });
  await fork.fire({ type: "user", text: "continue" });
  await until(() => h.requests.length === 2);
  expect(h.requests[1]!.request.model).toBe("review");
  h.requests[1]!.resolve(answer("done"));
  await until(() => fork.snapshot.conversation.log.length === 2);
});

test("fork captures its mailbox boundary even if source input is already queued next", async () => {
  const h = harness();
  await finish(h);
  const pending = h.runtime.fork();
  const next = h.runtime.fire({ type: "user", text: "source only" });
  const fork = await pending;
  await next;
  expect(fork.snapshot.conversation.turn.status).toBe("idle");
  expect(fork.snapshot.conversation.log).toHaveLength(1);
  expect(fork.snapshot.children).toHaveLength(0);
  expect(h.runtime.snapshot.conversation.turn.status).not.toBe("idle");
  await until(() => h.requests.length === 2);
  h.requests[1]!.resolve(answer("source answer"));
  await until(() => h.runtime.snapshot.conversation.log.length === 2);
  expect(fork.snapshot.conversation.log).toHaveLength(1);
});

test("failed turn outcomes release pending forks and later source work stays independent", async () => {
  const h = harness();
  await h.runtime.fire({ type: "user", text: "work" });
  await until(() => h.requests.length === 1);
  const pending = h.runtime.fork();
  h.requests[0]!.reject(new Error("offline"));
  const fork = await pending;
  expect(fork.snapshot.conversation.log[0]?.outcome).toEqual({ kind: "failed", error: { message: "offline" } });
  expect(fork.snapshot.children).toEqual([]);
  await fork.fire({ type: "user", text: "retry here" });
  await until(() => h.requests.length === 2);
  h.requests[1]!.resolve(answer("recovered"));
  await until(() => fork.snapshot.conversation.log.length === 2);
  expect(h.runtime.snapshot.conversation.log).toHaveLength(1);
});

test("forks inherit validated configuration rather than mutated caller registries", async () => {
  const agents = new Map([["writer", { model: "original", tools: ["lookup"] }]]);
  const tools = new Map([["lookup", defineTool({ input: z.object({}), run: () => "original result" })]]);
  const h = harness({ agents, tools });
  agents.get("writer")!.model = "changed";
  agents.clear();
  tools.clear();
  const fork = await h.runtime.fork();
  await fork.fire({ type: "user", text: "lookup" });
  await until(() => h.requests.length === 1);
  expect(h.requests[0]!.request.model).toBe("original");
  h.requests[0]!.resolve(toolCalls("a"));
  await until(() => h.requests.length === 2);
  expect(h.requests[1]!.request.messages.at(-1)?.content).toBe("original result");
  h.requests[1]!.resolve(answer("done"));
  await until(() => fork.snapshot.conversation.log.length === 1);
});
