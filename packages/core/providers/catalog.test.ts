import { expect, test } from "@logtape/testing-bun/autoload";

import { catalogProviders, localhostProvider } from "./index.ts";

function anthropicModel(id: string) {
  const provider = catalogProviders({ ANTHROPIC_API_KEY: "sk-test" }).providers.find(
    (entry) => entry.id === "anthropic",
  );
  const model = provider?.models.find((entry) => entry.id === id);
  if (!model) throw new Error(`catalog lacks ${id}`);
  return model;
}

test("adaptive Anthropic models bind anthropic-messages@4 with off/adaptive thinking", () => {
  const model = anthropicModel("claude-sonnet-5");
  expect(model.profile.id).toBe("anthropic-messages@4");
  expect(model.thinking).toEqual(["off", "adaptive"]);
  expect(model.thinkingBudgetMin).toBeUndefined();
});

test("budget-only Anthropic models bind anthropic-messages@3 with an explicit budget floor", () => {
  const model = anthropicModel("claude-sonnet-4-5");
  expect(model.profile.id).toBe("anthropic-messages@3");
  expect(model.thinking).toEqual(["off", "budget"]);
  expect(model.thinkingBudgetMin).toBe(1024);
});

test("providers without a key are skipped with the env var names that were checked", () => {
  const { providers, skipped } = catalogProviders({
    ANTHROPIC_API_KEY: "sk-test",
    XAI_API_KEY: "",
  });
  expect(providers.map((provider) => provider.id)).toEqual(["anthropic"]);
  expect(providers[0]?.credential).toBe("ANTHROPIC_API_KEY");
  expect(skipped).toEqual([
    { id: "openai", checked: ["OPENAI_API_KEY"] },
    {
      id: "google",
      checked: ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"],
    },
    { id: "xai", checked: ["XAI_API_KEY"] },
  ]);
});

test("a key under a provider's later env name binds that provider", () => {
  const { providers } = catalogProviders({ GEMINI_API_KEY: "gm-test" });
  const google = providers.find((provider) => provider.id === "google");
  expect(google?.credential).toBe("GEMINI_API_KEY");
  expect(google?.headers).toEqual({ "x-goog-api-key": "gm-test" });
  expect(google?.defaultModel).toBe("gemini-2.5-flash");
  expect(google?.models.every((model) => model.profile.id === "google-generate@3")).toBe(true);
});

test("localhost maps the server's model list onto the chat profile", async () => {
  const requested: string[] = [];
  const result = await localhostProvider({
    baseUrl: "http://local.test/v1",
    fetch: (async (input: string | URL | Request) => {
      requested.push(String(input));
      return Response.json({
        data: [{ id: "ignored-when-models-present" }],
        models: [
          {
            slug: "mlx-community/Qwen3.5-9B-MLX-4bit",
            display_name: "Qwen 3.5 9B",
            supported_reasoning_levels: [
              { effort: "none" },
              { effort: "low" },
              { effort: "medium" },
              { effort: "high" },
            ],
          },
          { slug: "hidden", supported_in_api: false },
        ],
      });
    }) as typeof fetch,
  });
  expect(requested).toEqual(["http://local.test/v1/models"]);
  if (result.kind !== "available") throw new Error(result.reason);
  expect(result.provider).toMatchObject({
    id: "localhost",
    baseUrl: "http://local.test/v1",
    headers: {},
    defaultModel: "mlx-community/Qwen3.5-9B-MLX-4bit",
  });
  expect(result.provider.credential).toBeUndefined();
  expect(result.provider.models).toHaveLength(1);
  expect(result.provider.models[0]).toMatchObject({
    id: "mlx-community/Qwen3.5-9B-MLX-4bit",
    label: "Qwen 3.5 9B",
    wireModel: "mlx-community/Qwen3.5-9B-MLX-4bit",
    thinking: ["off", "low", "medium", "high"],
    omitThinkingWhenOff: true,
  });
  expect(result.provider.models[0]?.profile.id).toBe("openai-chat@2");
});

test("localhost reports a non-2xx answer as unavailable with its status", async () => {
  const result = await localhostProvider({
    baseUrl: "http://local.test/v1",
    fetch: (async () => new Response("down", { status: 503 })) as unknown as typeof fetch,
  });
  expect(result).toEqual({
    kind: "unavailable",
    baseUrl: "http://local.test/v1",
    reason: "GET /models answered HTTP 503",
    status: 503,
  });
});

test("localhost reports a network error as unavailable without throwing", async () => {
  const result = await localhostProvider({
    baseUrl: "http://local.test/v1",
    fetch: (async () => {
      throw new TypeError("connection refused");
    }) as unknown as typeof fetch,
  });
  expect(result).toEqual({
    kind: "unavailable",
    baseUrl: "http://local.test/v1",
    reason: "connection refused",
  });
});
