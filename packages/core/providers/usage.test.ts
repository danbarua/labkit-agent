import { expect, test } from "@logtape/testing-bun/autoload";

import { decodeUsage } from "./usage.ts";

test("token accounting includes Anthropic cache input without double counting OpenAI or Google cache", () => {
  expect(
    decodeUsage(
      {
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 20,
          output_tokens: 30,
          cache_creation: { ephemeral_5m_input_tokens: 20 },
        },
      },
      "anthropic",
    ),
  ).toMatchObject({
    inputTokens: 130,
    outputTokens: 30,
    totalTokens: 160,
    native: { cache_creation: { ephemeral_5m_input_tokens: 20 } },
  });
  expect(
    decodeUsage(
      {
        usage: {
          prompt_tokens: 100,
          completion_tokens: 30,
          total_tokens: 130,
          prompt_tokens_details: { cached_tokens: 80 },
          completion_tokens_details: { reasoning_tokens: 10 },
        },
      },
      "chat",
    ),
  ).toMatchObject({ inputTokens: 100, outputTokens: 30, totalTokens: 130 });
  expect(
    decodeUsage(
      {
        usage: {
          input_tokens: 100,
          output_tokens: 30,
          total_tokens: 130,
          input_tokens_details: { cached_tokens: 80 },
        },
      },
      "responses",
    ),
  ).toMatchObject({ inputTokens: 100, outputTokens: 30, totalTokens: 130 });
  expect(
    decodeUsage(
      {
        usageMetadata: {
          promptTokenCount: 100,
          cachedContentTokenCount: 80,
          candidatesTokenCount: 20,
          thoughtsTokenCount: 10,
          totalTokenCount: 130,
        },
      },
      "google",
    ),
  ).toMatchObject({ inputTokens: 100, outputTokens: 30, totalTokens: 130 });
});

test("missing counts stay unknown; malformed or overflowing counts remain explicitly invalid", () => {
  expect(decodeUsage({}, "chat")).toBeUndefined();
  expect(decodeUsage({ usage: { output_tokens: 3 } }, "anthropic")).toEqual({
    status: "reported",
    outputTokens: 3,
    native: { output_tokens: 3 },
  });
  for (const input_tokens of [-1, 0.5, "10", Number.MAX_SAFE_INTEGER + 1])
    expect(decodeUsage({ usage: { input_tokens } }, "anthropic")).toMatchObject({
      status: "invalid",
      error: expect.stringContaining("usage.input_tokens"),
      native: { input_tokens },
    });
  expect(
    decodeUsage(
      {
        usage: {
          input_tokens: Number.MAX_SAFE_INTEGER,
          cache_read_input_tokens: 1,
        },
      },
      "anthropic",
    ),
  ).toMatchObject({ status: "invalid" });
});

test("all streaming dialects expose only their fully assembled response accounting", async () => {
  const { PreparedModelSchema } = await import("../agent/agent.ts");
  const { bindProviders } = await import("./transport.ts");
  const { streamingProfiles, streamResponse, streamVector } =
    await import("./testing/stream-vectors.ts");
  for (const profile of streamingProfiles) {
    const frames = streamVector(profile);
    const makePort = (truncated: boolean) =>
      bindProviders(
        new Map([
          [
            "selected",
            {
              profile,
              transport: {
                baseUrl: "https://scripted.invalid",
                fetch: (async (_url: RequestInfo | URL) =>
                  streamResponse(truncated ? frames.slice(0, -1) : frames)) as typeof fetch,
              },
            },
          ],
        ]),
      );
    const request = PreparedModelSchema.parse({
      provider: "selected",
      model: "deployment",
      maxOutputTokens: 16384,
      stream: true,
      messages: [{ role: "user", content: "Read the supplied document" }],
      successors: [],
    });
    const response = await makePort(false).complete(request, new AbortController().signal);
    expect(response.usage).toMatchObject({
      outputTokens: 4,
      source: {
        provider: "selected",
        model: "deployment",
        wireModel: "deployment",
        profile: profile.id,
      },
    });
    await expect(makePort(true).complete(request, new AbortController().signal)).rejects.toThrow();
  }
});
