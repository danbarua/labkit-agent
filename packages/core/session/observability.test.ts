import { getLogger } from "@logtape/logtape";
import { expect, spyOn, test } from "@logtape/testing-bun/autoload";
import { z } from "zod";

import { defineTool } from "../host/ports.ts";
import { createSession, restoreSession } from "./session-runtime.ts";
import {
  deferred,
  deterministicIds,
  lostAcknowledgement,
  testOptions,
  until,
} from "./test-support.ts";
import { createMemoryPersistence } from "./testing/memory-persistence.ts";

function observeLogs() {
  const records: { event: string; level: string; fields: Record<string, unknown> }[] = [];
  const spies = ["host", "session", "persistence", "provider"].flatMap((category) => {
    const logger = getLogger(["labkit", category]);
    const original = logger.emit.bind(logger);
    return [
      spyOn(logger, "emit").mockImplementation((record) => {
        records.push({
          event: String(record.rawMessage),
          level: record.level,
          fields: record.properties,
        });
        original(record);
      }),
    ];
  });
  return {
    records,
    close: () =>
      spies.forEach((spy) => {
        spy.mockRestore();
      }),
  };
}

test("permission logs identify the file, wait, refusal and committed turn failure", async () => {
  const capture = observeLogs();
  const gate = deferred<unknown>();
  let ran = false;
  const session = await createSession({
    persistence: createMemoryPersistence(),
    configuration: {
      agent: "a",
      agents: new Map([["a", { model: "m", tools: ["read"] }]]),
      steps: 3,
      policy: { permissions: "ask" },
    },
    bindings: {
      id: deterministicIds(),
      complete: () => ({
        kind: "tools",
        text: "Read",
        calls: [{ id: "read-1", name: "read", args: { path: "/workspace/README.md" } }],
      }),
      requestPermission: () => gate.promise,
      tools: new Map([
        [
          "read",
          defineTool({
            input: z.object({ path: z.string() }),
            locations: ({ path }) => [{ path }],
            run: () => {
              ran = true;
              return "contents";
            },
          }),
        ],
      ]),
    },
  });
  try {
    const turn = session.input("Review");
    await until(() => capture.records.some((r) => r.event === "permission.waiting"));
    const waiting = capture.records.find((r) => r.event === "permission.waiting")!.fields;
    expect(waiting).toMatchObject({
      toolName: "read",
      locations: [{ path: "/workspace/README.md" }],
      callId: "read-1",
    });
    for (const key of ["sessionId", "turnId", "requestId", "toolCallId", "batchId"])
      expect(waiting[key]).toBeString();
    expect(ran).toBe(false);
    gate.resolve({ outcome: { outcome: "selected", optionId: "reject-once" } });
    await turn.settled;
    expect(capture.records.find((r) => r.event === "permission.decided")?.fields).toMatchObject({
      requestId: waiting.requestId,
      decision: "reject_once",
      durationMs: expect.any(Number),
    });
    expect(capture.records.find((r) => r.event === "permission.decided")?.level).toBe("info");
    const refusal = capture.records.find((r) => r.event === "permission.refused");
    expect(refusal?.level).toBe("warning");
    expect(refusal?.fields).toMatchObject({
      sessionId: waiting.sessionId,
      turnId: waiting.turnId,
      childId: waiting.childId,
      batchId: waiting.batchId,
      toolCallId: waiting.toolCallId,
      requestId: waiting.requestId,
      operation: "tool_execution",
      outcome: "blocked",
      reasonCode: "permission_refused",
      reason: expect.stringContaining("User refused permission"),
      toolName: "read",
      rawInput: { path: "/workspace/README.md" },
      locations: [{ path: "/workspace/README.md" }],
      blockedCallCount: 1,
    });
    const terminal = capture.records.find((r) => r.event === "turn.settled");
    expect(terminal?.level).toBe("warning");
    expect(terminal?.fields).toMatchObject({
      operation: "agent_turn",
      agentId: "a",
      message: "Agent turn failed: Tool permission rejected",
      reason: "Tool permission rejected",
      trigger: "permission_settled",
      childOperation: "permission",
      childId: waiting.childId,
      outcome: "failed",
      appendId: expect.any(String),
      error: { message: expect.any(String) },
    });
    expect(ran).toBe(false);
  } finally {
    await session.close();
    capture.close();
  }
});

test("storage diagnostics retain uncertainty and recovery evidence; exhausted turns explain the limit", async () => {
  const capture = observeLogs();
  const options = testOptions({
    steps: 1,
    persistence: lostAcknowledgement(createMemoryPersistence(), (records) =>
      records.some((raw) => JSON.parse(raw).body.kind === "event"),
    ),
    complete: () => ({
      kind: "tools",
      text: "Read",
      calls: [{ id: "c", name: "echo", args: { text: "ok" } }],
    }),
  });
  const session = await createSession(options);
  try {
    await session.input("work").settled;
    expect(
      capture.records.find(
        (r) => r.event === "append.settled" && r.fields.outcome === "indeterminate",
      )?.fields,
    ).toMatchObject({
      reason: "Receipt lost",
      appendId: expect.any(String),
      durationMs: expect.any(Number),
    });
    expect(capture.records.some((r) => r.event === "append.reconciling")).toBe(true);
    expect(capture.records.find((r) => r.event === "turn.settled")?.fields).toMatchObject({
      outcome: "exhausted",
      stepLimit: 1,
      reason: expect.stringContaining("allowance exhausted"),
    });
    expect(capture.records.find((r) => r.event === "turn.settled")?.level).toBe("info");
    expect(capture.records.some((r) => r.event === "tool.awaiting_release")).toBe(true);
    expect(capture.records.some((r) => r.event === "tool.released")).toBe(true);
    await expect(restoreSession(options, "00000000-0000-4000-8000-000000000099")).rejects.toThrow();
    expect(capture.records.find((r) => r.event === "session.restore_failed")?.fields).toMatchObject(
      {
        sessionId: "00000000-0000-4000-8000-000000000099",
        error: { message: "Session not found" },
      },
    );
  } finally {
    await session.close();
    capture.close();
  }
});

test("cancellation identifies the active completion and preserves its terminal outcome", async () => {
  const capture = observeLogs();
  const pending = deferred<unknown>();
  let signal: AbortSignal | undefined;
  const session = await createSession({
    persistence: createMemoryPersistence(),
    configuration: { agent: "a", agents: new Map([["a", { model: "m" }]]), steps: 3 },
    bindings: {
      id: deterministicIds(),
      complete: (_request, cancellation) => {
        signal = cancellation;
        cancellation.addEventListener(
          "abort",
          () => pending.reject(new DOMException("Completion aborted by user", "AbortError")),
          { once: true },
        );
        return pending.promise;
      },
    },
  });
  try {
    const turn = session.input("wait");
    await until(() => signal !== undefined);
    await session.fire({ type: "abort" });
    await turn.settled;
    const cancellation = capture.records.find(
      (r) => r.event === "child.cancellation_requested",
    )!.fields;
    const cancelledChildId = cancellation.childId;
    expect(cancellation).toMatchObject({
      sessionId: expect.any(String),
      childId: expect.any(String),
      operation: "completion",
    });
    expect(
      capture.records.some(
        (r) =>
          r.event === "child.settled" &&
          r.fields.childId === cancelledChildId &&
          r.fields.outcome === "cancelled",
      ),
    ).toBe(true);
    expect(capture.records.find((r) => r.event === "turn.settled")?.fields.outcome).toBe("aborted");
    expect(capture.records.find((r) => r.event === "turn.settled")?.level).toBe("info");
    expect(signal?.aborted).toBe(true);
    await until(() => capture.records.some((r) => r.event === "child.cancelled"));
    expect(
      capture.records.some(
        (r) => r.event === "child.failed" && r.fields.childId === cancelledChildId,
      ),
    ).toBe(false);
    expect(capture.records.find((r) => r.event === "child.cancelled")?.fields).toMatchObject({
      phase: "run",
      error: { name: "AbortError", message: "Completion aborted by user" },
    });
  } finally {
    await session.close();
    pending.resolve({ kind: "answer", text: "late" });
    capture.close();
  }
});

test("restore registry drift identifies changed fields and missing tools without logging prompt bodies", async () => {
  const capture = observeLogs();
  const options = testOptions();
  const session = await createSession(options);
  await session.close();
  try {
    const incompatible = testOptions({
      persistence: options.persistence,
      agents: new Map([
        ["a", { model: "replacement", systemPrompt: "PRIVATE_REPLACEMENT_PROMPT", tools: [] }],
      ]),
      tools: new Map(),
    });
    await expect(
      restoreSession(incompatible, session.snapshot.durable.conversation.sessionId),
    ).rejects.toThrow(
      "changed agents.a.model; changed agents.a.systemPrompt; changed agents.a.tools; missing agents.b; missing tools.echo",
    );
    const event = capture.records.find((record) => record.event === "session.restore_failed")!;
    expect(event.fields.stage).toBe("validate_registry");
    expect(event.fields.error).toMatchObject({
      differences: [
        "changed agents.a.model",
        "changed agents.a.systemPrompt",
        "changed agents.a.tools",
        "missing agents.b",
        "missing tools.echo",
      ],
    });
    expect(JSON.stringify(capture.records)).not.toContain("PRIVATE_REPLACEMENT_PROMPT");
    expect(JSON.stringify(capture.records)).not.toContain("Agent A");
  } finally {
    capture.close();
  }
});

test("session logs expose full system instructions actually supplied before and after reconfiguration", async () => {
  const { journalMarkdown } = await import("./session-log.ts");
  const capture = observeLogs();
  const prompt =
    "Review experimental claims against measured evidence.\nReport uncertainty and cite the source files.";
  const options = testOptions({
    agents: new Map([["reviewer", { model: "review-model", systemPrompt: prompt }]]),
    agent: "reviewer",
    systemInputs: ["Do not modify experiment data."],
  });
  const session = await createSession(options);
  try {
    await session.input("Review the measurements").settled;
    expect(await session.updateSystem(["Limit this review to calibration errors."])).toMatchObject({
      kind: "accepted",
    });
    await session.input("Review the calibration").settled;
    const instructions = capture.records.filter(
      (record) => record.event === "completion.system_prompt",
    );
    expect(instructions).toHaveLength(2);
    expect(instructions[0]).toMatchObject({
      level: "info",
      fields: {
        sessionId: session.snapshot.durable.conversation.sessionId,
        agentId: "reviewer",
        model: "review-model",
        systemMessages: [
          { role: "system", content: prompt },
          { role: "system", content: "Do not modify experiment data." },
        ],
      },
    });
    expect(instructions[1]!.fields.systemMessages).toEqual([
      { role: "system", content: prompt },
      { role: "system", content: "Limit this review to calibration errors." },
    ]);
    expect(instructions[0]!.fields.turnId).toBeDefined();
    expect(instructions[0]!.fields.childId).toBeDefined();
    const restored = await restoreSession(options, session.snapshot.durable.conversation.sessionId);
    try {
      const text = journalMarkdown(restored.snapshot.durable);
      expect(text).toContain(
        prompt
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n"),
      );
      expect(text).toContain("Do not modify experiment data.");
      expect(text).toContain("Limit this review to calibration errors.");
      expect(
        capture.records.filter((record) => record.event === "completion.system_prompt"),
      ).toHaveLength(2);
      expect(
        capture.records.filter((record) => ["warning", "error"].includes(record.level)),
      ).toEqual([]);
    } finally {
      await restored.close();
    }
  } finally {
    await session.close();
    capture.close();
  }
});
