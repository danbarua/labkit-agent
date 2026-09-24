import { expect, test } from "bun:test";

import { planTool, type PlanEntries } from "./plan.ts";

const entries = [
  { content: "Read the design", priority: "high" as const, status: "pending" as const },
];

test("plan publication is display-only and cannot mutate results, fail, or block the tool", async () => {
  for (const publish of [
    () => {
      throw new Error("display failed");
    },
    () => Promise.reject(new Error("display failed")),
    () => new Promise<void>(() => {}),
    (value: PlanEntries) => {
      value[0]!.content = "mutated";
    },
  ]) {
    const tool = planTool(publish);
    expect(
      await tool.run(await tool.parseInput({ entries }), new AbortController().signal),
    ).toEqual({ entries });
  }
});

test("plans validate status and size; cancellation publishes nothing", async () => {
  let published = 0;
  const tool = planTool(() => {
    published++;
  });
  for (const bad of [
    [{ content: "Task", priority: "urgent", status: "pending" }],
    [{ content: "Task", priority: "high", status: "failed" }],
    Array.from({ length: 129 }, () => entries[0]),
    Array.from({ length: 32 }, () => ({ ...entries[0], content: "x".repeat(4096) })),
  ])
    await expect(tool.parseInput({ entries: bad })).rejects.toThrow();
  const controller = new AbortController();
  controller.abort();
  expect(() => tool.run({ entries }, controller.signal)).toThrow();
  expect(published).toBe(0);
});
