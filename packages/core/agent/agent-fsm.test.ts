import { expect, test } from "bun:test";
import { createAgentMachine, type AgentEvent } from "./agent-fsm.ts";
import { actions, context } from "./test-support.ts";

const fire = (machine: ReturnType<typeof createAgentMachine>, event: AgentEvent) => machine.fire(event.type, event);

test("barge-in reenters thinking and cancels exactly once", async () => {
  let started = 0, cancelled = 0;
  const machine = createAgentMachine(context(), actions({
    startCompletion: ctx => { started++; return ctx; },
    cancel: ctx => { cancelled++; return ctx; },
  }));
  await fire(machine, { type: "user", text: "hello" });
  await fire(machine, { type: "user", text: "actually" });
  expect(started).toBe(2);
  expect(cancelled).toBe(1);
  expect(machine.snapshot.ctx.messages.map(message => message.text)).toEqual(["hello", "actually"]);
});

test("intermediate tool results do not rerun entry and the final result resumes thinking", async () => {
  let started = 0, batches = 0;
  const machine = createAgentMachine(context(), actions({
    startCompletion: ctx => { started++; return ctx; },
    runTools: ctx => { batches++; return ctx; },
  }));
  await fire(machine, { type: "user", text: "hello" });
  await fire(machine, { type: "model_done", text: "searching", toolCalls: [
    { id: "1", name: "search", args: {} }, { id: "2", name: "search", args: {} },
  ] });
  await fire(machine, { type: "tool_done", id: "2", result: "two" });
  await expect(fire(machine, { type: "tool_done", id: "2", result: "duplicate" })).rejects.toThrow("No legal");
  await expect(fire(machine, { type: "tool_done", id: "unknown", result: "bad" })).rejects.toThrow("No legal");
  expect(batches).toBe(1);
  expect(started).toBe(1);
  await fire(machine, { type: "tool_done", id: "1", result: "one" });
  expect(started).toBe(2);
  expect(machine.snapshot.ctx.pendingTools).toEqual([]);
  expect(machine.snapshot.ctx.messages.at(-1)).toEqual({ role: "tool", text: "one", toolCallId: "1" });
});

test("handoff changes the agent and starts its completion immediately", async () => {
  const agents: string[] = [];
  const machine = createAgentMachine(context(), actions({ startCompletion: ctx => { agents.push(ctx.agent); return ctx; } }));
  await fire(machine, { type: "user", text: "hello" });
  await fire(machine, { type: "model_done", text: "review this", handoff: "reviewer" });
  expect(machine.snapshot.state).toBe("awaiting_model");
  expect(agents).toEqual(["writer", "reviewer"]);
  await fire(machine, { type: "model_done", text: "approved" });
  expect(machine.snapshot.ctx.completion).toBe("completed");
  await expect(fire(machine, { type: "user", text: "too late" })).rejects.toThrow("final state");
});

test("unknown handoffs and tools have no permit", async () => {
  const machine = createAgentMachine(context(), actions());
  await fire(machine, { type: "user", text: "hello" });
  await expect(fire(machine, { type: "model_done", text: "", handoff: "unknown" })).rejects.toThrow("No legal");
  await expect(fire(machine, { type: "model_done", text: "", toolCalls: [{ id: "1", name: "unknown", args: {} }] })).rejects.toThrow("No legal");
  expect(machine.snapshot.state).toBe("awaiting_model");
});

test("abort records its reason and cancels work once", async () => {
  let cancellations = 0;
  const machine = createAgentMachine(context(), actions({ cancel: ctx => { cancellations++; return ctx; } }));
  await fire(machine, { type: "user", text: "hello" });
  await fire(machine, { type: "abort" });
  expect(machine.snapshot.ctx.completion).toBe("aborted");
  expect(cancellations).toBe(1);
});
