// These tests replace global routing, so they must not run inside a scoped log reporter.
import "@logtape/testing-bun/autoload";

import { afterEach, expect, test } from "bun:test";

import { getConfig } from "@logtape/logtape";

import { createSession, restoreSession } from "../session/session-runtime.ts";
import { lostAcknowledgement, scriptedCompletion, testOptions } from "../session/test-support.ts";
import { createMemoryPersistence } from "../session/testing/memory-persistence.ts";
import {
  configure,
  diagnostic,
  diagnosticContext,
  diagnosticError,
  redactDiagnostics,
  reset,
  type LogRecord,
  type Sink,
} from "./index.ts";

const testLoggingConfig = getConfig()!;
afterEach(async () => {
  await reset();
  await configure(testLoggingConfig);
});

async function capture(sink: Sink, level: "debug" | "warning" = "debug") {
  await configure({
    reset: true,
    sinks: { capture: sink },
    loggers: [
      { category: ["logtape", "meta"], lowestLevel: null },
      { category: ["labkit"], lowestLevel: level, sinks: ["capture"] },
    ],
  });
}

test("runtime reconfiguration changes levels and routes already-used loggers", async () => {
  const first: LogRecord[] = [];
  const second: LogRecord[] = [];
  await capture((record) => {
    first.push(record);
  }, "warning");
  diagnostic("host", "debug", "hidden");
  diagnostic("host", "warning", "visible");
  await configure({
    reset: true,
    sinks: {
      first: (record) => {
        first.push(record);
      },
      second: (record) => {
        second.push(record);
      },
    },
    loggers: [
      { category: ["logtape", "meta"], lowestLevel: null },
      { category: ["labkit"], lowestLevel: "warning", sinks: ["first"] },
      {
        category: ["labkit", "host"],
        lowestLevel: "debug",
        sinks: ["second"],
        parentSinks: "override",
      },
    ],
  });
  diagnostic("host", "debug", "now-visible");
  diagnostic("session", "warning", "session-warning");
  expect(first.map((record) => record.rawMessage)).toEqual(["visible", "session-warning"]);
  expect(second.map((record) => record.rawMessage)).toEqual(["now-visible"]);
});

test("logs correlate commit-before-dispatch and exclude content and secrets", async () => {
  const records: LogRecord[] = [];
  await capture((record) => {
    records.push(record);
  });
  const options = testOptions({
    complete: scriptedCompletion([
      {
        kind: "tools",
        text: "PRIVATE_ASSISTANT",
        calls: [{ id: "call-1", name: "echo", args: { text: "PRIVATE_TOOL" } }],
      },
      { kind: "answer", text: "PRIVATE_ANSWER" },
    ]),
  });
  const session = await createSession(options);
  await session.input("PRIVATE_USER").settled;
  const sessionId = session.snapshot.durable.conversation.sessionId;
  const dispatches = records.filter((record) => record.rawMessage === "command.dispatched");
  expect(dispatches.length).toBeGreaterThan(0);
  for (const dispatch of dispatches) {
    const previous = records.slice(0, records.indexOf(dispatch));
    expect(
      previous.some(
        (record) =>
          record.rawMessage === "append.settled" && record.properties.outcome === "committed",
      ),
    ).toBe(true);
    expect(dispatch.properties.sessionId).toBe(sessionId);
    expect(dispatch.properties.turnId).toBeString();
    expect(dispatch.properties.childId).toBeString();
  }
  expect(
    records.some(
      (record) => record.rawMessage === "tool.released" && record.properties.callId === "call-1",
    ),
  ).toBe(true);
  expect(records.some((record) => record.category[1] === "provider")).toBe(true);
  const restored = await restoreSession(options, sessionId);
  expect(restored.snapshot.durable).toEqual(session.snapshot.durable);
  await session.close();
  const count = records.length;
  await restored.input("PRIVATE_FOLLOWUP").settled;
  expect(records.length).toBeGreaterThan(count);
  await restored.close();
  const serialized = JSON.stringify(records);
  for (const secret of ["SECRET_SENTINEL", "PRIVATE_", "example.invalid", "parameters", "apiKey"]) {
    expect(serialized).not.toContain(secret);
  }
});

test("sink failures cannot fail a turn or close shared logging", async () => {
  let calls = 0;
  await capture(() => {
    calls++;
    throw new Error("sink unavailable");
  });
  const session = await createSession(testOptions());
  const result = await session.input("hello").settled;
  expect(result.kind === "terminal" && result.record.outcome.kind).toBe("completed");
  await session.close();
  const before = calls;
  diagnostic("host", "info", "still-configured");
  expect(calls).toBeGreaterThan(before);
});

test("lost acknowledgements preserve reconciliation identity and completion failure cause", async () => {
  const records: LogRecord[] = [];
  await capture((record) => {
    records.push(record);
  });
  const session = await createSession(
    testOptions({
      persistence: lostAcknowledgement(createMemoryPersistence()),
      complete: () => {
        throw new Error("PRIVATE_ERROR");
      },
    }),
  );
  const result = await session.input("hello").settled;
  expect(result.kind === "terminal" && result.record.outcome.kind).toBe("failed");
  expect(
    records.some(
      (record) =>
        record.rawMessage === "append.reconciling" &&
        typeof record.properties.appendId === "string",
    ),
  ).toBe(true);
  expect(records.some((record) => record.level === "warning")).toBe(true);
  expect(JSON.stringify(records)).toContain("PRIVATE_ERROR");
  await session.close();
});

test("unconfigured diagnostics are silent", async () => {
  await reset();
  expect(() => diagnostic("host", "error", "unconfigured")).not.toThrow();
});

test("only environment reset disposes sinks; multiple sinks receive records", async () => {
  let disposed = 0;
  const first: LogRecord[] = [];
  const second: LogRecord[] = [];
  const sink = Object.assign(
    (record: LogRecord) => {
      first.push(record);
    },
    {
      [Symbol.dispose]() {
        disposed++;
      },
    },
  );
  await configure({
    reset: true,
    sinks: {
      first: sink,
      second: (record) => {
        second.push(record);
      },
    },
    loggers: [
      { category: ["logtape", "meta"], lowestLevel: null },
      { category: ["labkit"], lowestLevel: "info", sinks: ["first", "second"] },
    ],
  });
  const session = await createSession(testOptions());
  await session.close();
  expect(disposed).toBe(0);
  expect(first.length).toBeGreaterThan(0);
  expect(second).toEqual(first);
  await reset();
  expect(disposed).toBe(1);
});

test("diagnostics render correlation and causes in human output and structured records", async () => {
  const records: LogRecord[] = [];
  await capture((record) => {
    records.push(record);
  });
  const log = diagnosticContext("provider", { sessionId: "session-7", turnId: "turn-2" });
  const cause = Object.assign(new Error("socket reset while contacting /v1/messages"), {
    code: "ECONNRESET",
  });
  const error = Object.assign(new Error("Anthropic request failed", { cause }), {
    status: 400,
    requestId: "req-123",
    body: { error: { message: "thinking budget exceeds max_tokens" } },
    apiKey: "secret-key",
    authorization: "Bearer private-token",
  });
  log("warning", "provider.request.failed", {
    childId: "child-3",
    durationMs: 42,
    error: diagnosticError(error),
  });
  const record = records[0]!;
  expect(record.properties.event).toBe("provider.request.failed");
  expect(record.properties.sessionId).toBe("session-7");
  const rendered = record.message.join("");
  for (const expected of [
    "session-7",
    "turn-2",
    "child-3",
    "req-123",
    "ECONNRESET",
    "thinking budget exceeds max_tokens",
    "400",
    "42",
  ]) {
    expect(rendered).toContain(expected);
  }
  expect(rendered).not.toContain("secret-key");
  expect(rendered).not.toContain("private-token");
  expect((record.properties.error as { stack: string }).stack).toContain(
    "Anthropic request failed",
  );
});

test("redaction targets credentials and preserves diagnostic details including exact-key echoes", () => {
  const output = redactDiagnostics(
    {
      path: "/workspace/auth/token.ts",
      maxOutputTokens: 4096,
      tokenUsage: { output: 3000 },
      url: "https://example.invalid/messages?api_key=secret-value&model=sonnet",
      body: "Provider rejected key arbitrary-provider-credential: invalid account scope",
      headers: new Headers({ "x-api-key": "secret-value", "request-id": "req-5" }),
      cause: new Error("failure details"),
    },
    ["arbitrary-provider-credential"],
  );
  const serialized = JSON.stringify(output);
  for (const detail of [
    "/workspace/auth/token.ts",
    "4096",
    "3000",
    "model=sonnet",
    "invalid account scope",
    "req-5",
    "failure details",
  ]) {
    expect(serialized).toContain(detail);
  }
  expect(serialized).not.toContain("secret-value");
  expect(serialized).not.toContain("arbitrary-provider-credential");
  const cyclic: Record<string, unknown> = {};
  cyclic.cause = cyclic;
  expect(redactDiagnostics(cyclic)).toEqual({ cause: "[Circular]" });
});
