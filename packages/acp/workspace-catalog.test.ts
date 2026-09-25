import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { createSession } from "@labkit-agent/core";
import type { Policy } from "@labkit-agent/core/policy";
import { expect, test } from "@logtape/testing-bun/autoload";

import { withFixtureDiagnostics } from "../core/logging/fixture-capture.ts";
import { workspaceAgent } from "./examples/vscode-workspace.ts";
import {
  bindConfig,
  configPatch,
  configState,
  type AcpConfigBinding,
  type AcpSelectBinding,
} from "./session-config.ts";

const LOCAL_MODEL = "mlx-community/Qwen3.5-9B-MLX-4bit";

const ANTHROPIC_SECRET = "catalog-anthropic-credential-51c7";

const OPENAI_SECRET = "catalog-openai-credential-9e02";

const offline = (async () => {
  throw new Error("connect ECONNREFUSED 127.0.0.1:8000");
}) as unknown as typeof fetch;

/** A local OpenAI-chat-compatible server that lists one model. */
function localServer(calls: string[] = []) {
  return (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (!url.endsWith("/models")) throw new Error(`Unexpected request ${url}`);
    return Response.json({
      data: [{ id: LOCAL_MODEL }],
      models: [
        {
          slug: LOCAL_MODEL,
          display_name: "Qwen 3.5 9B",
          supported_reasoning_levels: ["none", "low", "medium", "high"].map((effort) => ({
            effort,
          })),
        },
      ],
    });
  }) as unknown as typeof fetch;
}

async function captured<T>(name: string, callback: () => Promise<T>) {
  const directory = resolve(`.session-artifacts/acp-catalog/${name}-${crypto.randomUUID()}`);
  const result = await withFixtureDiagnostics(directory, {}, callback);
  const text = await Bun.file(`${directory}/diagnostics.jsonl`).text();
  const logs = text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  await rm(directory, { recursive: true, force: true });
  return { result, logs, text };
}

async function workspace() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "labkit-acp-catalog-")));
  return { cwd: root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const signal = () => new AbortController().signal;

function select(bindings: readonly AcpConfigBinding[], id: string) {
  const binding = bindings.find(
    (entry): entry is AcpSelectBinding => entry.type !== "boolean" && entry.id === id,
  );
  if (!binding) throw new Error(`Missing ${id} selector`);
  return binding;
}

type Choice = { group?: string; value: string; name: string; description?: string | null };

function values(state: { configOptions?: SessionConfigOption[] }, id: string) {
  const option = state.configOptions?.find((entry) => entry.id === id);
  if (option?.type !== "select") throw new Error(`Missing ${id} state`);
  const options: Choice[] = [];
  for (const entry of option.options) {
    if ("group" in entry)
      for (const choice of entry.options) options.push({ group: entry.group, ...choice });
    else options.push({ ...entry });
  }
  return { current: option.currentValue, options };
}

test("catalog selectors group models by provider and derive thinking and output limits from the current model", async () => {
  const f = await workspace();
  try {
    const { logs, text } = await captured("selectors", async () => {
      const agent = workspaceAgent(
        { ANTHROPIC_API_KEY: ANTHROPIC_SECRET, OPENAI_API_KEY: OPENAI_SECRET },
        undefined,
        { fetch: localServer() },
      );
      const options = await agent.sessionOptions({ cwd: f.cwd, signal: signal() });
      expect(options.configuration.policy).toMatchObject({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        thinking: "off",
        maxOutputTokens: 32768,
        stream: true,
        permissions: "ask",
        toolFailure: "return-error-and-continue",
      });
      expect([...(options.bindings.providers?.keys() ?? [])]).toEqual([
        "anthropic",
        "openai",
        "localhost",
      ]);
      expect(JSON.stringify(options.configuration)).not.toContain(ANTHROPIC_SECRET);
      const config = bindConfig(options.config, true);
      const session = await createSession({
        ...options,
        bindings: {
          ...options.bindings,
          requestPermission: async () => ({ outcome: { outcome: "cancelled" as const } }),
        },
      });
      const choose = async (id: string, value: string) => {
        const patch = configPatch(select(config, id), value, session.policy!);
        if (!patch) throw new Error(`${id}=${value} is not offered`);
        expect((await session.updatePolicy(patch)).kind).toBe("accepted");
        return patch;
      };
      const state = () => configState(config, session.policy);
      try {
        const models = values(state(), "model");
        expect(models.current).toBe("anthropic/claude-sonnet-4-6");
        expect(new Set(models.options.map((option) => option.group))).toEqual(
          new Set(["anthropic", "openai", "localhost"]),
        );
        expect(models.options).toContainEqual({
          group: "anthropic",
          value: "anthropic/claude-sonnet-5",
          name: "Claude Sonnet 5",
        });
        expect(models.options).toContainEqual({
          group: "localhost",
          value: `localhost/${LOCAL_MODEL}`,
          name: "Qwen 3.5 9B",
        });
        const model = state().configOptions?.find((option) => option.id === "model");
        expect(model?.type === "select" && model.options.map((group) => group.name)).toEqual([
          "Anthropic",
          "OpenAI",
          "Localhost",
        ]);

        await choose("model", "anthropic/claude-sonnet-5");
        await choose("thinking", "adaptive");
        expect(values(state(), "thinking")).toEqual({
          current: "adaptive",
          options: [
            { value: "off", name: "Off" },
            { value: "adaptive", name: "Adaptive" },
          ],
        });
        await choose("max_output_tokens", "128000");
        expect(values(state(), "max_output_tokens").options.map((option) => option.value)).toEqual([
          "4096",
          "8192",
          "16384",
          "32768",
          "65536",
          "128000",
        ]);

        // Sonnet 4.5 is manual-budget only: adaptive falls back to off and the limit is clamped.
        expect(await choose("model", "anthropic/claude-sonnet-4-5")).toEqual({
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          thinking: "off",
          thinkingBudgetTokens: null,
          maxOutputTokens: 64000,
        });
        expect(values(state(), "thinking").options.map((option) => option.value)).toEqual([
          "off",
          "budget:1024",
          "budget:4096",
          "budget:8192",
          "budget:16384",
        ]);
        expect(values(state(), "max_output_tokens").options.map((option) => option.value)).toEqual([
          "4096",
          "8192",
          "16384",
          "32768",
          "64000",
        ]);
        await choose("thinking", "budget:16384");
        expect(session.policy).toMatchObject({ thinking: "budget", thinkingBudgetTokens: 16384 });
        // Output limits that would leave no room for the answer are not offered.
        expect(values(state(), "max_output_tokens").options.map((option) => option.value)).toEqual([
          "32768",
          "64000",
        ]);

        // The local model has no budget thinking; the budget is cleared and effort offered.
        await choose("model", `localhost/${LOCAL_MODEL}`);
        expect(session.policy).toMatchObject({
          provider: "localhost",
          model: LOCAL_MODEL,
          thinking: "off",
          thinkingBudgetTokens: null,
          maxOutputTokens: 64000,
        });
        expect(values(state(), "thinking").options.map((option) => option.value)).toEqual([
          "off",
          "low",
          "medium",
          "high",
        ]);
        await choose("thinking", "medium");

        // Fable is always on: no "off" choice, and switching to it enables thinking.
        await choose("model", "anthropic/claude-fable-5");
        expect(session.policy).toMatchObject({ thinking: "adaptive", maxOutputTokens: 64000 });
        expect(values(state(), "thinking").options.map((option) => option.value)).toEqual([
          "adaptive",
        ]);
        // Effort levels carry over between models that offer them.
        await choose("model", `localhost/${LOCAL_MODEL}`);
        await choose("thinking", "high");
        await choose("model", "openai/gpt-5.4");
        expect(session.policy).toMatchObject({ provider: "openai", thinking: "high" });
        // A carried-over limit the new model accepts stays a listed choice, not a saved value.
        expect(values(state(), "max_output_tokens")).toMatchObject({
          current: "64000",
          options: expect.arrayContaining([expect.objectContaining({ value: "64000" })]),
        });
        expect(JSON.stringify(state())).not.toContain("(saved)");
      } finally {
        await session.close();
      }
    });
    const loaded = logs.find((line) => line.event === "acp.catalog.loaded");
    expect(loaded).toMatchObject({
      level: "info",
      source: "https://models.dev/catalog.json",
      providers: [
        { id: "anthropic", label: "Anthropic", credential: "ANTHROPIC_API_KEY" },
        { id: "openai", label: "OpenAI", credential: "OPENAI_API_KEY" },
        { id: "localhost", label: "Localhost", models: 1 },
      ],
      skipped: [
        {
          id: "google",
          checked: ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"],
        },
        { id: "xai", checked: ["XAI_API_KEY"] },
      ],
      localhost: { status: "available", baseUrl: "http://localhost:8000/v1" },
    });
    expect(text).not.toContain(ANTHROPIC_SECRET);
    expect(text).not.toContain(OPENAI_SECRET);
    expect(text).not.toContain(`Bearer ${OPENAI_SECRET}`);
  } finally {
    await f.cleanup();
  }
});

test("LABKIT_ACP_MODEL selects the initial model; an unknown value falls back with a warning", async () => {
  const f = await workspace();
  try {
    const initial = async (requested: string) => {
      const agent = workspaceAgent(
        {
          ANTHROPIC_API_KEY: ANTHROPIC_SECRET,
          OPENAI_API_KEY: OPENAI_SECRET,
          LABKIT_ACP_MODEL: requested,
        },
        undefined,
        { fetch: localServer() },
      );
      const options = await agent.sessionOptions({ cwd: f.cwd, signal: signal() });
      return options.configuration.policy as Partial<Policy>;
    };
    const { result, logs, text } = await captured("default-model", async () => ({
      qualified: await initial("openai/gpt-5.4"),
      bare: await initial("claude-sonnet-5"),
      local: await initial(LOCAL_MODEL),
      unknown: await initial("anthropic/claude-nonexistent"),
    }));
    // Effort-profile models omit thinking when it is off, matching the web console.
    expect(result.qualified).toMatchObject({ provider: "openai", model: "gpt-5.4" });
    expect(result.qualified.thinking).toBeUndefined();
    expect(result.bare).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5" });
    expect(result.local).toMatchObject({ provider: "localhost", model: LOCAL_MODEL });
    expect(result.local.maxOutputTokens).toBe(32768);
    expect(result.unknown).toMatchObject({ provider: "anthropic", model: "claude-sonnet-4-6" });
    const unresolved = logs.filter((line) => line.event === "acp.catalog.default_model_unresolved");
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]).toMatchObject({
      level: "warning",
      requested: "anthropic/claude-nonexistent",
      fallbackProvider: "anthropic",
      fallbackModel: "claude-sonnet-4-6",
      consequence: expect.stringContaining("anthropic/claude-sonnet-4-6"),
    });
    expect(text).not.toContain(ANTHROPIC_SECRET);
    expect(text).not.toContain(OPENAI_SECRET);
  } finally {
    await f.cleanup();
  }
});

test("discovery is lazy and once; without any provider, session creation names what was checked", async () => {
  const f = await workspace();
  try {
    const { logs } = await captured("discovery", async () => {
      const calls: string[] = [];
      const agent = workspaceAgent({ ANTHROPIC_API_KEY: ANTHROPIC_SECRET }, undefined, {
        fetch: localServer(calls),
      });
      expect(calls).toEqual([]);
      await agent.sessionOptions({ cwd: f.cwd, signal: signal() });
      await agent.sessionOptions({ cwd: f.cwd, signal: signal() });
      expect(calls).toEqual(["http://localhost:8000/v1/models"]);

      const none = workspaceAgent({}, undefined, { fetch: offline });
      const failure = await Promise.resolve()
        .then(() => none.sessionOptions({ cwd: f.cwd, signal: signal() }))
        .then(
          () => undefined,
          (error: Error) => error.message,
        );
      for (const name of [
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "GOOGLE_API_KEY",
        "GEMINI_API_KEY",
        "XAI_API_KEY",
        "http://localhost:8000/v1",
        "ECONNREFUSED",
      ])
        expect(failure).toContain(name);

      const refused = (async () =>
        new Response("down", { status: 503 })) as unknown as typeof fetch;
      const custom = workspaceAgent(
        { OPENAI_API_KEY: OPENAI_SECRET, LABKIT_LOCAL_BASE_URL: "http://127.0.0.1:9999/v1" },
        undefined,
        { fetch: refused },
      );
      const options = await custom.sessionOptions({ cwd: f.cwd, signal: signal() });
      expect([...(options.bindings.providers?.keys() ?? [])]).toEqual(["openai"]);
    });
    const unavailable = logs.filter((line) => line.event === "acp.catalog.localhost_unavailable");
    expect(unavailable).toEqual([
      expect.objectContaining({
        level: "info",
        baseUrl: "http://localhost:8000/v1",
        reason: expect.stringContaining("ECONNREFUSED"),
      }),
      expect.objectContaining({
        level: "info",
        baseUrl: "http://127.0.0.1:9999/v1",
        status: 503,
      }),
    ]);
    expect(logs.filter((line) => line.event === "acp.catalog.loaded")).toHaveLength(3);
  } finally {
    await f.cleanup();
  }
});
