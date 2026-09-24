import { expect, test } from "@logtape/testing-bun/autoload";

import { PreparedModelSchema } from "../agent/agent.ts";
import { deferred } from "../agent/test-support.ts";
import { openaiChat } from "./openai-chat.ts";
import { bindProviders, httpTransport } from "./transport.ts";

const prepared = PreparedModelSchema.parse({
  provider: openaiChat.id,
  model: "m",
  messages: [{ role: "user", content: "hi" }],
  successors: ["b"],
});
test("bindings copy credentials and registries, issue one request, and keep secrets off domain values", async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const headers = { Authorization: "Bearer SECRET" };
  const binding = {
    profile: openaiChat,
    transport: {
      baseUrl: "https://example.invalid/v1",
      headers,
      fetch: (async (url, init) => {
        requests.push({ url: String(url), init });
        return Response.json({ choices: [{ message: { content: "done" } }] });
      }) as typeof fetch,
    },
  };
  const registry = new Map([[openaiChat.id, binding]]);
  const port = bindProviders(registry);
  registry.clear();
  headers.Authorization = "changed";
  expect(await port.complete(prepared, new AbortController().signal)).toEqual({
    completion: { kind: "answer", text: "done" },
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]!.url).toBe("https://example.invalid/v1/chat/completions");
  expect(requests[0]!.init?.headers).toMatchObject({ Authorization: "Bearer SECRET" });
  expect(JSON.stringify(prepared)).not.toContain("SECRET");
  expect(JSON.stringify(prepared)).not.toContain("baseUrl");
});
test("HTTP failure never retries and retains provider body; invalid JSON fails", async () => {
  let calls = 0;
  const http = httpTransport({
    baseUrl: "https://example.invalid/v1",
    fetch: (async () => {
      calls++;
      return new Response("SECRET", { status: 503 });
    }) as unknown as typeof fetch,
  });
  await expect(
    http({ path: "/test", method: "POST", headers: {}, body: {} }, new AbortController().signal),
  ).rejects.toThrow("Completion HTTP failure (503)");
  expect(calls).toBe(1);
  const invalid = httpTransport({
    baseUrl: "https://example.invalid/v1",
    fetch: (async () => new Response("{")) as unknown as typeof fetch,
  });
  await expect(
    invalid({ path: "/test", method: "POST", headers: {}, body: {} }, new AbortController().signal),
  ).rejects.toThrow("not valid JSON");
});
test("cancellation reaches fetch and rejects a late response", async () => {
  const pending = deferred<Response>();
  let seen: AbortSignal | null | undefined;
  const http = httpTransport({
    baseUrl: "https://example.invalid",
    fetch: (async (_url, init) => {
      seen = init?.signal;
      return pending.promise;
    }) as typeof fetch,
  });
  const controller = new AbortController();
  const result = http({ path: "/test", method: "POST", headers: {}, body: {} }, controller.signal);
  controller.abort();
  pending.resolve(Response.json({}));
  await expect(result).rejects.toThrow();
  expect(seen).toBe(controller.signal);
  expect(seen?.aborted).toBe(true);
});
test("unadvertised handoffs are rejected at the binding boundary", async () => {
  const port = bindProviders(
    new Map([
      [
        openaiChat.id,
        {
          profile: openaiChat,
          transport: {
            baseUrl: "https://example.invalid",
            fetch: (async () =>
              Response.json({
                choices: [
                  {
                    message: {
                      tool_calls: [
                        {
                          id: "h",
                          type: "function",
                          function: { name: "handoff_to", arguments: '{"agent":"c"}' },
                        },
                      ],
                    },
                  },
                ],
              })) as unknown as typeof fetch,
          },
        },
      ],
    ]),
  );
  await expect(port.complete(prepared, new AbortController().signal)).rejects.toThrow(
    "Unpermitted handoff",
  );
});

test("prepared domain input rejects transport resources and credentials", () => {
  for (const extra of [
    { baseUrl: "https://example.invalid" },
    { apiKey: "SECRET" },
    { signal: new AbortController().signal },
  ])
    expect(PreparedModelSchema.safeParse({ ...prepared, ...extra }).success).toBe(false);
});

test("provider diagnostics retain correlated HTTP causes while excluding credential echoes", async () => {
  const { getLogger } = await import("@logtape/logtape");
  const { spyOn } = await import("bun:test");
  const logger = getLogger(["labkit", "provider"]);
  const warning = spyOn(logger, "emit");
  const debug = warning;
  try {
    const port = bindProviders(
      new Map([
        [
          openaiChat.id,
          {
            profile: openaiChat,
            transport: {
              baseUrl: "https://example.invalid/v1",
              headers: { "x-api-key": "private-key-value" },
              fetch: (async () =>
                Response.json(
                  {
                    error: {
                      type: "invalid_request_error",
                      message: "budget invalid; key private-key-value",
                    },
                  },
                  { status: 400, headers: { "request-id": "provider-123" } },
                )) as unknown as typeof fetch,
            },
          },
        ],
      ]),
    );
    await expect(
      port.complete(prepared, new AbortController().signal, undefined, undefined, {
        sessionId: "s",
        turnId: "t",
        childId: "c",
      }),
    ).rejects.toThrow("budget invalid; key [REDACTED]");
    const rejected = warning.mock.calls.find(
      ([event]) => event.rawMessage === "provider.http.rejected",
    );
    expect(rejected?.[0].properties).toMatchObject({
      sessionId: "s",
      turnId: "t",
      childId: "c",
      provider: openaiChat.id,
      model: "m",
      httpStatus: 400,
      providerRequestId: "provider-123",
    });
    expect(JSON.stringify(rejected)).toContain("invalid_request_error");
    expect(JSON.stringify(warning.mock.calls)).not.toContain("private-key-value");
    expect(debug.mock.calls.some(([event]) => event.rawMessage === "provider.http.started")).toBe(
      true,
    );
  } finally {
    warning.mockRestore();
    debug.mockRestore();
  }
});

test("provider success and decode failure logs preserve usage, limits and operation identities", async () => {
  const { getLogger } = await import("@logtape/logtape");
  const { spyOn } = await import("bun:test");
  const { anthropicMessagesV4 } = await import("./streaming-profiles.ts");
  const logger = getLogger(["labkit", "provider"]);
  const warning = spyOn(logger, "emit");
  const info = warning;
  try {
    const success = bindProviders(
      new Map([
        [
          openaiChat.id,
          {
            profile: openaiChat,
            transport: {
              baseUrl: "https://example.invalid",
              fetch: (async () =>
                Response.json({
                  choices: [{ finish_reason: "stop", message: { content: "done" } }],
                  usage: { completion_tokens: 7 },
                })) as unknown as typeof fetch,
            },
          },
        ],
      ]),
    );
    await success.complete(prepared, new AbortController().signal, undefined, undefined, {
      childId: "success",
    });
    expect(
      info.mock.calls.find(([event]) => event.rawMessage === "provider.completion.completed")?.[0]
        .properties,
    ).toMatchObject({
      childId: "success",
      completionKind: "answer",
      usage: { completion_tokens: 7 },
    });
    const profile = anthropicMessagesV4;
    const port = bindProviders(
      new Map([
        [
          profile.id,
          {
            profile,
            transport: {
              baseUrl: "https://example.invalid",
              fetch: (async () =>
                Response.json({
                  content: [],
                  stop_reason: "max_tokens",
                  usage: { output_tokens: 4096 },
                })) as unknown as typeof fetch,
            },
          },
        ],
      ]),
    );
    await expect(
      port.complete(
        { ...prepared, provider: profile.id, maxOutputTokens: 4096 },
        new AbortController().signal,
        undefined,
        undefined,
        { childId: "failed" },
      ),
    ).rejects.toThrow("max_tokens");
    expect(
      warning.mock.calls.find(([event]) => event.rawMessage === "provider.completion.failed")?.[0]
        .properties,
    ).toMatchObject({
      childId: "failed",
      phase: "decode",
      maxOutputTokens: 4096,
      stopReason: "max_tokens",
      usage: { output_tokens: 4096 },
    });
  } finally {
    warning.mockRestore();
    info.mockRestore();
  }
});

test("truncated streams and cancellation expose progress and never report completion", async () => {
  const { getLogger } = await import("@logtape/logtape");
  const { spyOn } = await import("bun:test");
  const { openaiChatV2 } = await import("./streaming-profiles.ts");
  const emitted = spyOn(getLogger(["labkit", "provider"]), "emit");
  try {
    const port = bindProviders(
      new Map([
        [
          openaiChatV2.id,
          {
            profile: openaiChatV2,
            transport: {
              baseUrl: "https://example.invalid",
              fetch: (async () =>
                new Response('data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n', {
                  headers: { "content-type": "text/event-stream" },
                })) as unknown as typeof fetch,
            },
          },
        ],
      ]),
    );
    await expect(
      port.complete(
        { ...prepared, provider: openaiChatV2.id, stream: true },
        new AbortController().signal,
        undefined,
        undefined,
        { childId: "truncated" },
      ),
    ).rejects.toThrow();
    const failure = emitted.mock.calls.find(
      ([record]) => record.rawMessage === "provider.stream.failed",
    )?.[0].properties;
    expect(failure).toMatchObject({ childId: "truncated", frames: 1, deltas: 1 });
    expect(failure?.bytes).toBeGreaterThan(0);
    expect(
      emitted.mock.calls.some(([record]) => record.rawMessage === "provider.completion.completed"),
    ).toBe(false);
    const controller = new AbortController();
    controller.abort(new Error("user cancelled review"));
    await expect(
      port.complete(
        { ...prepared, provider: openaiChatV2.id, stream: true },
        controller.signal,
        undefined,
        undefined,
        { childId: "cancelled" },
      ),
    ).rejects.toThrow("user cancelled review");
    expect(
      emitted.mock.calls.find(
        ([record]) => record.rawMessage === "provider.completion.cancelled",
      )?.[0].properties,
    ).toMatchObject({ childId: "cancelled", error: { message: "user cancelled review" } });
  } finally {
    emitted.mockRestore();
  }
});

test("SSE provider failures preserve actual reasons and upstream identity without credential echoes", async () => {
  const { getLogger } = await import("@logtape/logtape");
  const { spyOn } = await import("bun:test");
  const { anthropicMessagesV4, openaiResponsesV3 } = await import("./streaming-profiles.ts");
  const emitted = spyOn(getLogger(["labkit", "provider"]), "emit");
  try {
    for (const [profile, events, reason] of [
      [
        anthropicMessagesV4,
        [
          {
            type: "error",
            error: { type: "overloaded_error", message: "Overloaded for private-stream-key" },
          },
        ],
        "overloaded_error",
      ],
      [
        openaiResponsesV3,
        [
          { type: "response.created", response: { id: "r" } },
          {
            type: "response.failed",
            response: {
              id: "r",
              status: "failed",
              error: { code: "server_error", message: "retry private-stream-key" },
            },
          },
        ],
        "server_error",
      ],
      [
        openaiResponsesV3,
        [
          { type: "response.created", response: { id: "r" } },
          {
            type: "response.incomplete",
            response: {
              id: "r",
              status: "incomplete",
              incomplete_details: { reason: "max_output_tokens" },
            },
          },
        ],
        "max_output_tokens",
      ],
    ] as const) {
      const port = bindProviders(
        new Map([
          [
            profile.id,
            {
              profile,
              transport: {
                baseUrl: "https://example.invalid",
                headers: { "x-api-key": "private-stream-key" },
                fetch: (async () =>
                  new Response(
                    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
                    {
                      headers: {
                        "content-type": "text/event-stream",
                        "request-id": "upstream-stream",
                      },
                    },
                  )) as unknown as typeof fetch,
              },
            },
          ],
        ]),
      );
      const failure = await port
        .complete(
          { ...prepared, provider: profile.id, stream: true },
          new AbortController().signal,
          undefined,
          undefined,
          { childId: reason },
        )
        .catch((error) => error);
      expect(failure.message).toContain(reason);
      expect(failure.message).not.toContain("private-stream-key");
      const record = emitted.mock.calls.find(
        ([record]) =>
          record.rawMessage === "provider.stream.failed" && record.properties.childId === reason,
      )?.[0].properties;
      expect(record).toMatchObject({ providerRequestId: "upstream-stream", childId: reason });
      expect(JSON.stringify(record)).toContain(reason);
    }
    expect(JSON.stringify(emitted.mock.calls)).not.toContain("private-stream-key");
  } finally {
    emitted.mockRestore();
  }
});

test("stream summaries and completion diagnostics carry final Chat and Anthropic output usage", async () => {
  const { getLogger } = await import("@logtape/logtape");
  const { spyOn } = await import("bun:test");
  const { anthropicMessagesV4, openaiChatV2 } = await import("./streaming-profiles.ts");
  const emitted = spyOn(getLogger(["labkit", "provider"]), "emit");
  try {
    for (const [profile, events, expectedUsage] of [
      [
        openaiChatV2,
        [
          { choices: [{ index: 0, delta: { content: "answer" }, finish_reason: "stop" }] },
          { choices: [], usage: { completion_tokens: 19 } },
          "[DONE]",
        ],
        { completion_tokens: 19 },
      ],
      [
        anthropicMessagesV4,
        [
          {
            type: "message_start",
            message: {
              role: "assistant",
              content: [],
              usage: { input_tokens: 11, output_tokens: 1 },
            },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "answer" },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 23 },
          },
          { type: "message_stop" },
        ],
        { input_tokens: 11, output_tokens: 23 },
      ],
    ] as const) {
      const port = bindProviders(
        new Map([
          [
            profile.id,
            {
              profile,
              transport: {
                baseUrl: "https://example.invalid",
                fetch: (async () =>
                  new Response(
                    events
                      .map(
                        (event) =>
                          `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`,
                      )
                      .join(""),
                    { headers: { "content-type": "text/event-stream" } },
                  )) as unknown as typeof fetch,
              },
            },
          ],
        ]),
      );
      await port.complete(
        { ...prepared, provider: profile.id, stream: true },
        new AbortController().signal,
      );
      for (const event of ["provider.stream.completed", "provider.completion.completed"])
        expect(
          emitted.mock.calls.find(
            ([record]) => record.rawMessage === event && record.properties.provider === profile.id,
          )?.[0].properties,
        ).toMatchObject({ usage: expectedUsage, durationMs: expect.any(Number) });
    }
  } finally {
    emitted.mockRestore();
  }
});

test("rejected Chat and Google stream finish reasons remain diagnosable", async () => {
  const { getLogger } = await import("@logtape/logtape");
  const { spyOn } = await import("bun:test");
  const { openaiChatV2, googleGenerateV3 } = await import("./streaming-profiles.ts");
  const emitted = spyOn(getLogger(["labkit", "provider"]), "emit");
  try {
    for (const [profile, frame, reason] of [
      [
        openaiChatV2,
        {
          choices: [{ index: 0, delta: {}, finish_reason: "length" }],
          usage: { completion_tokens: 4096 },
        },
        "length",
      ],
      [
        googleGenerateV3,
        {
          candidates: [{ finishReason: "MAX_TOKENS" }],
          usageMetadata: { candidatesTokenCount: 4096 },
        },
        "MAX_TOKENS",
      ],
    ] as const) {
      const port = bindProviders(
        new Map([
          [
            profile.id,
            {
              profile,
              transport: {
                baseUrl: "https://example.invalid",
                fetch: (async () =>
                  new Response(`data: ${JSON.stringify(frame)}\n\n`, {
                    headers: { "content-type": "text/event-stream" },
                  })) as unknown as typeof fetch,
              },
            },
          ],
        ]),
      );
      await expect(
        port.complete(
          { ...prepared, provider: profile.id, stream: true, maxOutputTokens: 4096 },
          new AbortController().signal,
        ),
      ).rejects.toThrow();
      const record = emitted.mock.calls.find(
        ([record]) =>
          record.rawMessage === "provider.stream.failed" &&
          record.properties.provider === profile.id,
      )?.[0].properties;
      expect(record).toMatchObject({ finishReasons: [reason], maxOutputTokens: 4096 });
      expect(JSON.stringify(record?.usage)).toContain("4096");
    }
  } finally {
    emitted.mockRestore();
  }
});

test("terminal stream evidence survives a following ping before premature EOF", async () => {
  const { getLogger } = await import("@logtape/logtape");
  const { spyOn } = await import("bun:test");
  const { anthropicMessagesV4 } = await import("./streaming-profiles.ts");
  const emitted = spyOn(getLogger(["labkit", "provider"]), "emit");
  try {
    const events = [
      {
        type: "message_start",
        message: { role: "assistant", content: [], usage: { input_tokens: 11 } },
      },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 23 } },
      { type: "ping" },
    ];
    const profile = anthropicMessagesV4;
    const port = bindProviders(
      new Map([
        [
          profile.id,
          {
            profile,
            transport: {
              baseUrl: "https://example.invalid",
              fetch: (async () =>
                new Response(
                  events
                    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
                    .join(""),
                  { headers: { "content-type": "text/event-stream" } },
                )) as unknown as typeof fetch,
            },
          },
        ],
      ]),
    );
    await expect(
      port.complete(
        { ...prepared, provider: profile.id, stream: true },
        new AbortController().signal,
      ),
    ).rejects.toThrow("Incomplete completion stream");
    const record = emitted.mock.calls.find(
      ([record]) => record.rawMessage === "provider.stream.failed",
    )?.[0].properties;
    expect(record).toMatchObject({
      lastEvent: "ping",
      stopReason: "end_turn",
      usage: { input_tokens: 11, output_tokens: 23 },
    });
  } finally {
    emitted.mockRestore();
  }
});
