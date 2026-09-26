import { getLogger } from "@logtape/logtape";
import { afterEach, expect, spyOn, test } from "@logtape/testing-bun/autoload";

import { catalogProviders } from "../../core/providers/index.ts";
import type { ConsoleEvent, SessionView } from "../protocol.ts";

for (const provider of catalogProviders(process.env).providers) {
  if (provider.credential) process.env[provider.credential] = "";
}
process.env.LABKIT_LOCAL_BASE_URL = "http://127.0.0.1:9/v1";
process.env.LABKIT_FIXTURE_DELAY_MS = "0";
delete process.env.LABKIT_FIXTURE_HOLD;

// Dynamic: the host reads the fixture environment above when it loads.
const host = await import("./session-host.ts");

const stops: (() => void)[] = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

function configurationEvents() {
  const logger = getLogger(["labkit", "session"]);
  const emit = logger.emit.bind(logger);
  const events: { event: string; level: string; fields: Record<string, unknown> }[] = [];
  const spy = spyOn(logger, "emit").mockImplementation((record) => {
    if (String(record.rawMessage).startsWith("configuration."))
      events.push({
        event: String(record.rawMessage),
        level: record.level,
        fields: record.properties,
      });
    emit(record);
  });
  stops.push(() => spy.mockRestore());
  return events;
}

function listen(sessionId: string) {
  const controller = new AbortController();
  stops.push(() => controller.abort());
  const response = host.eventResponse(sessionId, controller.signal);
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  const events: ConsoleEvent[] = [];
  const waiters = new Set<() => void>();
  void (async () => {
    let buffered = "";
    for (;;) {
      const chunk = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (chunk.done) return;
      buffered += chunk.value;
      const frames = buffered.split("\n\n");
      buffered = frames.pop() ?? "";
      for (const frame of frames) {
        const event: ConsoleEvent = JSON.parse(frame.replace(/^data: /, ""));
        events.push(event);
      }
      for (const wake of waiters) wake();
    }
  })();
  function next<T extends ConsoleEvent>(match: (event: ConsoleEvent) => event is T): Promise<T>;
  function next(match: (event: ConsoleEvent) => boolean): Promise<ConsoleEvent>;
  function next(match: (event: ConsoleEvent) => boolean) {
    return new Promise<ConsoleEvent>((resolve) => {
      const check = () => {
        const found = events.find(match);
        if (!found) return;
        waiters.delete(check);
        resolve(found);
      };
      waiters.add(check);
      check();
    });
  }
  const view = (match: (view: SessionView) => boolean) =>
    next(
      (event): event is Extract<ConsoleEvent, { kind: "snapshot" }> =>
        event.kind === "snapshot" && match(event.view),
    ).then((event) => event.view);
  return { events, next, view };
}

test("a configuration change during a running turn is selected, and the view shows it apart from the configuration in force until the turn ends", async () => {
  expect((await host.hostInfo()).mode).toBe("fixture");
  const log = configurationEvents();
  const opened = await host.openSession();
  const { sessionId } = opened;
  expect(opened.view.selectedPolicy).toEqual(opened.view.policy);
  expect(opened.view.policy.maxOutputTokens).toBeUndefined();
  const feed = listen(sessionId);
  const input = await host.admit(sessionId, { type: "user", text: "echo hi" });
  expect(input.body).toEqual({ receipt: { kind: "accepted" } });
  const permission = await feed.next(
    (event): event is Extract<ConsoleEvent, { kind: "permission" }> => event.kind === "permission",
  );

  const change = await host.admit(sessionId, {
    type: "policy",
    patch: { maxOutputTokens: 2048 },
  });

  expect(change).toEqual({ status: 200, body: { receipt: { kind: "selected" } } });
  const pending = await feed.view((view) => view.selectedPolicy.maxOutputTokens === 2048);
  expect(pending.phase).toBe("awaiting_permission");
  expect(pending.policy).toEqual({ ...pending.selectedPolicy, maxOutputTokens: undefined });
  expect(log.map((entry) => entry.event)).toEqual(["configuration.selected"]);
  expect(log[0]!.fields).toMatchObject({
    sessionId,
    turnStatus: "awaiting_permission",
    changedFields: ["maxOutputTokens"],
  });

  expect(
    await host.answerPermission(sessionId, {
      requestId: permission.request.requestId,
      optionId: "allow-once",
    }),
  ).toEqual({ status: 200, body: { ok: true } });
  const applied = await feed.view(
    (view) => view.phase === "idle" && view.policy.maxOutputTokens === 2048,
  );

  expect(applied.selectedPolicy).toEqual(applied.policy);
  expect(applied.log.at(-1)?.outcome.kind).toBe("completed");
  expect(log.map((entry) => entry.event)).toEqual([
    "configuration.selected",
    "configuration.applied",
  ]);
  expect(log[1]!.fields).toMatchObject({
    sessionId,
    selectionId: log[0]!.fields.selectionId,
    changedFields: ["maxOutputTokens"],
  });
});

test("an idle configuration change applies at once; an unchanged one is ignored and an invalid one fails with its cause", async () => {
  const { sessionId } = await host.openSession();
  const feed = listen(sessionId);

  expect(await host.admit(sessionId, { type: "policy", patch: { maxOutputTokens: 1024 } })).toEqual(
    { status: 200, body: { receipt: { kind: "accepted" } } },
  );
  const applied = await feed.view((view) => view.policy.maxOutputTokens === 1024);
  expect(applied.selectedPolicy).toEqual(applied.policy);
  expect(await host.admit(sessionId, { type: "policy", patch: { maxOutputTokens: 1024 } })).toEqual(
    { status: 200, body: { receipt: { kind: "ignored" } } },
  );

  const invalid = await host.admit(sessionId, { type: "policy", patch: { provider: "missing" } });

  expect(invalid.body).toMatchObject({
    receipt: { kind: "failed", failure: { classification: "admission", phase: "stage" } },
  });
  const [latest] = feed.events
    .flatMap((event) => (event.kind === "snapshot" ? [event.view] : []))
    .slice(-1);
  expect(latest?.selectedPolicy).toEqual(applied.policy);
});

function observeLogs() {
  const records: { event: string; level: string; fields: Record<string, unknown> }[] = [];
  const logger = getLogger(["labkit", "web"]);
  const original = logger.emit.bind(logger);
  const spy = spyOn(logger, "emit").mockImplementation((record) => {
    records.push({
      event: String(record.rawMessage),
      level: record.level,
      fields: record.properties,
    });
    original(record);
  });
  return { records, close: () => spy.mockRestore() };
}

test("exportSession backs GET /api/session/:id/export.md with the session's Markdown journal", async () => {
  const { sessionId } = await host.openSession({});
  const capture = observeLogs();
  try {
    const result = host.exportSession(sessionId, "markdown");
    expect(result?.contentType).toBe("text/markdown; charset=utf-8");
    expect(result?.body).toContain(`# Session ${sessionId}`);
    expect(capture.records).toHaveLength(1);
    expect(capture.records[0]).toMatchObject({
      event: "web.export.completed",
      level: "info",
      fields: { sessionId, format: "markdown" },
    });
    expect(capture.records[0]!.fields.bytes).toBe(Buffer.byteLength(result!.body, "utf8"));
    expect(typeof capture.records[0]!.fields.durationMs).toBe("number");
  } finally {
    capture.close();
  }
});

test("exportSession backs GET /api/session/:id/export.jsonl with one JSON record per line", async () => {
  const { sessionId } = await host.openSession({});
  const result = host.exportSession(sessionId, "jsonl");
  expect(result?.contentType).toBe("application/x-ndjson; charset=utf-8");
  const lines = result!.body.trim().split("\n");
  expect(lines.length).toBeGreaterThan(0);
  expect(JSON.parse(lines[0]!).body.kind).toBe("created");
});

test("exportSession returns undefined and logs no warning for a session this host never opened", () => {
  const capture = observeLogs();
  try {
    expect(host.exportSession("00000000-0000-4000-8000-000000000000", "markdown")).toBeUndefined();
    expect(host.exportSession("00000000-0000-4000-8000-000000000000", "jsonl")).toBeUndefined();
    expect(capture.records).toEqual([
      {
        event: "web.export.not_found",
        level: "info",
        fields: {
          sessionId: "00000000-0000-4000-8000-000000000000",
          format: "markdown",
          event: "web.export.not_found",
        },
      },
      {
        event: "web.export.not_found",
        level: "info",
        fields: {
          sessionId: "00000000-0000-4000-8000-000000000000",
          format: "jsonl",
          event: "web.export.not_found",
        },
      },
    ]);
  } finally {
    capture.close();
  }
});
