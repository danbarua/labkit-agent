import { expect, test } from "@logtape/testing-bun/autoload";

import { completeResults, toolBatchMachine, type BatchState } from "./tool-batch.ts";
import { ref, ToolCallIdSchema, ToolCallsSchema } from "./types.ts";

const calls = ToolCallsSchema.parse([
  { id: "a", name: "search", args: {} },
  { id: "b", name: "search", args: {} },
]);
const decide = toolBatchMachine(ref("batch", "turn/1/batch"));
const result = (id: string) => ({
  type: "tool_settled" as const,
  callId: ToolCallIdSchema.parse(id),
  result: { kind: "succeeded" as const, value: id },
});
test("only outstanding calls advance the batch; the last result produces a complete outcome", () => {
  const started = decide({ status: "ready", calls }, { type: "start" });
  expect(started.commands.map((command) => command.type)).toEqual(["spawn_tool", "spawn_tool"]);
  const first = decide(started.state, result("b"));
  expect(first.state).toMatchObject({
    status: "running",
    pending: [{ id: "a" }],
    results: [{ callId: "b", text: "b" }],
  });
  expect(first.commands).toEqual([]);
  for (const id of ["b", "unknown"])
    expect(decide(first.state, result(id)).state).toBe(first.state);
  const last = decide(first.state, result("a"));
  expect(last.state).toMatchObject({
    status: "settled",
    outcome: {
      kind: "succeeded",
      results: [
        { callId: "b", text: "b" },
        { callId: "a", text: "a" },
      ],
    },
  });
  expect(last.commands.map((command) => command.type)).toEqual(["notify"]);
  expect(decide(last.state, result("a")).state).toBe(last.state);
});
test("cancellation preserves settled results and cancels only outstanding children", () => {
  const running = decide({ status: "ready", calls }, { type: "start" }).state;
  const partial = decide(running, result("b")).state;
  const cancelled = decide(partial, { type: "cancel" });
  expect(cancelled.state).toMatchObject({
    status: "settled",
    outcome: { kind: "cancelled", results: [{ callId: "b", text: "b" }] },
  });
  expect(cancelled.commands).toEqual([
    { type: "cancel_tool", child: ref("tool", "turn/1/batch/a") },
    {
      type: "notify",
      outcome: { kind: "cancelled", results: [{ callId: ToolCallIdSchema.parse("b"), text: "b" }] },
    },
  ]);
});
test("complete-result construction rejects missing, duplicate and unrelated IDs", () => {
  for (const ids of [[], ["a"], ["a", "a"], ["a", "unknown"], ["a", "b", "c"]]) {
    expect(() =>
      completeResults(
        calls,
        ids.map((id) => ({ callId: ToolCallIdSchema.parse(id), text: "result" })),
      ),
    ).toThrow();
  }
});
