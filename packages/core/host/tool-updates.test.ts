import { expect, test } from "@logtape/testing-bun/autoload";
import { z } from "zod";

import { deferred, until } from "../agent/test-support.ts";
import { ActorIdSchema, CompletionSchema, ref } from "../agent/types.ts";
import {
  createHost,
  type HostToolNotification,
  type HostToolOutcome,
  type ToolUpdateSink,
} from "./host.ts";
import { defineTool, type Tool } from "./ports.ts";

function setup(tool: Tool, sink?: ToolUpdateSink) {
  const updates: HostToolNotification[] = [];
  const outcomes: HostToolOutcome[] = [];
  const turns: unknown[] = [];
  const host = createHost(
    {
      sessionId: "session",
      agents: new Map([["a", { model: "m", tools: ["work"] }]]),
      tools: new Map([["work", tool]]),
      complete: () => null,
    },
    {
      turn: (_, event) => {
        turns.push(event);
      },
      tool: (outcome) => {
        outcomes.push(outcome);
      },
      toolUpdate: (event) => {
        updates.push(event);
        return sink?.(event);
      },
    },
  );
  function start(args: unknown = { path: "/tmp/DESIGN.md" }, batch = "batch") {
    const completion = CompletionSchema.parse({
      kind: "tools",
      text: "",
      calls: [{ id: "call", name: "work", args }],
    });
    if (completion.kind !== "tools") throw new Error("Expected tools");
    host.dispatch(
      {
        type: "turn",
        turnId: ActorIdSchema.parse("turn"),
        command: { type: "run_tools", child: ref("batch", batch), completion },
      },
      { projectPrompt: () => [] },
    );
  }
  function cancel(batch = "batch") {
    host.dispatch(
      {
        type: "turn",
        turnId: ActorIdSchema.parse("turn"),
        command: { type: "cancel", child: ref("batch", batch) },
      },
      { projectPrompt: () => [] },
    );
  }
  return { host, updates, outcomes, turns, start, cancel };
}

const statuses = (updates: HostToolNotification[]) =>
  updates.flatMap((update) => (update.status ? [update.status] : []));

test("tool locations use parsed input and arrive before run; display completion cannot release a batch", async () => {
  const order: string[] = [];
  const tool = defineTool({
    input: z.object({
      path: z.string().transform((path) => `/tmp/${path}`),
      line: z.number().default(4),
    }),
    kind: "read",
    locations: (args) => {
      order.push("locations");
      const path = args.path;
      args.path = "changed only in metadata copy";
      return [{ path, line: args.line }];
    },
    run: (args, _signal, context) => {
      expect(context).toMatchObject({ toolCallId: updates[0]!.toolCallId });
      expect(Object.isFrozen(context)).toBe(true);
      order.push("run");
      expect(args).toEqual({ path: "/tmp/DESIGN.md", line: 4 });
      return { reviewed: true };
    },
  });
  const { host, updates, outcomes, turns, start } = setup(tool, (event) => {
    order.push(
      event.sessionUpdate === "tool_call_update" && event.locations
        ? "scope"
        : (event.status ?? "update"),
    );
    expect(Object.isFrozen(event)).toBe(true);
  });
  start({ path: "DESIGN.md" });
  await until(() => outcomes.length === 1);
  expect(order).toEqual(["pending", "locations", "scope", "in_progress", "run", "completed"]);
  expect(updates[0]).toMatchObject({
    sessionUpdate: "tool_call",
    sessionId: "session",
    turnId: "turn",
    batchId: "batch",
    callId: "call",
    title: "work",
    name: "work",
    kind: "read",
    status: "pending",
    rawInput: { path: "DESIGN.md" },
  });
  expect(updates[1]).toMatchObject({
    sessionUpdate: "tool_call_update",
    locations: [{ path: "/tmp/DESIGN.md", line: 4 }],
  });
  expect(updates[2]).not.toHaveProperty("name");
  expect(updates.at(-1)).toMatchObject({ status: "completed", rawOutput: '{"reviewed":true}' });
  expect(new Set(updates.map((update) => update.toolCallId)).size).toBe(1);
  expect(turns).toEqual([]);
  host.releaseTool(outcomes[0]!);
  await until(() => turns.length === 1);
  expect(updates).toHaveLength(4);
  host.close();
});

test("input, execution, and output failures report a single failed update", async () => {
  for (const mode of ["input", "run", "output"] as const) {
    let executions = 0;
    const { host, start, outcomes, updates } = setup(
      defineTool({
        input: z.object({ path: z.string() }),
        run: () => {
          executions++;
          if (mode === "run") throw new Error("run failed");
          return undefined;
        },
      }),
    );
    start(mode === "input" ? {} : { path: "anything" });
    await until(() => outcomes.length === 1);
    expect(statuses(updates)).toEqual(
      mode === "input" ? ["pending", "failed"] : ["pending", "in_progress", "failed"],
    );
    expect(executions).toBe(mode === "input" ? 0 : 1);
    expect(updates[0]).toMatchObject({ kind: "other" });
    expect(outcomes[0]?.result.kind).toBe("failed");
    host.close();
  }
});

test("cancellation during validation or execution reports failed once and ignores late output/locations", async () => {
  for (const phase of ["validation", "execution"] as const) {
    const gate = deferred<void>();
    let entered = false;
    let runs = 0;
    const tool = defineTool({
      input: z.object({ path: z.string() }).superRefine(async () => {
        if (phase === "validation") {
          entered = true;
          await gate.promise;
        }
      }),
      locations: ({ path }) => [{ path }],
      run: async () => {
        runs++;
        entered = true;
        if (phase === "execution") await gate.promise;
        return "late";
      },
    });
    const { host, start, cancel, updates, outcomes } = setup(tool);
    start();
    await until(() => entered);
    cancel();
    await until(() => outcomes.length === 1);
    expect(outcomes[0]?.result.kind).toBe("cancelled");
    expect(statuses(updates)).toEqual(
      phase === "validation" ? ["pending", "failed"] : ["pending", "in_progress", "failed"],
    );
    const count = updates.length;
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(updates).toHaveLength(count);
    expect(runs).toBe(phase === "validation" ? 0 : 1);
    host.close();
  }
});

test("invalid display metadata and throwing/rejecting/never-resolving sinks cannot decide tool results", async () => {
  for (const behavior of ["throw", "reject", "pending"] as const) {
    const { host, start, outcomes, updates } = setup(
      defineTool({
        input: z.object({ path: z.string() }),
        locations: () => [{ path: "relative" }],
        run: () => "done",
      }),
      () => {
        if (behavior === "throw") throw new Error("observer failed");
        if (behavior === "reject") return Promise.reject(new Error("observer rejected"));
        return new Promise(() => {});
      },
    );
    start();
    await until(() => outcomes.length === 1);
    expect(outcomes[0]?.result).toEqual({ kind: "succeeded", value: "done" });
    expect(statuses(updates)).toEqual(["pending", "in_progress", "completed"]);
    host.close();
  }
});

test("same provider call id in separate batches has distinct notification identity", async () => {
  const { host, start, updates, outcomes } = setup(
    defineTool({ input: z.object({}), run: () => "ok" }),
  );
  start({}, "batch1");
  start({}, "batch2");
  await until(() => outcomes.length === 2);
  const starts = updates.filter((update) => update.sessionUpdate === "tool_call");
  expect(starts.map((update) => String(update.callId))).toEqual(["call", "call"]);
  expect(new Set(starts.map((update) => update.toolCallId)).size).toBe(2);
  for (const start of starts)
    expect(statuses(updates.filter((event) => event.toolCallId === start.toolCallId))).toEqual([
      "pending",
      "in_progress",
      "completed",
    ]);
  host.close();
});
