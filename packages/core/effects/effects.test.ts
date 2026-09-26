import { expect, test } from "@logtape/testing-bun/autoload";
import { z } from "zod";

import { PreparedModelSchema } from "../agent/agent.ts";
import { until } from "../agent/test-support.ts";
import {
  ActorIdSchema,
  AgentIdSchema,
  CompletionSchema,
  ref,
  StepsSchema,
  type ActorId,
} from "../agent/types.ts";
import { createHost, type HostToolOutcome } from "../host/host.ts";
import { defineTool } from "../host/ports.ts";
import { fanoutEffects, resolveDiagnostic, type EffectEvent } from "./index.ts";

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
        request: PreparedModelSchema.parse({
          model: "m",
          messages: [{ role: "user", content: "hi" }],
        }),
      },
    },
    { projectPrompt: () => [] },
  );
  await until(() => events.some((event) => event.type === "completion.usage.received"));

  // Narrowing on `type` gives typed usage fields directly, without a cast.
  const usageEvent = events.find((event) => event.type === "completion.usage.received");
  if (usageEvent?.type !== "completion.usage.received") throw new Error("Expected usage event");
  expect(usageEvent.sessionId).toBe("session-effects-test");
  expect(usageEvent.turnId).toBe(turn.id);
  expect(usageEvent.childId).toBe("step" as ActorId);
  expect(usageEvent.usage.status).toBe("reported");
  if (usageEvent.usage.status !== "reported") throw new Error("Expected reported usage");
  expect(usageEvent.usage.inputTokens).toBe(12);
  expect(usageEvent.usage.outputTokens).toBe(3);

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
  if (toolAdmitted?.type !== "tool.admitted") throw new Error("Expected tool.admitted event");
  expect(toolAdmitted.sessionId).toBe("session-effects-test");
  expect(toolAdmitted.turnId).toBe(turn.id);
  expect(toolAdmitted.batchId).toBe("batch" as ActorId);
  expect(toolAdmitted.callId).toBe("c");
  expect(toolAdmitted.toolName).toBe("echo");
  expect(toolAdmitted.permission).toBe("not_required");
  host.close();
});

test("resolveDiagnostic renders every known event type without throwing", () => {
  const id = ActorIdSchema.parse("op");
  const trace = { httpRequestId: "req", endpoint: "/x", method: "POST", streaming: false };
  const evidence = { ...trace, httpStatus: 200, providerRequestId: null, durationMs: 1 };
  const completionTrace = { httpRequestId: "req", stream: false, messageCount: 1, toolCount: 0 };
  const permissionContext = {
    turnId: id,
    batchId: id,
    callId: "c",
    toolCallId: "t",
    name: "echo",
    childId: id,
    requestId: "r",
    toolName: "echo",
  };
  // One minimal, valid instance of every EffectEvent member. Removing a case from the internal
  // table used by resolveDiagnostic is a compile error (the table type requires every key of
  // EffectEvent["type"]); this proves each case also runs without throwing.
  const samples: readonly EffectEvent[] = [
    { type: "child.started", childId: id, operation: "tool" },
    { type: "child.failed", childId: id, operation: "tool", phase: "run", error: {} },
    { type: "child.cancelled", childId: id, operation: "tool", phase: "run", error: {} },
    { type: "child.settled", childId: id, operation: "tool", outcome: "succeeded", durationMs: 1 },
    { type: "child.timed_out", reason: { message: "m", classification: "timeout" }, childId: id },
    { type: "child.cancellation_requested", childId: id, operation: "tool" },
    { type: "command.dispatched", turnId: id, childId: id, operation: "cancel" },
    {
      type: "permission.grants_cleared",
      reason: "r",
      policyVersion: 1,
      appendId: "a",
      toolNames: [],
    },
    { type: "tool.released", turnId: id, batchId: id, callId: "c" },
    { type: "host.closed", activeChildren: 0, pendingToolReceipts: 0, pendingGrants: 0 },
    {
      type: "completion.system_prompt",
      turnId: id,
      childId: id,
      agentId: AgentIdSchema.parse("a"),
      systemMessages: [],
    },
    {
      type: "completion.usage.received",
      turnId: id,
      childId: id,
      usage: { status: "reported", native: {} },
    },
    { type: "tool.locations_failed", toolName: "echo", error: {} },
    {
      type: "permission.reused",
      ...permissionContext,
      scope: "live-session-tool",
      source: "remembered",
      grantId: "g",
    },
    { type: "permission.waiting", ...permissionContext },
    { type: "permission.decided", ...permissionContext, decision: "allow_once", durationMs: 1 },
    {
      type: "permission.refused",
      ...permissionContext,
      toolKind: "other",
      rawInput: {},
      blockedCallCount: 1,
      durationMs: 1,
    },
    {
      type: "tool.input_rejected",
      turnId: id,
      toolName: "echo",
      callId: "c",
      error: { message: "m" },
    },
    { type: "permission.granted", turnId: id, childId: id, toolName: "echo", grantId: "g" },
    { type: "tool.admitted", toolName: "echo", kind: "other", permission: "approved" },
    { type: "tool.locations_resolved", toolName: "echo", locations: [] },
    { type: "tool.awaiting_release", toolName: "echo", outcome: "succeeded" },
    {
      type: "tool.status_changed",
      toolName: "echo",
      previousStatus: "pending",
      status: "completed",
      rawStatus: "succeeded",
    },
    { type: "provider.http.started", trace },
    { type: "provider.http.received", evidence },
    { type: "provider.http.rejected", evidence, errorBody: "bad" },
    { type: "provider.http.completed", evidence, durationMs: 1 },
    { type: "provider.http.cancelled", trace, phase: "fetch", durationMs: 1, error: {} },
    { type: "provider.http.failed", trace, phase: "fetch", durationMs: 1, error: {} },
    { type: "provider.stream.started", context: evidence },
    {
      type: "provider.stream.completed",
      context: evidence,
      bytes: 0,
      frames: 0,
      deltas: 0,
      usage: {},
      terminalEvidence: {},
      durationMs: 1,
    },
    {
      type: "provider.stream.cancelled",
      context: evidence,
      bytes: 0,
      frames: 0,
      deltas: 0,
      usage: {},
      terminalEvidence: {},
      bufferedCharacters: 0,
      durationMs: 1,
      error: {},
    },
    {
      type: "provider.stream.failed",
      context: evidence,
      bytes: 0,
      frames: 0,
      deltas: 0,
      usage: {},
      terminalEvidence: {},
      bufferedCharacters: 0,
      durationMs: 1,
      error: {},
    },
    { type: "provider.completion.started", trace: completionTrace },
    {
      type: "provider.completion.completed",
      trace: completionTrace,
      terminalEvidence: {},
      durationMs: 1,
      completionKind: "answer",
      continuation: false,
    },
    {
      type: "provider.completion.cancelled",
      trace: completionTrace,
      terminalEvidence: {},
      phase: "transport",
      durationMs: 1,
      error: {},
    },
    {
      type: "provider.completion.failed",
      trace: completionTrace,
      terminalEvidence: {},
      phase: "transport",
      durationMs: 1,
      error: {},
    },
    { type: "provider.usage.invalid", trace: completionTrace, terminalEvidence: {}, error: "bad" },
  ];
  for (const sample of samples) {
    const record = resolveDiagnostic(sample);
    expect(typeof record.category).toBe("string");
    expect(typeof record.level).toBe("string");
  }
});

test("an async throwing subscriber does not crash and does not block the other subscribers", async () => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  const received: EffectEvent[] = [];
  const emit = fanoutEffects(
    () => {
      throw new Error("sync subscriber failure");
    },
    async () => {
      throw new Error("async subscriber failure");
    },
    (event) => {
      received.push(event);
    },
  );
  try {
    emit({ type: "host.closed", activeChildren: 0, pendingToolReceipts: 0, pendingGrants: 0 });
    // The async subscriber's rejection is caught synchronously inside `emit` (containRejection
    // attaches `.catch()` before `emit` returns); flush a couple of microtask ticks so Bun's own
    // unhandled-rejection detection, which runs after the current microtask queue drains, would
    // have already reported it here if containment had failed.
    await Promise.resolve();
    await Promise.resolve();
    expect(received).toHaveLength(1);
    expect(rejections).toEqual([]);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});
