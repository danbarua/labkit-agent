import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSession, defineTool, type SessionPersistence } from "@labkit-agent/core";
import { openaiChat } from "@labkit-agent/core/providers";
import { createMemoryPersistence } from "@labkit-agent/core/testing";
import { SessionIdSchema } from "@labkit-agent/core/types";
import { getLogger } from "@logtape/logtape";
import { expect, spyOn, test } from "@logtape/testing-bun/autoload";
import { z } from "zod";

import { deferred, until } from "../core/agent/test-support.ts";
import { withFixtureDiagnostics } from "../core/logging/fixture-capture.ts";
import type { AcpOptions } from "./adapter.ts";
import { workspaceAgent } from "./examples/vscode-workspace.ts";
import { selectChoices } from "./session-config.ts";
import { answer, configurable, offline, prompt } from "./testing/fixtures.ts";
import { harness, setup } from "./testing/harness.ts";

function booleanConfiguration() {
  const base = configurable();
  const options: AcpOptions = {
    ...base.options,
    sessionOptions: async (context) => {
      const original = await base.options.sessionOptions(context);
      return {
        ...original,
        config: [
          ...original.config!,
          {
            id: "tools_enabled",
            name: "Enable tools",
            type: "boolean",
            category: "mode",
            current: (policy) => (policy.tools.a?.length ?? 0) > 0,
            patches: { true: { tools: { a: ["echo"] } }, false: { tools: { a: [] } } },
          },
        ],
      };
    },
  };
  return { ...base, options };
}

/** Holds each policy journal append until the test calls its release, in arrival order. */
function heldPolicyAppends() {
  const base = configurable();
  const held: (() => void)[] = [];
  const persistence: SessionPersistence = {
    ...base.persistence,
    append: async (request, signal) => {
      if (request.records.some((raw) => JSON.parse(raw).body.kind === "policy"))
        await new Promise<void>((release) => held.push(release));
      return base.persistence.append(request, signal);
    },
  };
  const options: AcpOptions = {
    ...base.options,
    forkSession: true,
    sessionOptions: async (context) => ({
      ...(await base.options.sessionOptions(context)),
      persistence,
    }),
  };
  return { ...base, options, held };
}

test("config updates wait for the journal receipt, notify complete state, and restore with modes", async () => {
  const models: string[] = [];
  const base = configurable((model) => {
    models.push(model);
    return answer;
  });
  const gate = deferred<void>();
  let entered = false;
  let gatePolicy = true;
  const persistence = {
    ...base.persistence,
    append: async (request: Parameters<typeof base.persistence.append>[0], signal: AbortSignal) => {
      if (gatePolicy && request.records.some((raw) => JSON.parse(raw).body.kind === "policy")) {
        entered = true;
        await gate.promise;
        gatePolicy = false;
      }
      return base.persistence.append(request, signal);
    },
  };
  const options: AcpOptions = {
    ...base.options,
    sessionOptions: async (context) => ({
      ...(await base.options.sessionOptions(context)),
      persistence,
    }),
  };
  let h = harness(options);
  try {
    await h.initialize();
    const created = (await h.request("session/new", { cwd: "/tmp", mcpServers: [] })).result;
    const id = created.sessionId;
    expect(created.configOptions.map((option: any) => option.currentValue)).toEqual(["m", "tools"]);
    expect(created.modes.currentModeId).toBe("tools");
    expect(
      (
        await h.request("session/set_config_option", {
          sessionId: id,
          configId: "model",
          value: "unknown",
        })
      ).error?.code,
    ).toBe(-32602);
    const setting = await h.start("session/set_config_option", {
      sessionId: id,
      configId: "model",
      value: "m2",
    });
    await until(() => entered);
    expect(h.updates()).toHaveLength(0);
    const turn = await h.start("session/prompt", prompt(id));
    await Bun.sleep(5);
    expect(models).toEqual([]);
    expect(h.messages.some((message) => message.id === setting && !message.method)).toBe(false);
    gate.resolve();
    const response = await h.response(setting);
    expect(response.result.configOptions.map((option: any) => option.currentValue)).toEqual([
      "m2",
      "tools",
    ]);
    expect((await h.response(turn)).result.stopReason).toBe("end_turn");
    expect(models).toEqual(["m2"]);
    expect(base.requests[0]?.tools?.some((tool) => tool.function.name === "echo")).toBe(true);
    expect(
      h.updates().filter((n) => n.update.sessionUpdate === "config_option_update"),
    ).toHaveLength(1);
    expect((await h.request("session/set_mode", { sessionId: id, modeId: "chat" })).result).toEqual(
      {},
    );
    expect(
      h
        .updates()
        .some(
          (n) =>
            n.update.sessionUpdate === "current_mode_update" && n.update.currentModeId === "chat",
        ),
    ).toBe(true);
    expect((await h.request("session/prompt", prompt(id))).result.stopReason).toBe("end_turn");
    expect(base.requests.at(-1)?.tools ?? []).toEqual([]);
    await h.close();
    h = harness(options);
    await h.initialize();
    const loaded = (await h.request("session/load", { sessionId: id, cwd: "/tmp", mcpServers: [] }))
      .result;
    expect(loaded.configOptions.map((option: any) => option.currentValue)).toEqual(["m2", "chat"]);
    expect(loaded.modes.currentModeId).toBe("chat");
  } finally {
    gate.resolve();
    await h.close();
  }
});

test("configuration requested mid-turn waits for settlement and does not admit overlapping prompts", async () => {
  const pending = deferred<unknown>();
  const models: string[] = [];
  const { options } = configurable((model) => {
    models.push(model);
    return models.length === 1 ? pending.promise : answer;
  });
  const h = harness(options);
  try {
    await h.initialize();
    const id = await h.newSession();
    const first = await h.start("session/prompt", prompt(id));
    await until(() => models.length === 1);
    const setting = await h.start("session/set_config_option", {
      sessionId: id,
      configId: "model",
      value: "m2",
    });
    expect((await h.request("session/prompt", prompt(id))).error?.code).toBe(-32000);
    expect(h.messages.some((m) => m.id === setting && !m.method)).toBe(false);
    pending.resolve(answer);
    expect((await h.response(first)).result.stopReason).toBe("end_turn");
    expect((await h.response(setting)).result.configOptions[0].currentValue).toBe("m2");
    expect((await h.request("session/prompt", prompt(id))).result.stopReason).toBe("end_turn");
    expect(models).toEqual(["m", "m2"]);
  } finally {
    pending.resolve(answer);
    await h.close();
  }
});

test("closing an active session rejects queued config without journaling the change", async () => {
  let started = false;
  const pending = deferred<unknown>();
  const { options, persistence } = configurable(() => {
    started = true;
    return pending.promise;
  });
  const h = harness(options);
  try {
    await h.initialize();
    const id = await h.newSession();
    await h.start("session/prompt", prompt(id));
    await until(() => started);
    const setting = await h.start("session/set_config_option", {
      sessionId: id,
      configId: "model",
      value: "m2",
    });
    expect((await h.request("session/close", { sessionId: id })).result).toEqual({});
    expect((await h.response(setting)).error?.code).toBe(-32000);
    const { SessionIdSchema } = await import("@labkit-agent/core/types");
    const loaded = await persistence.load(SessionIdSchema.parse(id), new AbortController().signal);
    expect(
      loaded.kind === "loaded" &&
        loaded.batches
          .flatMap((batch) => batch.records)
          .some((raw) => JSON.parse(raw).body.kind === "policy"),
    ).toBe(false);
  } finally {
    pending.resolve(answer);
    await h.close();
  }
});

test("cancelling a queued configuration request never applies it after the turn", async () => {
  const pending = deferred<unknown>();
  let started = false;
  const { options, persistence } = configurable(() => {
    started = true;
    return pending.promise;
  });
  const h = harness(options);
  try {
    await h.initialize();
    const id = await h.newSession();
    const turn = await h.start("session/prompt", prompt(id));
    await until(() => started);
    const setting = await h.start("session/set_config_option", {
      sessionId: id,
      configId: "model",
      value: "m2",
    });
    await h.send({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: setting } });
    expect((await h.response(setting)).error).toBeDefined();
    pending.resolve(answer);
    await h.response(turn);
    const { SessionIdSchema } = await import("@labkit-agent/core/types");
    const loaded = await persistence.load(SessionIdSchema.parse(id), new AbortController().signal);
    expect(
      loaded.kind === "loaded" &&
        loaded.batches
          .flatMap((batch) => batch.records)
          .some((raw) => JSON.parse(raw).body.kind === "policy"),
    ).toBe(false);
    expect(h.updates().some((n) => n.update.sessionUpdate === "config_option_update")).toBe(false);
  } finally {
    pending.resolve(answer);
    await h.close();
  }
});

test("cancelling a prompt that waits on a configuration change rejects it before the change commits", async () => {
  const emitted = spyOn(getLogger(["labkit", "acp"]), "emit");
  const { options, held, requests } = heldPolicyAppends();
  const h = harness(options);
  try {
    await h.initialize();
    const id = await h.newSession();
    const setting = await h.start("session/set_config_option", {
      sessionId: id,
      configId: "model",
      value: "m2",
    });
    await until(() => held.length === 1);
    const turn = await h.start("session/prompt", prompt(id));
    // Cancel only once the prompt handler is waiting on the configuration boundary.
    await until(() =>
      emitted.mock.calls.some(
        ([record]) =>
          record.properties.event === "acp.prompt.received" &&
          record.properties.rpcRequestId === String(turn),
      ),
    );
    await h.send({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: turn } });
    expect(await h.response(turn)).toMatchObject({ error: { code: -32800 } });
    held[0]!();
    expect((await h.response(setting)).result.configOptions[0].currentValue).toBe("m2");
    expect((await h.request("session/prompt", prompt(id))).result.stopReason).toBe("end_turn");
    expect(requests.map((request) => request.model)).toEqual(["m2"]);
  } finally {
    for (const release of held) release();
    await h.close();
    emitted.mockRestore();
  }
});

test("cancelled configuration and fork requests queued behind a pending change reject without waiting for it", async () => {
  const emitted = spyOn(getLogger(["labkit", "acp"]), "emit");
  const { options, held, persistence } = heldPolicyAppends();
  const h = harness(options);
  try {
    await h.initialize();
    const id = await h.newSession();
    const model = await h.start("session/set_config_option", {
      sessionId: id,
      configId: "model",
      value: "m2",
    });
    await until(() => held.length === 1);
    const fork = await h.start("session/fork", { sessionId: id, cwd: "/tmp" });
    const mode = await h.start("session/set_config_option", {
      sessionId: id,
      configId: "mode",
      value: "chat",
    });
    const records = () => emitted.mock.calls.map(([record]) => record.properties);
    // Cancel only once both handlers are queued; fork was dispatched before the mode change.
    await until(() =>
      records().some(
        (record) => record.event === "acp.config.queued" && record.rpcRequestId === String(mode),
      ),
    );
    for (const requestId of [fork, mode])
      await h.send({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId } });
    expect(await h.response(fork)).toMatchObject({ error: { code: -32800 } });
    expect(await h.response(mode)).toMatchObject({ error: { code: -32800 } });
    expect(records()).toContainEqual(
      expect.objectContaining({
        event: "acp.config.cancelled",
        rpcRequestId: String(mode),
        outcome: "cancelled",
      }),
    );
    expect(held).toHaveLength(1);
    held[0]!();
    const settled: { currentValue: unknown }[] = (await h.response(model)).result.configOptions;
    expect(settled.map((option) => option.currentValue)).toEqual(["m2", "tools"]);
    const loaded = await persistence.load(SessionIdSchema.parse(id), new AbortController().signal);
    expect(
      loaded.kind === "loaded" &&
        loaded.batches
          .flatMap((batch) => batch.records)
          .filter((raw) => JSON.parse(raw).body.kind === "policy").length,
    ).toBe(1);
  } finally {
    for (const release of held) release();
    await h.close();
    emitted.mockRestore();
  }
});

test("invalid policy patches return errors without publishing a configuration change", async () => {
  const base = configurable();
  const h = harness({
    ...base.options,
    sessionOptions: async (context) => {
      const original = await base.options.sessionOptions(context);
      return {
        ...original,
        config: original.config!.map((binding) =>
          binding.id !== "model" || binding.type === "boolean"
            ? binding
            : {
                ...binding,
                options: (policy) => [
                  ...selectChoices(binding, policy),
                  {
                    value: "unbound",
                    name: "Unbound",
                    patch: { model: "unbound", provider: "missing@1" },
                  },
                ],
              },
        ),
      };
    },
  });
  try {
    await h.initialize();
    const id = await h.newSession();
    expect(
      (
        await h.request("session/set_config_option", {
          sessionId: id,
          configId: "model",
          value: "unbound",
        })
      ).error?.code,
    ).toBe(-32000);
    expect(h.updates()).toHaveLength(0);
    const same = await h.request("session/set_config_option", {
      sessionId: id,
      configId: "model",
      value: "m",
    });
    expect(same.result.configOptions[0].currentValue).toBe("m");
    expect((await h.request("session/prompt", prompt(id))).result.stopReason).toBe("end_turn");
  } finally {
    await h.close();
  }
});

test("a workspace session saved on anthropic/claude-sonnet-5 with adaptive thinking reopens with catalog selectors", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "labkit-acp-saved-model-")));
  const make = () =>
    workspaceAgent({ ANTHROPIC_API_KEY: "fixture" }, undefined, { fetch: offline });
  try {
    // Journal the policy the earlier single-provider launcher wrote for this model.
    const options = await make().sessionOptions({ cwd, signal: new AbortController().signal });
    const saved = await createSession({
      ...options,
      configuration: {
        ...options.configuration,
        policy: {
          ...options.configuration.policy,
          provider: "anthropic",
          model: "claude-sonnet-5",
          thinking: "adaptive",
          maxOutputTokens: 16384,
        },
      },
      bindings: {
        ...options.bindings,
        requestPermission: async () => ({ outcome: { outcome: "cancelled" as const } }),
      },
    });
    const sessionId = saved.snapshot.durable.conversation.sessionId;
    await saved.close();
    const h = harness(make());
    try {
      await h.initialize();
      const loaded = await h.request("session/load", { sessionId, cwd, mcpServers: [] });
      expect(loaded.error).toBeUndefined();
      const option = (id: string) =>
        (
          loaded.result.configOptions as { id: string; currentValue: string; options: unknown[] }[]
        ).find((entry) => entry.id === id)!;
      expect(option("model").currentValue).toBe("anthropic/claude-sonnet-5");
      expect(option("model").options).toContainEqual({
        group: "anthropic",
        name: "Anthropic",
        options: expect.arrayContaining([
          { value: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5" },
          { value: "anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5 (latest)" },
        ]),
      });
      expect(option("thinking")).toMatchObject({
        currentValue: "adaptive",
        options: [
          { value: "off", name: "Off" },
          { value: "adaptive", name: "Adaptive" },
        ],
      });
      expect(option("max_output_tokens").currentValue).toBe("16384");
      expect(JSON.stringify(loaded.result)).not.toContain("(saved)");
    } finally {
      await h.close();
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("boolean configuration is capability-gated and rejects wrong wire value types", async () => {
  for (const capability of [undefined, null, {}]) {
    const h = harness(booleanConfiguration().options);
    try {
      await h.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { session: { configOptions: { boolean: capability } } },
      });
      const created = (await h.request("session/new", { cwd: "/tmp", mcpServers: [] })).result;
      const visible = capability != null;
      expect(created.configOptions.some((option: any) => option.type === "boolean")).toBe(visible);
      expect(created.modes.currentModeId).toBe("tools");
      for (const params of [
        { type: "boolean", value: "false" },
        { value: false },
        { type: "select", value: "false" },
      ])
        expect(
          (
            await h.request("session/set_config_option", {
              sessionId: created.sessionId,
              configId: "tools_enabled",
              ...params,
            })
          ).error?.code,
        ).toBe(-32602);
      const result = await h.request("session/set_config_option", {
        sessionId: created.sessionId,
        configId: "tools_enabled",
        type: "boolean",
        value: false,
      });
      if (visible) {
        expect(result.error).toBeUndefined();
        expect(result.result.configOptions.at(-1)).toEqual({
          id: "tools_enabled",
          name: "Enable tools",
          category: "mode",
          type: "boolean",
          currentValue: false,
        });
        expect(
          result.result.configOptions.find((option: any) => option.id === "mode").currentValue,
        ).toBe("chat");
      } else expect(result.error?.code).toBe(-32602);
    } finally {
      await h.close();
    }
  }
});

test("boolean configuration waits for its policy receipt and restores without exposing it to older clients", async () => {
  const base = booleanConfiguration();
  const gate = deferred<void>();
  let entered = false;
  const persistence = {
    ...base.persistence,
    append: async (request: Parameters<typeof base.persistence.append>[0], signal: AbortSignal) => {
      if (request.records.some((raw) => JSON.parse(raw).body.kind === "policy")) {
        entered = true;
        await gate.promise;
      }
      return base.persistence.append(request, signal);
    },
  };
  const options: AcpOptions = {
    ...base.options,
    sessionOptions: async (context) => ({
      ...(await base.options.sessionOptions(context)),
      persistence,
    }),
  };
  let h = harness(options);
  const initialize = () =>
    h.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { session: { configOptions: { boolean: {} } } },
    });
  try {
    await initialize();
    const id = await h.newSession();
    const set = await h.start("session/set_config_option", {
      sessionId: id,
      configId: "tools_enabled",
      type: "boolean",
      value: false,
    });
    await until(() => entered);
    expect(h.messages.some((m) => m.id === set && !m.method)).toBe(false);
    expect(h.updates().some((m) => m.update.sessionUpdate === "config_option_update")).toBe(false);
    gate.resolve();
    const result = await h.response(set);
    expect(result.result.configOptions.at(-1).currentValue).toBe(false);
    const update = h
      .updates()
      .find((m) => m.update.sessionUpdate === "config_option_update")!.update;
    expect(update).toMatchObject({ configOptions: result.result.configOptions });
    await h.close();
    h = harness(options);
    await h.initialize();
    const legacy = await h.request("session/load", { sessionId: id, cwd: "/tmp", mcpServers: [] });
    expect(legacy.result.configOptions.some((option: any) => option.type === "boolean")).toBe(
      false,
    );
    expect(legacy.result.modes.currentModeId).toBe("chat");
    await h.close();
    h = harness(options);
    await initialize();
    const restored = await h.request("session/resume", {
      sessionId: id,
      cwd: "/tmp",
      mcpServers: [],
    });
    expect(restored.result.configOptions.at(-1).currentValue).toBe(false);
    expect(base.requests).toHaveLength(0);
  } finally {
    gate.resolve();
    await h.close();
  }
});

test("reopening under a different launcher model uses the live model and lists unlisted saved values", async () => {
  const directory = `.session-artifacts/acp-model-reconcile/${crypto.randomUUID()}`;
  const persistence = createMemoryPersistence();
  const bodies: { model: string; messages: { role: string; content: string }[] }[] = [];
  const launcher = (model: string, available: string[], offered: string[]): AcpOptions => ({
    loadSession: true,
    sessionOptions: () => ({
      persistence,
      configuration: {
        agent: "a",
        agents: new Map([["a", { model, tools: ["echo"], successors: [] }]]),
        steps: 3,
        policy: { maxOutputTokens: 16384, provider: openaiChat.id, model },
      },
      bindings: {
        tools: new Map([
          ["echo", defineTool({ input: z.object({ text: z.string() }), run: ({ text }) => text })],
        ]),
        providers: new Map([
          [
            openaiChat.id,
            {
              profile: openaiChat,
              models: new Map(
                available.map((name) => [name, { wireModel: name, profile: openaiChat }]),
              ),
              transport: {
                baseUrl: "https://test.invalid",
                fetch: (async (_url, init) => {
                  const body = JSON.parse(String(init?.body));
                  bodies.push(body);
                  return Response.json({
                    choices: [{ message: { content: `Answer ${bodies.length}` } }],
                  });
                }) as typeof fetch,
              },
            },
          ],
        ]),
      },
      config: [
        {
          id: "model",
          name: "Model",
          category: "model",
          current: (policy) => policy.model ?? model,
          options: offered.map((value) => ({ value, name: value, patch: { model: value } })),
        },
      ],
    }),
  });
  const load = async (h: ReturnType<typeof harness>, sessionId: string) => {
    const response = await h.request("session/load", { sessionId, cwd: "/tmp", mcpServers: [] });
    expect(response.error).toBeUndefined();
    return response.result.configOptions[0] as {
      currentValue: string;
      options: { value: string; name: string; description?: string }[];
    };
  };
  let sessionId = "";
  await withFixtureDiagnostics(directory, {}, async () => {
    let h = harness(launcher("model-a", ["model-a"], ["model-a"]));
    try {
      await h.initialize();
      sessionId = await h.newSession();
      expect((await h.request("session/prompt", prompt(sessionId))).result.stopReason).toBe(
        "end_turn",
      );
      await h.close();
      // The relaunched binding no longer serves model-a.
      h = harness(launcher("model-b", ["model-b"], ["model-b"]));
      await h.initialize();
      const reconciled = await load(h, sessionId);
      expect(reconciled.currentValue).toBe("model-b");
      expect(reconciled.options.map((option) => option.value)).toEqual(["model-b"]);
      expect(h.updates().map(({ update }) => update.sessionUpdate)).toEqual([
        "user_message_chunk",
        "agent_message_chunk",
      ]);
      expect(bodies).toHaveLength(1);
      expect((await h.request("session/prompt", prompt(sessionId))).result.stopReason).toBe(
        "end_turn",
      );
      expect(bodies[1]!.model).toBe("model-b");
      expect(bodies[1]!.messages.map(({ role, content }) => [role, content])).toEqual([
        ["user", "Go"],
        ["assistant", "Answer 1"],
        ["user", "Go"],
      ]);
      await h.close();
      // model-b is still served but no longer offered by the selector.
      h = harness(launcher("model-a", ["model-a", "model-b"], ["model-a"]));
      await h.initialize();
      const unlisted = await load(h, sessionId);
      expect(unlisted.currentValue).toBe("model-b");
      expect(unlisted.options).toEqual([
        { value: "model-a", name: "model-a" },
        {
          value: "model-b",
          name: "model-b (saved)",
          description: "Saved session value; not offered by the current configuration",
        },
      ]);
      const keep = { sessionId, configId: "model", value: "model-b" };
      expect(
        (await h.request("session/set_config_option", keep)).result.configOptions[0].currentValue,
      ).toBe("model-b");
      const changed = await h.request("session/set_config_option", { ...keep, value: "model-a" });
      expect(changed.result.configOptions[0]).toMatchObject({
        currentValue: "model-a",
        options: [{ value: "model-a", name: "model-a" }],
      });
      expect((await h.request("session/prompt", prompt(sessionId))).result.stopReason).toBe(
        "end_turn",
      );
      expect(bodies.at(-1)!.model).toBe("model-a");
    } finally {
      await h.close();
    }
  });
  const records = (await Bun.file(`${directory}/diagnostics.jsonl`).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const unlisted = records.filter((record) => record.event === "acp.session.config.unlisted_value");
  expect(unlisted).toHaveLength(1);
  expect(unlisted[0]).toMatchObject({
    level: "info",
    sessionId,
    method: "session/load",
    configId: "model",
    value: "model-b",
  });
  expect(unlisted[0].rpcRequestId).toBeString();
  expect(
    records.filter(
      (record) => record.event.startsWith("acp.") && ["warning", "error"].includes(record.level),
    ),
  ).toEqual([]);
});
