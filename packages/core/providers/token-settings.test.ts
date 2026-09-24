import { expect, test } from "@logtape/testing-bun/autoload";

import { createProviderCapture } from "../environment/provider-capture.ts";
import { withFixtureDiagnostics } from "../logging/fixture-capture.ts";
import { createSession, restoreSession, type SessionOptions } from "../session/index.ts";
import { deferred, until } from "../session/test-support.ts";
import { createMemoryPersistence } from "../session/testing/memory-persistence.ts";
import {
  anthropicMessagesV2,
  anthropicMessagesV3,
  anthropicMessagesV4,
  CompletionRequestSchema,
  googleGenerateV2,
  googleGenerateV3,
} from "./index.ts";

for (const profile of [
  anthropicMessagesV2,
  anthropicMessagesV3,
  googleGenerateV2,
  googleGenerateV3,
]) {
  test(`${profile.id} encodes the chosen thinking budget without a fixed 1024-token substitution`, () => {
    for (const budget of [4096, 8192, 16384]) {
      const request = CompletionRequestSchema.parse({
        model: "configured-model",
        messages: [{ role: "user", text: "Review" }],
        tools: [],
        successors: [],
        thinking: "budget",
        thinkingBudgetTokens: budget,
        maxOutputTokens: 32768,
      });
      const body = profile.encode(request).body;
      expect(body).toMatchObject(
        profile.id.startsWith("anthropic")
          ? { thinking: { type: "enabled", budget_tokens: budget }, max_tokens: 32768 }
          : {
              generationConfig: {
                thinkingConfig: { thinkingBudget: budget },
                maxOutputTokens: 32768,
              },
            },
      );
      for (const patch of [
        { thinkingBudgetTokens: undefined },
        { maxOutputTokens: budget },
        { maxOutputTokens: undefined },
      ])
        expect(() => profile.encode({ ...request, ...patch })).toThrow();
    }
  });
}

test("adaptive thinking requires an explicit output limit and sends no manual budget", () => {
  const request = CompletionRequestSchema.parse({
    model: "adaptive-model",
    messages: [],
    tools: [],
    successors: [],
    thinking: "adaptive",
  });
  expect(() => anthropicMessagesV4.encode(request)).toThrow("maxOutputTokens");
  expect(anthropicMessagesV4.encode({ ...request, maxOutputTokens: 32768 }).body).toMatchObject({
    thinking: { type: "adaptive" },
    max_tokens: 32768,
  });
  expect(
    JSON.stringify(anthropicMessagesV4.encode({ ...request, maxOutputTokens: 32768 }).body),
  ).not.toContain("budget_tokens");
  expect(() =>
    anthropicMessagesV4.encode({ ...request, maxOutputTokens: 32768, thinkingBudgetTokens: 4096 }),
  ).toThrow("clear the budget");
});

test("explicit token settings validate before admission, stay captured in flight, and restore without requests", async () => {
  const capture = await createProviderCapture(".session-artifacts/token-settings");
  const release = deferred<void>();
  const requests: any[] = [];
  const profile = {
    ...anthropicMessagesV2,
    capabilities: {
      ...anthropicMessagesV2.capabilities,
      thinking: { mode: "budget" as const, minTokens: 1024, maxTokens: 16384 },
      outputTokens: { required: true, maxTokens: 32768 },
    },
  };
  const options: SessionOptions = {
    persistence: createMemoryPersistence(),
    configuration: {
      agent: "reviewer",
      agents: new Map([["reviewer", { model: "review" }]]),
      steps: 2,
      policy: {
        provider: "anthropic",
        model: "review",
        thinking: "budget",
        thinkingBudgetTokens: 8192,
        maxOutputTokens: 32768,
      },
    },
    bindings: {
      providers: new Map([
        [
          "anthropic",
          {
            profile,
            models: new Map([["review", { wireModel: "configured-model", profile }]]),
            transport: {
              baseUrl: "https://scripted.invalid/v1",
              capture: capture.capture,
              fetch: (async (_url, init) => {
                requests.push(JSON.parse(String(init?.body)));
                if (requests.length === 1) await release.promise;
                return Response.json({
                  role: "assistant",
                  stop_reason: "end_turn",
                  content: [{ type: "text", text: "Reviewed" }],
                });
              }) as typeof fetch,
            },
          },
        ],
      ]),
    },
  };
  await withFixtureDiagnostics(capture.directory, { runId: capture.runId }, async () => {
    for (const patch of [
      { thinkingBudgetTokens: null },
      { thinkingBudgetTokens: 65536 },
      { maxOutputTokens: 8192 },
      { maxOutputTokens: 65536 },
    ])
      await expect(
        createSession({
          ...options,
          configuration: {
            ...options.configuration,
            policy: { ...options.configuration.policy, ...patch },
          },
        }),
      ).rejects.toThrow();
    expect(requests).toHaveLength(0);
    const session = await createSession(options);
    try {
      const first = session.input("First review");
      await until(() => requests.length === 1);
      expect(await session.updatePolicy({ thinkingBudgetTokens: 4096 })).toMatchObject({
        kind: "busy",
      });
      expect(requests[0]).toMatchObject({ thinking: { budget_tokens: 8192 }, max_tokens: 32768 });
      release.resolve();
      expect(await first.settled).toMatchObject({ record: { outcome: { kind: "completed" } } });
      expect(
        await session.updatePolicy({ thinkingBudgetTokens: 4096, maxOutputTokens: 16384 }),
      ).toMatchObject({ kind: "accepted" });
      await session.input("Second review").settled;
      expect(requests[1]).toMatchObject({ thinking: { budget_tokens: 4096 }, max_tokens: 16384 });
      const restored = await restoreSession(
        options,
        session.snapshot.durable.conversation.sessionId,
      );
      expect(requests).toHaveLength(2);
      expect(restored.snapshot.durable.policy).toMatchObject({
        thinkingBudgetTokens: 4096,
        maxOutputTokens: 16384,
      });
      await restored.close();
    } finally {
      release.resolve();
      await session.close();
    }
  });
  const logs = (await Bun.file(`${capture.directory}/diagnostics.jsonl`).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(logs.filter((log) => ["warning", "error"].includes(log.level))).toEqual([]);
  expect(
    logs.some(
      (log) => log.event === "policy.committed" && log.policy.thinkingBudgetTokens === 4096,
    ),
  ).toBe(true);
  const manifest = await Bun.file(`${capture.directory}/manifest.json`).json();
  expect(manifest.calls).toHaveLength(2);
  expect(
    JSON.parse(await Bun.file(`${capture.directory}/${manifest.calls[1].requestFile}`).text()),
  ).toMatchObject({ thinking: { budget_tokens: 4096 }, max_tokens: 16384 });
});
