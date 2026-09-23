import { afterEach, expect, test } from "bun:test";
import { createSession, restoreSession } from "../session/session-runtime.ts";
import { lostAcknowledgement, scriptedCompletion, testOptions } from "../session/test-support.ts";
import { createMemoryPersistence } from "../session/testing/memory-persistence.ts";
import { configure, diagnostic, reset, type LogRecord, type Sink } from "./index.ts";

afterEach(() => reset());

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

test("lost acknowledgements expose reconciliation without logging failure messages", async () => {
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
  expect(JSON.stringify(records)).not.toContain("PRIVATE_ERROR");
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
