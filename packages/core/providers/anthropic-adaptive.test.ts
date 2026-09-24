import { expect, test } from "@logtape/testing-bun/autoload";

import { PreparedModelSchema } from "../agent/agent.ts";
import {
  anthropicMessagesV3,
  anthropicMessagesV4,
  bindProviders,
  CompletionRequestSchema,
} from "./index.ts";
import { streamResponse, streamVector } from "./testing/stream-vectors.ts";

const request = CompletionRequestSchema.parse({
  model: "claude-sonnet-5",
  messages: [],
  tools: [],
  successors: [],
  thinking: "adaptive",
});
test("native adaptive thinking has its own wire version, with no manual budget requirement", () => {
  for (const stream of [false, true]) {
    expect(anthropicMessagesV4.encode({ ...request, stream }).body).toMatchObject({
      thinking: { type: "adaptive" },
      max_tokens: 1024,
      stream,
    });
    expect(JSON.stringify(anthropicMessagesV4.encode({ ...request, stream }).body)).not.toContain(
      "budget_tokens",
    );
    expect(
      anthropicMessagesV3.encode({ ...request, thinking: "budget", maxOutputTokens: 4096, stream })
        .body,
    ).toMatchObject({ thinking: { type: "enabled", budget_tokens: 1024 } });
  }
  for (const thinking of [undefined, "off"] as const) {
    expect(anthropicMessagesV4.encode({ ...request, thinking }).body).toMatchObject({
      thinking: { type: "disabled" },
    });
  }
  expect(() => anthropicMessagesV3.encode({ ...request, thinking: "budget" })).toThrow(
    "maxOutputTokens",
  );
});

test("native adaptive streaming preserves signed tool continuation and exact provider ownership", async () => {
  const profile = anthropicMessagesV4;
  const port = bindProviders(
    new Map([
      [
        profile.id,
        {
          profile,
          transport: {
            baseUrl: "https://example.invalid",
            fetch: (async (_url, init) => {
              expect(JSON.parse(String(init?.body))).toMatchObject({
                thinking: { type: "adaptive" },
                stream: true,
              });
              return streamResponse(streamVector(anthropicMessagesV3, true));
            }) as typeof fetch,
          },
        },
      ],
    ]),
  );
  const result = await port.complete(
    PreparedModelSchema.parse({
      provider: profile.id,
      model: request.model,
      messages: [],
      thinking: "adaptive",
      stream: true,
    }),
    new AbortController().signal,
  );
  expect(result.completion).toMatchObject({ kind: "tools" });
  const owner = { turnId: "turn-1", generation: 2 };
  const replay = CompletionRequestSchema.parse({
    ...request,
    provider: profile.id,
    messages: [{ role: "assistant" as const, text: "Hello", owner }],
    continuations: [{ provider: profile.id, owner, payload: result.continuationPayload! }],
  });
  expect(JSON.stringify(profile.encode(replay).body)).toContain('"signature":"signature"');
  expect(() =>
    profile.encode({
      ...replay,
      continuations: replay.continuations!.map((entry) => ({
        ...entry,
        provider: anthropicMessagesV3.id,
      })),
    }),
  ).toThrow();
});
