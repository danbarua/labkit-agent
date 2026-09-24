import { expect, test } from "@logtape/testing-bun/autoload";
import { z } from "zod";

import { createProviderCapture } from "../environment/provider-capture.ts";
import { withFixtureDiagnostics } from "../logging/fixture-capture.ts";
import { openaiChat, openaiChatV2 } from "../providers/index.ts";
import { createSession, defineTool, restoreSession, type SessionOptions } from "./index.ts";
import { deferred, until } from "./test-support.ts";
import { createMemoryPersistence } from "./testing/memory-persistence.ts";

const answer = { choices: [{ finish_reason: "stop", message: { content: "extracted" } }] };

function options(fetcher: typeof fetch): SessionOptions {
  return {
    persistence: createMemoryPersistence(),
    configuration: {
      agent: "reviewer",
      agents: new Map([["reviewer", { model: "fast", tools: ["extract"] }]]),
      steps: 5,
      policy: { maxOutputTokens: 16384, provider: "openai", model: "fast" },
    },
    bindings: {
      tools: new Map([
        [
          "extract",
          defineTool({ input: z.object({ text: z.string() }), run: ({ text }) => ({ text }) }),
        ],
      ]),
      providers: new Map([
        [
          "openai",
          {
            profile: openaiChat,
            models: new Map([
              ["fast", { wireModel: "wire-fast", profile: openaiChat }],
              ["streaming", { wireModel: "wire-stream", profile: openaiChatV2 }],
            ]),
            transport: { baseUrl: "https://scripted.invalid/v1", fetch: fetcher },
          },
        ],
      ]),
    },
  };
}

test("consumer inspects actual malformed HTTP evidence and terminal cause without journal search", async () => {
  const capture = await createProviderCapture(".session-artifacts/consumer");
  await withFixtureDiagnostics(capture.directory, { runId: capture.runId }, async () => {
    let invocations = 0;
    const opts = options((async (_url: RequestInfo | URL) => {
      invocations++;
      return new Response('{"choices":', { headers: { "x-request-id": "broken-json" } });
    }) as typeof fetch);
    const binding = opts.bindings.providers!.get("openai")!;
    const session = await createSession({
      ...opts,
      bindings: {
        ...opts.bindings,
        providers: new Map([
          ["openai", { ...binding, transport: { ...binding.transport, capture: capture.capture } }],
        ]),
      },
    });
    try {
      const result = await session.input("Extract the claims").settled;
      expect(result).toMatchObject({
        kind: "terminal",
        record: {
          outcome: {
            kind: "failed",
            error: {
              classification: "execution",
              operation: { kind: "completion" },
              cause: { message: "Completion response is not valid JSON" },
            },
          },
        },
      });
      await capture.flush();
      const manifest = await Bun.file(`${capture.directory}/manifest.json`).json();
      expect(manifest.calls).toHaveLength(1);
      const call = manifest.calls[0];
      expect(call).toMatchObject({
        providerRequestId: "broken-json",
        httpStatus: 200,
        outcome: "failed",
      });
      expect(await Bun.file(`${capture.directory}/${call.responseFile}`).text()).toBe(
        '{"choices":',
      );
      expect(
        JSON.parse(await Bun.file(`${capture.directory}/${call.requestFile}`).text()).model,
      ).toBe("wire-fast");
      const restored = await restoreSession(opts, session.snapshot.durable.conversation.sessionId);
      expect(invocations).toBe(1);
      await restored.close();
    } finally {
      await session.close();
    }
  });
  const logs = await Bun.file(`${capture.directory}/diagnostics.jsonl`).text();
  expect(logs).toContain('"phase":"response_json"');
  expect(logs).toContain("Completion response is not valid JSON");
});

test("consumer model aliases, extraction tools and explicit repeat preserve configuration boundaries", async () => {
  const requests: any[] = [];
  let tools = 0;
  const opts = options((async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    requests.push(request);
    return Response.json(
      requests.length === 1
        ? {
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  content: "",
                  tool_calls: [
                    {
                      id: "extract-1",
                      type: "function",
                      function: { name: "extract", arguments: '{"text":"claim"}' },
                    },
                  ],
                },
              },
            ],
          }
        : answer,
    );
  }) as typeof fetch);
  const session = await createSession({
    ...opts,
    bindings: {
      ...opts.bindings,
      tools: new Map([
        [
          "extract",
          defineTool({
            input: z.object({ text: z.string() }),
            run: ({ text }) => {
              tools++;
              return { text };
            },
          }),
        ],
      ]),
    },
  });
  try {
    expect(await session.input("Review").settled).toMatchObject({
      record: { outcome: { kind: "completed" } },
    });
    expect(tools).toBe(1);
    expect(session.model).toMatchObject({
      provider: "openai",
      model: "fast",
      wireModel: "wire-fast",
      profile: openaiChat.id,
    });
    expect(requests[1].messages.at(-1)).toMatchObject({
      role: "tool",
      tool_call_id: "extract-1",
      content: '{"text":"claim"}',
    });
    expect((await session.updatePolicy({ model: "streaming", stream: false })).kind).toBe(
      "accepted",
    );
    await session.input("Explicit repeat").settled;
    expect(requests[2].model).toBe("wire-stream");
    expect(session.model).toMatchObject({
      model: "streaming",
      wireModel: "wire-stream",
      profile: openaiChatV2.id,
    });
    expect(new Set(session.snapshot.durable.records.map((record) => record.version))).toEqual(
      new Set([1]),
    );
    expect(await session.updatePolicy({ model: "unknown" })).toMatchObject({
      kind: "failed",
      message: expect.stringContaining("supported: fast, streaming"),
    });
    const restored = await restoreSession(opts, session.snapshot.durable.conversation.sessionId);
    expect(requests).toHaveLength(3);
    expect(tools).toBe(1);
    await restored.close();
  } finally {
    await session.close();
  }
});

for (const kind of ["completion", "tool"] as const) {
  test(`consumer ${kind} deadline settles once, aborts signal, and restore performs no work`, async () => {
    const capture = await createProviderCapture(".session-artifacts/deadlines");
    await withFixtureDiagnostics(capture.directory, { runId: capture.runId }, async () => {
      let completions = 0;
      let tools = 0;
      const late = deferred<unknown>();
      let signal: AbortSignal | undefined;
      const opts: SessionOptions = {
        persistence: createMemoryPersistence(),
        configuration: {
          agent: "a",
          agents: new Map([["a", { model: "m", tools: ["hang"] }]]),
          steps: 3,
          policy: {
            completionTimeoutMs: kind === "completion" ? 20 : null,
            toolTimeoutMs: kind === "tool" ? 20 : null,
            toolFailure: "return-error-and-continue",
          },
        },
        bindings: {
          complete: (_request, abort) => {
            completions++;
            if (kind === "completion") {
              signal = abort;
              return late.promise;
            }
            return { kind: "tools", text: "", calls: [{ id: "hang-1", name: "hang", args: {} }] };
          },
          tools: new Map([
            [
              "hang",
              defineTool({
                input: z.object({}),
                run: (_, abort) => {
                  tools++;
                  signal = abort;
                  return late.promise;
                },
              }),
            ],
          ]),
        },
      };
      const session = await createSession(opts);
      try {
        expect(await session.input("Go").settled).toMatchObject({
          record: {
            outcome: {
              kind: "failed",
              error: { classification: "timeout", timeoutMs: 20, operation: { kind } },
            },
          },
        });
        expect(signal?.aborted).toBe(true);
        const revision = session.snapshot.durable.revision;
        late.resolve(kind === "completion" ? { kind: "answer", text: "late" } : "late");
        await Bun.sleep(0);
        expect(session.snapshot.durable.revision).toBe(revision);
        expect(completions).toBe(1);
        expect(tools).toBe(kind === "tool" ? 1 : 0);
        const restored = await restoreSession(
          opts,
          session.snapshot.durable.conversation.sessionId,
        );
        expect(completions).toBe(1);
        await restored.close();
      } finally {
        await session.close();
      }
    });
    expect(await Bun.file(`${capture.directory}/diagnostics.log`).text()).toContain(
      "child.timed_out",
    );
  });
}

test("consumer explicit cancellation is distinguishable from configured timeout", async () => {
  let started = false;
  const opts = options((async (_url: RequestInfo | URL) => {
    started = true;
    return new Promise(() => {});
  }) as typeof fetch);
  const session = await createSession(opts);
  const turn = session.input("Go");
  await until(() => started);
  await session.fire({ type: "abort" });
  expect(await turn.settled).toMatchObject({
    record: {
      outcome: {
        kind: "aborted",
        reason: { classification: "cancelled", operation: { kind: "completion" } },
      },
    },
  });
  await session.close();
});

test("EOF consumer retains partial SSE response, correlation and parser stage", async () => {
  const capture = await createProviderCapture(".session-artifacts/consumer-eof");
  const body =
    'data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n';
  const opts = options(
    (async (_url: RequestInfo | URL) =>
      new Response(body, {
        headers: { "content-type": "text/event-stream", "x-request-id": "eof-request" },
      })) as typeof fetch,
  );
  const binding = opts.bindings.providers!.get("openai")!;
  const configured = {
    ...opts,
    configuration: {
      ...opts.configuration,
      policy: { maxOutputTokens: 16384, provider: "openai", model: "streaming", stream: true },
    },
    bindings: {
      ...opts.bindings,
      providers: new Map([
        ["openai", { ...binding, transport: { ...binding.transport, capture: capture.capture } }],
      ]),
    },
  };
  await withFixtureDiagnostics(capture.directory, { runId: capture.runId }, async () => {
    const session = await createSession(configured);
    try {
      const result = await session.input("Review").settled;
      expect(result).toMatchObject({
        record: { outcome: { kind: "failed", error: { operation: { kind: "completion" } } } },
      });
      const { calls } = await Bun.file(`${capture.directory}/manifest.json`).json();
      expect(calls[0]).toMatchObject({
        providerRequestId: "eof-request",
        outcome: "failed",
        model: "streaming",
      });
      expect(await Bun.file(`${capture.directory}/${calls[0].responseFile}`).text()).toBe(body);
      expect(await Bun.file(`${capture.directory}/diagnostics.log`).text()).toContain(
        "provider.stream.failed",
      );
    } finally {
      await session.close();
    }
  });
});

test("peer review separates growing coordinator history from independent Anthropic extraction requests", async () => {
  const { bindProviders, anthropicMessages } = await import("../providers/index.ts");
  const { CompletionPortRequestSchema } = await import("./index.ts");
  const capture = await createProviderCapture(".session-artifacts/peer-review");
  const independentSizes: number[] = [];
  const coordinatorCounts: number[] = [];
  const extractor = bindProviders(
    new Map([
      [
        "anthropic",
        {
          profile: anthropicMessages,
          transport: {
            baseUrl: "https://anthropic-scripted.invalid/v1",
            capture: capture.capture,
            headers: { "x-api-key": "CAPTURE_SECRET_SENTINEL" },
            fetch: (async (_url: RequestInfo | URL, init?: RequestInit) => {
              independentSizes.push(new TextEncoder().encode(String(init?.body)).byteLength);
              return Response.json({
                id: "extract-response",
                type: "message",
                role: "assistant",
                content: [{ type: "text", text: '{"claims":["claim"]}' }],
                stop_reason: "end_turn",
                usage: { input_tokens: 10, output_tokens: 5 },
              });
            }) as typeof fetch,
          },
        },
      ],
    ]),
  );
  let calls = 0;
  const opts = options((async (_url: RequestInfo | URL, init?: RequestInit) => {
    coordinatorCounts.push(JSON.parse(String(init?.body)).messages.length);
    return Response.json(
      ++calls % 2
        ? {
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  content: "",
                  tool_calls: [
                    {
                      id: "extract",
                      type: "function",
                      function: { name: "extract", arguments: '{"text":"same paper"}' },
                    },
                  ],
                },
              },
            ],
          }
        : answer,
    );
  }) as typeof fetch);
  const binding = opts.bindings.providers!.get("openai")!;
  const configured = {
    ...opts,
    bindings: {
      ...opts.bindings,
      providers: new Map([
        ["openai", { ...binding, transport: { ...binding.transport, capture: capture.capture } }],
      ]),
      tools: new Map([
        [
          "extract",
          defineTool({
            input: z.object({ text: z.string() }),
            run: async ({ text }, signal, context) => {
              const result = await extractor.complete(
                CompletionPortRequestSchema.parse({
                  maxOutputTokens: 16384,
                  provider: "anthropic",
                  model: "scripted-extractor",
                  messages: [{ role: "user", content: text }],
                }),
                signal,
                undefined,
                undefined,
                { ...context, childId: context?.toolCallId },
              );
              return result.completion;
            },
          }),
        ],
      ]),
    },
  };
  await withFixtureDiagnostics(capture.directory, { runId: capture.runId }, async () => {
    const session = await createSession(configured);
    try {
      expect(await session.input("Review").settled).toMatchObject({
        record: { outcome: { kind: "completed" } },
      });
      const restored = await restoreSession(
        configured,
        session.snapshot.durable.conversation.sessionId,
      );
      expect(independentSizes).toHaveLength(1);
      await restored.close();
      await session.input("Repeat explicitly").settled;
      expect(independentSizes).toHaveLength(2);
      expect(independentSizes[0]).toBe(independentSizes[1]);
      expect(coordinatorCounts[2]!).toBeGreaterThan(coordinatorCounts[0]!);
      const manifest = await Bun.file(`${capture.directory}/manifest.json`).json();
      expect(
        manifest.calls
          .filter((call: any) => call.provider === "anthropic")
          .every((call: any) => call.toolCallId && call.turnId && call.sessionId),
      ).toBe(true);
      expect(JSON.stringify(manifest)).not.toContain("CAPTURE_SECRET_SENTINEL");
      await Bun.write(
        `${capture.directory}/history-comparison.json`,
        JSON.stringify(
          {
            coordinatorMessageCounts: coordinatorCounts,
            independentAnthropicRequestBytes: independentSizes,
          },
          null,
          2,
        ),
      );
      await Bun.write(
        `${capture.directory}/history-comparison.md`,
        [
          "# Peer-review request comparison",
          "",
          "Two explicit review invocations each run extraction once. Restore runs neither coordinator nor extractor.",
          "",
          "| Coordinator call | Projected messages |",
          "| --- | --- |",
          ...coordinatorCounts.map((count, index) => `| ${index + 1} | ${count} |`),
          "",
          "| Independent Anthropic extraction | HTTP request bytes |",
          "| --- | --- |",
          ...independentSizes.map((bytes, index) => `| ${index + 1} | ${bytes} |`),
          "",
          "Coordinator history grows; independent extraction request sizes stay equal. Full bodies and correlation are linked in [the traffic report](README.md). No storage representation optimization is applied.",
          "",
        ].join("\n"),
      );
      const logs = (await Bun.file(`${capture.directory}/diagnostics.jsonl`).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(logs.filter((log) => log.level === "warning" || log.level === "error")).toEqual([]);
    } finally {
      await session.close();
    }
  });
});

test("public completion binding example exposes exact requests, arguments and responses", async () => {
  const { completionBindingExample } = await import("./examples/completion-binding.ts");
  const evidence = await completionBindingExample();
  expect(evidence.requests).toHaveLength(2);
  expect(evidence.requests[1]!.messages).toMatchObject([
    { role: "user", content: "Review the document" },
    {
      role: "assistant",
      tool_calls: [
        { id: "call-1", function: { name: "extract", arguments: '{"document":"A claim"}' } },
      ],
    },
    { role: "tool", tool_call_id: "call-1", content: '{"claim":"A claim"}' },
  ]);
  expect(evidence.responses[1]).toMatchObject({ completion: { kind: "answer" } });
});

test("retained provider rejection preserves code and status while redacting credential echoes", async () => {
  const capture = await createProviderCapture(".session-artifacts/consumer-rejection");
  const secret = "configured-provider-secret";
  const opts = options(
    (async (_url: RequestInfo | URL) =>
      new Response(
        JSON.stringify({ error: { code: "quota_exhausted", message: `No quota for ${secret}` } }),
        { status: 429, headers: { "x-request-id": "quota-request" } },
      )) as typeof fetch,
  );
  const binding = opts.bindings.providers!.get("openai")!;
  await withFixtureDiagnostics(capture.directory, { runId: capture.runId }, async () => {
    const session = await createSession({
      ...opts,
      bindings: {
        ...opts.bindings,
        providers: new Map([
          [
            "openai",
            {
              ...binding,
              transport: {
                ...binding.transport,
                headers: { Authorization: `Bearer ${secret}` },
                capture: capture.capture,
              },
            },
          ],
        ]),
      },
    });
    try {
      const result = await session.input("Review").settled;
      expect(result).toMatchObject({
        record: {
          outcome: {
            kind: "failed",
            error: { classification: "execution", operation: { kind: "completion" } },
          },
        },
      });
      const terminal = JSON.stringify(result);
      expect(terminal).toContain('"httpStatus":429');
      expect(terminal).toContain("quota-request");
      expect(terminal).toContain("quota_exhausted");
      expect(terminal).not.toContain(secret);
      const { calls } = await Bun.file(`${capture.directory}/manifest.json`).json();
      const response = await Bun.file(`${capture.directory}/${calls[0].responseFile}`).text();
      expect(response).toContain("quota_exhausted");
      expect(response).toContain("[REDACTED]");
      expect(response).not.toContain(secret);
      const logs = await Bun.file(`${capture.directory}/diagnostics.log`).text();
      expect(logs).not.toContain(secret);
      expect(
        logs
          .split("\n")
          .filter((line) => line.includes("WARNING"))
          .join("\n"),
      ).toContain("quota_exhausted");
    } finally {
      await session.close();
    }
  });
});

test("in-progress stream evidence reaches disk before the operation finishes", async () => {
  const capture = await createProviderCapture(".session-artifacts/consumer-partial");
  const recorded = deferred<void>();
  const finished = deferred<void>();
  const partial =
    'data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n';
  const opts = options(
    (async (_url: RequestInfo | URL) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(partial));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )) as typeof fetch,
  );
  const binding = opts.bindings.providers!.get("openai")!;
  const session = await createSession({
    ...opts,
    configuration: {
      ...opts.configuration,
      policy: { maxOutputTokens: 16384, provider: "openai", model: "streaming", stream: true },
    },
    bindings: {
      ...opts.bindings,
      providers: new Map([
        [
          "openai",
          {
            ...binding,
            transport: {
              ...binding.transport,
              capture: async (event) => {
                await capture.capture(event);
                if (event.kind === "http_response" && event.body === partial) recorded.resolve();
                if (event.kind === "completion") finished.resolve();
              },
            },
          },
        ],
      ]),
    },
  });
  try {
    const turn = session.input("Review");
    await recorded.promise;
    const { calls } = await Bun.file(`${capture.directory}/manifest.json`).json();
    expect(calls[0]).toMatchObject({ outcome: "in_progress", transportPhase: "stream" });
    expect(await Bun.file(`${capture.directory}/${calls[0].responseFile}`).text()).toBe(partial);
    await session.fire({ type: "abort" });
    expect(await turn.settled).toMatchObject({ record: { outcome: { kind: "aborted" } } });
    await finished.promise;
  } finally {
    await session.close();
  }
});

test("batch cancellation carries the initiating tool failure to siblings and diagnostics", async () => {
  const capture = await createProviderCapture(".session-artifacts/consumer-cancellation");
  await withFixtureDiagnostics(capture.directory, { runId: capture.runId }, async () => {
    let siblingSignal: AbortSignal | undefined;
    const session = await createSession({
      persistence: createMemoryPersistence(),
      configuration: {
        agent: "a",
        agents: new Map([["a", { model: "scripted", tools: ["extract"] }]]),
        steps: 3,
      },
      bindings: {
        complete: () => ({
          kind: "tools",
          text: "",
          calls: [
            { id: "first", name: "extract", args: { fail: true } },
            { id: "sibling", name: "extract", args: { fail: false } },
          ],
        }),
        tools: new Map([
          [
            "extract",
            defineTool({
              input: z.object({ fail: z.boolean() }),
              run: ({ fail }, signal) => {
                if (fail) throw new Error("extract failed");
                siblingSignal = signal;
                return new Promise(() => {});
              },
            }),
          ],
        ]),
      },
    });
    try {
      expect(await session.input("Go").settled).toMatchObject({
        record: {
          outcome: {
            kind: "failed",
            error: {
              operation: { callId: "first", toolName: "extract" },
              message: "extract failed",
            },
          },
        },
      });
      expect(siblingSignal?.aborted).toBe(true);
      expect(siblingSignal?.reason).toMatchObject({
        classification: "cancelled",
        message: "extract failed",
        operation: { callId: "first" },
      });
      const records = (await Bun.file(`${capture.directory}/diagnostics.jsonl`).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        records.some(
          (record) =>
            record.event === "child.cancellation_requested" &&
            record.childId.endsWith("/sibling") &&
            record.reason?.operation?.callId === "first",
        ),
      ).toBe(true);
    } finally {
      await session.close();
    }
  });
});
