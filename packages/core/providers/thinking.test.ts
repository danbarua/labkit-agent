import { expect, test } from "@logtape/testing-bun/autoload";

import { PreparedModelSchema } from "../agent/agent.ts";
import {
  anthropicMessages,
  anthropicMessagesV2,
  bindProviders,
  CompletionRequestSchema,
  ContinuationSchema,
  googleGenerate,
  openaiChat,
  openaiResponses,
  parseRequest,
} from "./index.ts";

const response = (content: unknown[]) => ({
  status: 200,
  headers: new Headers(),
  body: { role: "assistant", stop_reason: "tool_use", content },
});

const thinking = (signature: string) => ({ type: "thinking", thinking: "private", signature });

const request = CompletionRequestSchema.parse({
  model: "claude-sonnet-4-5",
  messages: [{ role: "user", text: "Go" }],
  tools: [],
  successors: [],
  thinking: "budget",
  maxOutputTokens: 2048,
});

test("Anthropic v2 exact adaptive body and off default", () => {
  expect(anthropicMessagesV2.encode(request).body).toEqual({
    model: request.model,
    max_tokens: 2048,
    system: [],
    messages: [{ role: "user", content: [{ type: "text", text: "Go" }] }],
    tools: [],
    thinking: { type: "enabled", budget_tokens: 1024 },
    stream: false,
  });
  expect(
    anthropicMessagesV2.encode({ ...request, thinking: "off", maxOutputTokens: undefined }).body,
  ).toMatchObject({ max_tokens: 1024, thinking: { type: "disabled" } });
  for (const maxOutputTokens of [undefined, 1024, 1])
    expect(() => anthropicMessagesV2.encode({ ...request, maxOutputTokens })).toThrow(
      "maxOutputTokens",
    );
});

test("two owners replay their own blocks even when envelopes arrive reversed", () => {
  const owners = [
    { turnId: "turn", generation: 2 },
    { turnId: "turn", generation: 5 },
  ];
  const continuations = owners.map((owner, i) =>
    ContinuationSchema.parse({
      provider: anthropicMessagesV2.id,
      owner,
      payload: { blocks: [thinking(String(i))] },
    }),
  );
  const input = CompletionRequestSchema.parse({
    ...request,
    messages: [
      request.messages[0],
      ...owners.flatMap((owner, i) => [
        {
          role: "assistant",
          owner,
          text: "work",
          calls: [{ id: String(i), name: "echo", args: {} }],
        },
        { role: "tool", callId: String(i), text: "ok" },
      ]),
    ],
    continuations: continuations.toReversed(),
  });
  const body = anthropicMessagesV2.encode(input).body as { messages: { content: unknown[] }[] };
  for (const i of [0, 1])
    expect(body.messages[1 + i * 2]?.content).toEqual([
      thinking(String(i)),
      { type: "text", text: "work" },
      { type: "tool_use", id: String(i), name: "echo", input: {} },
    ]);
});

test("decode preserves signed/redacted bytes and rejects unsigned payloads; large payloads reach session storage", () => {
  const blocks = [thinking("sig"), { type: "redacted_thinking", data: "opaque" }];
  expect(anthropicMessagesV2.decode(response([...blocks, { type: "text", text: "done" }]))).toEqual(
    { completion: { kind: "answer", text: "done" }, continuationPayload: { blocks } },
  );
  expect(() =>
    anthropicMessagesV2.decode(response([{ type: "thinking", thinking: "unsigned" }])),
  ).toThrow();
  expect(
    anthropicMessagesV2.decode(response([thinking("x".repeat(70000))])).continuationPayload,
  ).toEqual({ blocks: [thinking("x".repeat(70000))] });
});

test("capability intersection rejects before HTTP and chat maps effort", async () => {
  for (const profile of [anthropicMessages, openaiChat, openaiResponses, googleGenerate]) {
    let calls = 0;
    const port = bindProviders(
      new Map([
        [
          profile.id,
          {
            profile,
            transport: {
              baseUrl: "https://example.invalid",
              fetch: (async () => {
                calls++;
                return Response.json({});
              }) as unknown as typeof fetch,
            },
          },
        ],
      ]),
    );
    await expect(
      port.complete(
        PreparedModelSchema.parse({
          model: "test",
          messages: [],
          provider: profile.id,
          thinking: "budget",
        }),
        new AbortController().signal,
      ),
    ).rejects.toThrow("Unsupported thinking");
    expect(calls).toBe(0);
  }
  for (const thinking of ["low", "medium", "high"] as const)
    expect(
      openaiChat.encode({
        model: "openai-chat-test-model",
        messages: [{ role: "user", text: "Go" }],
        tools: [],
        successors: [],
        thinking,
      }).body,
    ).toMatchObject({
      reasoning_effort: thinking,
    });
});

test("parseRequest rejects orphan and foreign-provider continuations", () => {
  const continuation = ContinuationSchema.parse({
    provider: anthropicMessagesV2.id,
    owner: { turnId: "turn", generation: 2 },
    payload: { blocks: [thinking("sig")] },
  });
  const input = CompletionRequestSchema.parse({
    ...request,
    provider: anthropicMessagesV2.id,
    messages: [{ role: "assistant", owner: continuation.owner, text: "answer" }],
    continuations: [continuation],
  });
  expect(parseRequest(input).continuations).toEqual([continuation]);
  expect(() => parseRequest({ ...input, messages: request.messages })).toThrow("no assistant");
  expect(() =>
    parseRequest({
      ...input,
      continuations: [{ ...continuation, owner: { ...continuation.owner, generation: 3 } }],
    }),
  ).toThrow("no assistant");
  expect(() => parseRequest({ ...input, provider: googleGenerate.id })).toThrow("provider");
  expect(() => parseRequest({ ...input, provider: undefined })).toThrow("provider");
  expect(() => anthropicMessagesV2.encode({ ...input, provider: googleGenerate.id })).toThrow(
    "provider",
  );
  expect(() => googleGenerate.encode({ ...input, provider: undefined, thinking: "off" })).toThrow(
    "provider",
  );
});

test("Anthropic refuses adjacent assistant merges involving thinking and preserves plain merges", () => {
  const continuations = [2, 5].map((generation) =>
    ContinuationSchema.parse({
      provider: anthropicMessagesV2.id,
      owner: { turnId: "turn", generation },
      payload: { blocks: [thinking(String(generation))] },
    }),
  );
  const input = CompletionRequestSchema.parse({
    ...request,
    messages: continuations.map((entry, i) => ({
      role: "assistant",
      owner: entry.owner,
      text: `answer ${i}`,
    })),
    continuations: continuations.toReversed(),
  });
  for (const entries of [
    input.continuations,
    continuations.slice(0, 1),
    continuations.slice(1),
    [
      {
        ...continuations[0]!,
        payload: { blocks: [{ type: "redacted_thinking", data: "opaque" }] },
      },
    ],
  ])
    expect(() => anthropicMessagesV2.encode({ ...input, continuations: entries })).toThrow(
      "Cannot merge adjacent assistant",
    );
  expect(anthropicMessagesV2.encode({ ...input, continuations: [] }).body).toMatchObject({
    messages: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "answer 0" },
          { type: "text", text: "answer 1" },
        ],
      },
    ],
  });
});

test("orphan and foreign continuations fail before fetch at the transport boundary", async () => {
  let calls = 0;
  const port = bindProviders(
    new Map([
      [
        anthropicMessagesV2.id,
        {
          profile: anthropicMessagesV2,
          transport: {
            baseUrl: "https://example.invalid",
            fetch: (async () => {
              calls++;
              return Response.json({});
            }) as unknown as typeof fetch,
          },
        },
      ],
    ]),
  );
  const continuation = ContinuationSchema.parse({
    provider: anthropicMessagesV2.id,
    owner: { turnId: "turn", generation: 2 },
    payload: { blocks: [thinking("sig")] },
  });
  for (const patch of [
    { messages: [{ role: "user", content: "Go" }], continuations: [continuation] },
    {
      messages: [{ role: "assistant", owner: continuation.owner, content: "answer" }],
      continuations: [{ ...continuation, provider: googleGenerate.id }],
    },
  ])
    await expect(
      port.complete(
        PreparedModelSchema.parse({ model: "test", provider: anthropicMessagesV2.id, ...patch }),
        new AbortController().signal,
      ),
    ).rejects.toThrow("Continuation");
  expect(calls).toBe(0);
});
