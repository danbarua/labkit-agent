import { getLogger } from "@logtape/logtape";
import { expect, spyOn, test } from "@logtape/testing-bun/autoload";

import { deferred, until } from "../core/agent/test-support.ts";
import type { AcpOptions } from "./adapter.ts";
import { answer, prompt } from "./testing/fixtures.ts";
import { harness, setup } from "./testing/harness.ts";

test("ACP publishes bound session usage on open, prompt, external change and restore without replaying work", async () => {
  const { withFixtureDiagnostics } = await import("../core/logging/fixture-capture.ts");
  const directory = `.session-artifacts/acp-usage/${crypto.randomUUID()}`;
  await withFixtureDiagnostics(directory, {}, async () => {
    let completions = 0;
    let measurement = { used: 1200, size: 32000, cost: { amount: 0.02, currency: "EUR" } };
    let changed: (() => void) | undefined;
    let cleanup = 0;
    const reads: { sessionId: string; revision: number }[] = [];
    const base = setup({
      complete: () => {
        completions++;
        measurement = { ...measurement, used: 1700, cost: { amount: 0.03, currency: "EUR" } };
        return answer;
      },
    });
    const options: AcpOptions = {
      ...base.options,
      sessionOptions: async (context) => ({
        ...(await base.options.sessionOptions(context)),
        usage: {
          read: ({ sessionId, snapshot }) => {
            reads.push({ sessionId, revision: snapshot.durable.revision });
            return {
              ...measurement,
              _meta: { "labkit.dev/source": "scripted measurement service" },
            };
          },
          subscribe: (notify, signal) => {
            changed = notify;
            expect(signal.aborted).toBe(false);
            return () => {
              cleanup++;
            };
          },
        },
      }),
    };
    const h = harness(options);
    const updates = () =>
      h.updates().filter(({ update }) => update.sessionUpdate === "usage_update");
    try {
      await h.initialize();
      const id = await h.newSession();
      await until(() => updates().length === 1);
      expect(updates()[0]?.update).toMatchObject({
        used: 1200,
        size: 32000,
        cost: { amount: 0.02, currency: "EUR" },
      });
      const priorRead = reads.length;
      changed!();
      await until(() => reads.length > priorRead);
      expect(updates()).toHaveLength(1);
      expect((await h.request("session/prompt", prompt(id))).result.stopReason).toBe("end_turn");
      await until(() => updates().some(({ update }) => "used" in update && update.used === 1700));
      measurement = { used: 1800, size: 64000, cost: { amount: 0.04, currency: "EUR" } };
      changed!();
      await until(() => updates().some(({ update }) => "size" in update && update.size === 64000));
      const oldChanged = changed!;
      const count = updates().length;
      await h.request("session/close", { sessionId: id });
      expect(cleanup).toBe(1);
      oldChanged();
      expect(updates()).toHaveLength(count);
      const readsBefore = reads.length;
      expect(
        (await h.request("session/load", { sessionId: id, cwd: "/tmp", mcpServers: [] })).error,
      ).toBeUndefined();
      await until(() => updates().length > count);
      expect(reads.length).toBeGreaterThan(readsBefore);
      expect(updates().at(-1)?.update).toMatchObject({
        used: 1800,
        size: 64000,
        cost: { amount: 0.04, currency: "EUR" },
      });
      expect(completions).toBe(1);
      expect(reads.every((read) => read.sessionId === id)).toBe(true);
      await Bun.write(`${directory}/protocol.json`, JSON.stringify(h.messages, null, 2));
    } finally {
      await h.close();
    }
    expect(cleanup).toBe(2);
  });
  const logs = (await Bun.file(`${directory}/diagnostics.jsonl`).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    logs.some(
      (line) =>
        line.event === "acp.usage.updated" &&
        line.used === 1800 &&
        line.size === 64000 &&
        line.sessionId &&
        line.connectionId &&
        line.revision,
    ),
  ).toBe(true);
  expect(logs.filter((line) => ["warning", "error", "fatal"].includes(line.level))).toEqual([]);
});

test("ACP discards superseded usage reads and cancels subscription work when the session closes", async () => {
  const { AcpUsageSchema } = await import("./session-usage.ts");
  const base = setup();
  const emitted = spyOn(getLogger(["labkit", "acp"]), "emit");
  const first = deferred<import("./session-usage.ts").AcpUsage>();
  const second = deferred<import("./session-usage.ts").AcpUsage>();
  let changed: (() => void) | undefined;
  const signals: AbortSignal[] = [];
  let subscriptionSignal: AbortSignal | undefined;
  const h = harness({
    ...base.options,
    sessionOptions: async (context) => ({
      ...(await base.options.sessionOptions(context)),
      usage: {
        read: (_context, signal) => {
          signals.push(signal);
          return signals.length === 1 ? first.promise : second.promise;
        },
        subscribe: (notify, signal) => {
          changed = notify;
          subscriptionSignal = signal;
        },
      },
    }),
  });
  try {
    await h.initialize();
    const id = await h.newSession();
    await until(() => signals.length === 1);
    changed!();
    await until(() => signals.length === 2);
    expect(signals[0]?.aborted).toBe(true);
    second.resolve(AcpUsageSchema.parse({ used: 120.5, size: 100, cost: null }));
    await until(() => h.updates().some(({ update }) => update.sessionUpdate === "usage_update"));
    first.resolve({ used: 99, size: 100 });
    await h.request("session/close", { sessionId: id });
    expect(subscriptionSignal?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(true);
    changed!();
    expect(signals).toHaveLength(2);
    const diagnostics = emitted.mock.calls.map((call) => call[0].properties);
    expect(
      diagnostics.some(
        (fields) =>
          fields.event === "acp.usage.cancelled" &&
          fields.sessionId === id &&
          typeof fields.usageRequestId === "string" &&
          fields.reason,
      ),
    ).toBe(true);
    expect(
      diagnostics.some((fields) => fields.event === "acp.usage.closed" && fields.sessionId === id),
    ).toBe(true);
    expect(
      h
        .updates()
        .filter(({ update }) => update.sessionUpdate === "usage_update")
        .map(({ update }) => update),
    ).toEqual([{ sessionUpdate: "usage_update", used: 120.5, size: 100, cost: null }]);
  } finally {
    first.resolve({ used: 99, size: 100 });
    second.resolve({ used: 120.5, size: 100 });
    await h.close();
    emitted.mockRestore();
  }
});

test("invalid or unavailable ACP usage emits no invented capacity and does not stop a prompt", async () => {
  const { withFixtureDiagnostics } = await import("../core/logging/fixture-capture.ts");
  const directory = `.session-artifacts/acp-usage-invalid/${crypto.randomUUID()}`;
  await withFixtureDiagnostics(directory, {}, async () => {
    const base = setup();
    let changed: (() => void) | undefined;
    let calls = 0;
    let value: unknown;
    const h = harness({
      ...base.options,
      sessionOptions: async (context) => ({
        ...(await base.options.sessionOptions(context)),
        usage: {
          read: () => {
            calls++;
            return value as import("./session-usage.ts").AcpUsage | undefined;
          },
          subscribe: (notify) => {
            changed = notify;
          },
        },
      }),
    });
    try {
      await h.initialize();
      const id = await h.newSession();
      await until(() => calls === 1);
      value = { used: 300, size: 0, cost: { amount: -1, currency: "euro" } };
      changed!();
      expect((await h.request("session/prompt", prompt(id))).result.stopReason).toBe("end_turn");
      await until(() => calls > 2);
      expect(h.updates().filter(({ update }) => update.sessionUpdate === "usage_update")).toEqual(
        [],
      );
    } finally {
      await h.close();
    }
  });
  const logs = (await Bun.file(`${directory}/diagnostics.jsonl`).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(logs.some((line) => line.event === "acp.usage.unavailable")).toBe(true);
  const rejected = logs.find((line) => line.event === "acp.usage.failed");
  expect(rejected.level).toBe("warning");
  expect(rejected.reason).toContain("agent execution continues");
  expect(rejected.reportedUsage).toEqual({ used: 300, size: 0, amount: -1, currency: "euro" });
  expect(JSON.stringify(rejected.error)).toContain('"size"');
  expect(rejected.sessionId).toBeString();
  expect(rejected.connectionId).toBeString();
});

test("ACP usage observes committed configuration and publishes independently for forks and resume", async () => {
  const base = setup();
  const { openaiChat } = await import("../core/providers/index.ts");
  const gate = deferred<void>();
  let committing = false;
  const h = harness({
    ...base.options,
    forkSession: true,
    sessionOptions: async (context) => {
      const original = await base.options.sessionOptions(context);
      const { complete: _complete, ...bindings } = original.bindings;
      return {
        ...original,
        configuration: { ...original.configuration, policy: { provider: "openai", model: "m" } },
        bindings: {
          ...bindings,
          providers: new Map([
            [
              "openai",
              {
                profile: openaiChat,
                transport: {
                  baseUrl: "https://scripted.invalid",
                  fetch: (() => {
                    throw new Error("Usage lifecycle must not invoke HTTP completion");
                  }) as unknown as typeof fetch,
                },
              },
            ],
          ]),
        },
        persistence: {
          ...base.persistence,
          append: async (request, signal) => {
            if (request.records.some((raw) => JSON.parse(raw).body.kind === "policy")) {
              committing = true;
              await gate.promise;
            }
            return base.persistence.append(request, signal);
          },
        },
        config: [
          {
            id: "model",
            name: "Model",
            category: "model",
            current: (policy) => policy.model ?? "m",
            options: [
              { value: "m", name: "Standard", patch: { model: "m" } },
              { value: "large", name: "Large", patch: { model: "large" } },
            ],
          },
        ],
        usage: {
          read: ({ snapshot }) => ({
            used: 20,
            size: snapshot.durable.policy.model === "large" ? 2000 : 1000,
          }),
        },
      };
    },
  });
  const updates = () => h.updates().filter(({ update }) => update.sessionUpdate === "usage_update");
  try {
    await h.initialize();
    const id = await h.newSession();
    await until(() => updates().length === 1);
    const change = await h.start("session/set_config_option", {
      sessionId: id,
      configId: "model",
      value: "large",
    });
    await until(() => committing);
    expect(updates().map(({ update }) => ("size" in update ? update.size : undefined))).toEqual([
      1000,
    ]);
    gate.resolve();
    expect((await h.response(change)).error).toBeUndefined();
    await until(() => updates().length === 2);
    const fork = await h.request("session/fork", { sessionId: id, cwd: "/tmp" });
    expect(fork.error).toBeUndefined();
    const childId = fork.result.sessionId;
    await until(() => updates().some((update) => update.sessionId === childId));
    expect(updates().find((update) => update.sessionId === childId)?.update).toMatchObject({
      used: 20,
      size: 2000,
    });
    await h.request("session/close", { sessionId: id });
    const count = updates().length;
    expect(
      (await h.request("session/resume", { sessionId: id, cwd: "/tmp", mcpServers: [] })).error,
    ).toBeUndefined();
    await until(() => updates().length > count);
    expect(updates().at(-1)).toMatchObject({ sessionId: id, update: { used: 20, size: 2000 } });
  } finally {
    gate.resolve();
    await h.close();
  }
});
