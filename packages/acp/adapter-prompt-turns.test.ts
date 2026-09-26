import { defineTool } from "@labkit-agent/core";
import { expect, test } from "@logtape/testing-bun/autoload";
import { z } from "zod";

import { deferred, until } from "../core/agent/test-support.ts";
import {
  streamingProfiles,
  streamResponse,
  streamVector,
} from "../core/providers/testing/stream-vectors.ts";
import { answer, prompt } from "./testing/fixtures.ts";
import { harness, setup } from "./testing/harness.ts";

test("session routing isolates cancellation; disconnect aborts remaining completion", async () => {
  const signals: AbortSignal[] = [];
  const pending = deferred<unknown>();
  const { options } = setup({
    complete: (_, signal) => {
      signals.push(signal);
      return pending.promise;
    },
  });
  const h = harness(options);
  await h.initialize();
  const a = await h.newSession();
  const b = await h.newSession();
  const first = await h.start("session/prompt", prompt(a));
  await h.start("session/prompt", prompt(b));
  await until(() => signals.length === 2);
  await h.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: a } });
  expect((await h.response(first)).result.stopReason).toBe("cancelled");
  expect(signals.map((s) => s.aborted)).toEqual([true, false]);
  await h.disconnect();
  expect(signals.every((s) => s.aborted)).toBe(true);
  pending.resolve(answer);
});

for (const profile of streamingProfiles)
  test(`${profile.id}: streamed text/thinking stays incremental without duplicate settled output`, async () => {
    const { options } = setup();
    const original = options.sessionOptions;
    const h = harness({
      ...options,
      sessionOptions: async (context) => {
        const base = await original(context);
        return {
          ...base,
          configuration: {
            ...base.configuration,
            policy: {
              thinkingBudgetTokens: profile.capabilities.thinking.mode === "budget" ? 1024 : null,
              provider: profile.id,
              stream: true,
              thinking:
                profile.id.startsWith("anthropic") || profile.id.startsWith("google")
                  ? "budget"
                  : "high",
              maxOutputTokens: 2048,
            },
          },
          bindings: {
            ...base.bindings,
            complete: undefined,
            providers: new Map([
              [
                profile.id,
                {
                  profile,
                  transport: {
                    baseUrl: "https://test.invalid",
                    fetch: (async () =>
                      streamResponse(streamVector(profile))) as unknown as typeof fetch,
                  },
                },
              ],
            ]),
          },
        };
      },
    });
    await h.initialize();
    const id = await h.newSession();
    expect((await h.request("session/prompt", prompt(id))).result?.stopReason).toBe("end_turn");
    const chunks = h
      .updates()
      .map((m) => m.update)
      .filter((u) => u.sessionUpdate === "agent_message_chunk");
    expect(chunks.map((u: any) => u.content.text).join("")).toBe("Hello 🌍");
    expect(new Set(chunks.map((u: any) => u.messageId)).size).toBe(1);
    if (profile.id !== "openai-chat@2")
      expect(h.updates().some((m) => m.update.sessionUpdate === "agent_thought_chunk")).toBe(true);
    await h.close();
  });

test("incomplete stream reports an RPC failure, never successful end_turn", async () => {
  const { openaiChatV2 } = await import("@labkit-agent/core/providers");
  const { options } = setup();
  const original = options.sessionOptions;
  const h = harness({
    ...options,
    sessionOptions: async (context) => {
      const base = await original(context);
      return {
        ...base,
        configuration: {
          ...base.configuration,
          policy: { maxOutputTokens: 16384, provider: openaiChatV2.id, stream: true },
        },
        bindings: {
          ...base.bindings,
          complete: undefined,
          providers: new Map([
            [
              openaiChatV2.id,
              {
                profile: openaiChatV2,
                transport: {
                  baseUrl: "https://test.invalid",
                  fetch: (async () =>
                    streamResponse(
                      streamVector(openaiChatV2).slice(0, -1),
                    )) as unknown as typeof fetch,
                },
              },
            ],
          ]),
        },
      };
    },
  });
  await h.initialize();
  const id = await h.newSession();
  expect((await h.request("session/prompt", prompt(id))).error?.code).toBe(-32000);
  await h.close();
});

test("ACP exposes structured storage failure from public settlement without reconstructing it", async () => {
  const { options, persistence } = setup();
  const original = options.sessionOptions;
  const h = harness({
    ...options,
    sessionOptions: async (context) => ({
      ...(await original(context)),
      persistence: {
        ...persistence,
        append: async (request, signal) =>
          request.expectedRevision === 0
            ? persistence.append(request, signal)
            : {
                kind: "rejected",
                message: "Journal volume is read-only",
                error: {
                  message: "Journal volume is read-only",
                  cause: { code: "EROFS", path: "/store/journal" },
                },
              },
      },
    }),
  });
  try {
    await h.initialize();
    const sessionId = await h.newSession();
    const response = await h.request("session/prompt", prompt(sessionId));
    expect(response.error).toMatchObject({
      code: -32000,
      message: "Journal volume is read-only",
      data: {
        classification: "persistence",
        operation: { kind: "append", sessionId },
        phase: "append",
        cause: { code: "EROFS", path: "/store/journal" },
      },
    });
  } finally {
    await h.close();
  }
});

for (const stream of [false, true]) {
  for (const reason of ["max_tokens", "refusal"]) {
    test(`ACP maps Anthropic ${reason} (stream=${stream}) without admitting partial tools`, async () => {
      const { anthropicMessagesV3 } = await import("../core/providers/index.ts");
      const { withFixtureDiagnostics } = await import("../core/logging/fixture-capture.ts");
      const directory = `.session-artifacts/acp-provider-stop/${crypto.randomUUID()}`;
      await withFixtureDiagnostics(directory, {}, async () => {
        const base = setup();
        let requests = 0;
        let toolRuns = 0;
        const h = harness({
          sessionOptions: async (context) => {
            const options = await base.options.sessionOptions(context);
            return {
              ...options,
              configuration: {
                ...options.configuration,
                policy: {
                  provider: "anthropic",
                  model: "m",
                  permissions: "off",
                  stream,
                  thinking: "off",
                  maxOutputTokens: 4096,
                },
              },
              bindings: {
                ...options.bindings,
                complete: undefined,
                tools: new Map([
                  [
                    "echo",
                    defineTool({
                      input: z.object({ text: z.string() }),
                      run: () => {
                        toolRuns++;
                        return "unexpected";
                      },
                    }),
                  ],
                ]),
                providers: new Map([
                  [
                    "anthropic",
                    {
                      profile: anthropicMessagesV3,
                      transport: {
                        baseUrl: "https://example.invalid",
                        fetch: (async () => {
                          requests++;
                          if (!stream)
                            return Response.json(
                              {
                                role: "assistant",
                                stop_reason: reason,
                                content: [
                                  {
                                    type: "tool_use",
                                    id: "partial",
                                    name: "echo",
                                    input: { text: "partial" },
                                  },
                                ],
                                usage: { output_tokens: 4096 },
                              },
                              { headers: { "request-id": "provider-stop-test" } },
                            );
                          const events = streamVector(anthropicMessagesV3, true).map((event) => {
                            const data = JSON.parse(event.data);
                            if (data.type === "message_delta") data.delta.stop_reason = reason;
                            return { ...event, data: JSON.stringify(data) };
                          });
                          return streamResponse(events);
                        }) as unknown as typeof fetch,
                      },
                    },
                  ],
                ]),
              },
            };
          },
        });
        try {
          await h.initialize();
          const sessionId = await h.newSession();
          const response = await h.request("session/prompt", prompt(sessionId));
          expect(response.error).toBeUndefined();
          expect(response.result.stopReason).toBe(
            reason === "max_tokens" ? "max_tokens" : "refusal",
          );
          expect(response.result._meta["labkit.dev/failure"]).toMatchObject({
            operation: { kind: "completion", sessionId },
            providerStop: { category: reason === "max_tokens" ? "token_limit" : "refusal", reason },
          });
          expect(requests).toBe(1);
          expect(toolRuns).toBe(0);
        } finally {
          await h.close();
        }
      });
      const records = (await Bun.file(`${directory}/diagnostics.jsonl`).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const failed = records.find((record) => record.event === "provider.completion.failed");
      expect(failed.level).toBe("warning");
      expect(failed.error.providerStop.reason).toBe(reason);
    });
  }
}
