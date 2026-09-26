import { expect, test } from "@logtape/testing-bun/autoload";
import { z } from "zod";

import { PreparedModelSchema } from "../agent/agent.ts";
import { until } from "../agent/test-support.ts";
import { ActorIdSchema, AgentIdSchema, CompletionSchema, ref, StepsSchema } from "../agent/types.ts";
import { createHost, type HostToolOutcome } from "../host/host.ts";
import { defineTool } from "../host/ports.ts";
import type { EffectEvent } from "./index.ts";

test("a custom subscriber receives provider usage and tool events with correlation IDs", async () => {
  const events: EffectEvent[] = [];
  const outcomes: HostToolOutcome[] = [];
  const host = createHost(
    {
      sessionId: "session-effects-test",
      agents: new Map([["a", { model: "m", tools: ["echo"] }]]),
      tools: new Map([
        ["echo", defineTool({ input: z.object({ text: z.string() }), run: ({ text }) => text })],
      ]),
      complete: () => ({
        completion: CompletionSchema.parse({ kind: "answer", text: "done" }),
        usage: { status: "reported", inputTokens: 12, outputTokens: 3, native: {} },
      }),
      effects: (event) => events.push(event),
    },
    {
      turn: () => {},
      tool: (outcome) => outcomes.push(outcome),
    },
  );

  const turn = {
    id: ActorIdSchema.parse("turn"),
    agent: AgentIdSchema.parse("a"),
    generation: 1,
    steps: StepsSchema.parse(1),
    messages: [],
    view: { kind: "history" as const },
  };
  host.dispatch(
    {
      type: "turn",
      turnId: turn.id,
      command: {
        type: "complete",
        child: ref("completion", "step"),
        turn,
        request: PreparedModelSchema.parse({ model: "m", messages: [{ role: "user", content: "hi" }] }),
      },
    },
    { projectPrompt: () => [] },
  );
  await until(() => events.some((event) => event.type === "completion.usage.received"));

  const usageEvent = events.find((event) => event.type === "completion.usage.received");
  expect(usageEvent).toMatchObject({
    category: "provider",
    level: "info",
    fields: {
      sessionId: "session-effects-test",
      turnId: turn.id,
      childId: "step",
      usage: { status: "reported", inputTokens: 12, outputTokens: 3 },
    },
  });

  const toolCompletion = CompletionSchema.parse({
    kind: "tools",
    text: "work",
    calls: [{ id: "c", name: "echo", args: { text: "ok" } }],
  });
  if (toolCompletion.kind !== "tools") throw new Error("Expected tools");
  host.dispatch(
    {
      type: "turn",
      turnId: turn.id,
      command: { type: "run_tools", child: ref("batch", "batch"), completion: toolCompletion },
    },
    { projectPrompt: () => [] },
  );
  await until(() => outcomes.length === 1);
  host.releaseTool(outcomes[0]!);

  const toolAdmitted = events.find((event) => event.type === "tool.admitted");
  expect(toolAdmitted).toMatchObject({
    category: "host",
    level: "debug",
    fields: {
      sessionId: "session-effects-test",
      turnId: turn.id,
      batchId: "batch",
      callId: "c",
      toolName: "echo",
    },
  });
  host.close();
});
