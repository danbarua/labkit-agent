import { expect, test } from "@logtape/testing-bun/autoload";
import { z } from "zod";

import { CompletionSchema } from "../agent/types.ts";
import { createProviderCapture } from "../environment/provider-capture.ts";
import { withFixtureDiagnostics } from "../logging/fixture-capture.ts";
import { anthropicMessages, bindProviders, openaiChat } from "../providers/index.ts";
import {
  CompletionPortRequestSchema,
  createSession,
  defineTool,
  restoreSession,
  type SessionOptions,
} from "./index.ts";
import { deferred, until } from "./test-support.ts";
import { createMemoryPersistence } from "./testing/memory-persistence.ts";

for (const mode of [
  "refusal",
  "interruption",
  "timeout",
  "malformed-json",
  "cancellation",
  "configuration",
] as const) {
  test(`peer-review consumer handles ${mode}, restores without effects, and repeats only explicitly`, async () => {
    const capture = await createProviderCapture(".session-artifacts/peer-review-acceptance");
    const counts = { coordinator: 0, extraction: 0, tool: 0, permission: 0 };
    const release = deferred<void>();
    const requests: { provider: string; model: string; messages: number; bytes: number }[] = [];
    let firstAttempt = true;
    const extractor = bindProviders(
      new Map([
        [
          "anthropic",
          {
            profile: anthropicMessages,
            transport: {
              baseUrl: "https://scripted.invalid/anthropic/v1",
              capture: capture.capture,
              fetch: (async (_url, init) => {
                counts.extraction++;
                const body = JSON.parse(String(init?.body));
                requests.push({
                  provider: "anthropic",
                  model: body.model,
                  messages: body.messages.length,
                  bytes: new TextEncoder().encode(String(init?.body)).length,
                });
                if (firstAttempt && ["interruption", "timeout", "cancellation"].includes(mode))
                  await release.promise;
                return Response.json({
                  id: `extraction-${counts.extraction}`,
                  type: "message",
                  role: "assistant",
                  content: [
                    {
                      type: "text",
                      text:
                        firstAttempt && mode === "malformed-json"
                          ? '{"claims":'
                          : '{"claims":["claim"]}',
                    },
                  ],
                  stop_reason: "end_turn",
                  usage: { input_tokens: 10, output_tokens: 5 },
                });
              }) as typeof fetch,
            },
          },
        ],
      ]),
    );
    const persistence = createMemoryPersistence();
    const options: SessionOptions = {
      persistence,
      configuration: {
        agent: "reviewer",
        agents: new Map([["reviewer", { model: "fast", tools: ["extract"] }]]),
        steps: 5,
        policy: {
          provider: "coordinator",
          model: "fast",
          permissions: "ask",
          ...(mode === "timeout" ? { toolTimeoutMs: 20 } : {}),
        },
      },
      bindings: {
        requestPermission: () => {
          counts.permission++;
          return {
            outcome: {
              outcome: "selected",
              optionId: firstAttempt && mode === "refusal" ? "reject-once" : "allow-once",
            },
          };
        },
        providers: new Map([
          [
            "coordinator",
            {
              profile: openaiChat,
              models: new Map([
                ["fast", { wireModel: "wire-fast", profile: openaiChat }],
                ["careful", { wireModel: "wire-careful", profile: openaiChat }],
              ]),
              transport: {
                baseUrl: "https://scripted.invalid/coordinator/v1",
                capture: capture.capture,
                fetch: (async (_url, init) => {
                  counts.coordinator++;
                  const body = JSON.parse(String(init?.body));
                  requests.push({
                    provider: "coordinator",
                    model: body.model,
                    messages: body.messages.length,
                    bytes: new TextEncoder().encode(String(init?.body)).length,
                  });
                  return Response.json({
                    choices: [
                      {
                        finish_reason: body.messages.at(-1).role === "tool" ? "stop" : "tool_calls",
                        message:
                          body.messages.at(-1).role === "tool"
                            ? { content: "Reviewed claim" }
                            : {
                                content: "Extracting claims",
                                tool_calls: [
                                  {
                                    id: "extract-call",
                                    type: "function",
                                    function: {
                                      name: "extract",
                                      arguments: '{"text":"same paper"}',
                                    },
                                  },
                                ],
                              },
                      },
                    ],
                  });
                }) as typeof fetch,
              },
            },
          ],
        ]),
        tools: new Map([
          [
            "extract",
            defineTool({
              input: z.object({ text: z.string() }),
              async run({ text }, signal, context) {
                counts.tool++;
                const result = await extractor.complete(
                  CompletionPortRequestSchema.parse({
                    provider: "anthropic",
                    model: "extractor",
                    messages: [{ role: "user", content: text }],
                  }),
                  signal,
                  undefined,
                  undefined,
                  { ...context, childId: context?.toolCallId },
                );
                const completion = CompletionSchema.parse(result.completion);
                if (completion.kind !== "answer")
                  throw new Error("Extraction must return an answer");
                return z.object({ claims: z.array(z.string()) }).parse(JSON.parse(completion.text));
              },
            }),
          ],
        ]),
      },
    };
    await withFixtureDiagnostics(
      capture.directory,
      { runId: capture.runId, scenario: mode },
      async () => {
        const session = await createSession(options);
        let restored: Awaited<ReturnType<typeof restoreSession>> | undefined;
        try {
          const input = session.input("Review the paper");
          if (["interruption", "cancellation"].includes(mode)) {
            await until(() => counts.extraction === 1);
            if (mode === "interruption") await session.close();
            else await session.fire({ type: "abort" });
          }
          const result = await input.settled;
          if (mode === "interruption") expect(result.kind).toBe("closed");
          else if (mode === "cancellation")
            expect(result).toMatchObject({
              kind: "terminal",
              record: { outcome: { kind: "aborted", reason: { classification: "cancelled" } } },
            });
          else if (mode === "configuration")
            expect(result).toMatchObject({ record: { outcome: { kind: "completed" } } });
          else {
            expect(result).toMatchObject({
              kind: "terminal",
              record: {
                outcome: {
                  kind: "failed",
                  error: {
                    classification:
                      mode === "refusal"
                        ? "permission_refused"
                        : mode === "timeout"
                          ? "timeout"
                          : "execution",
                    operation: { toolName: "extract", callId: "extract-call" },
                  },
                },
              },
            });
          }
          if (mode === "refusal")
            expect(counts).toEqual({ coordinator: 1, extraction: 0, tool: 0, permission: 1 });
          await session.close();
          const beforeRestore = { ...counts };
          restored = await restoreSession(options, session.snapshot.durable.conversation.sessionId);
          expect(counts).toEqual(beforeRestore);
          if (mode === "interruption")
            expect(restored.snapshot.durable.conversation.log.at(-1)?.outcome).toMatchObject({
              kind: "failed",
              error: { classification: "interrupted" },
            });
          release.resolve();
          firstAttempt = false;
          expect(
            await restored.updatePolicy({
              model: "careful",
              toolTimeoutMs: null,
              permissions: "off",
            }),
          ).toMatchObject({ kind: "accepted" });
          const repeat = await restored.input("Repeat the review explicitly").settled;
          expect(repeat).toMatchObject({ record: { outcome: { kind: "completed" } } });
          expect(counts.tool).toBe(beforeRestore.tool + 1);
          expect(counts.extraction).toBe(beforeRestore.extraction + 1);
          expect(counts.permission).toBe(beforeRestore.permission);
          expect(
            requests
              .filter((request) => request.provider === "coordinator")
              .slice(-2)
              .every((request) => request.model === "wire-careful"),
          ).toBe(true);
          const independent = requests.filter((request) => request.provider === "anthropic");
          expect(new Set(independent.map((request) => request.bytes)).size).toBe(1);
          await Bun.write(
            `${capture.directory}/outcomes.json`,
            JSON.stringify({ first: result, repeat, beforeRestore, afterRepeat: counts }, null, 2),
          );
          await Bun.write(
            `${capture.directory}/acceptance.md`,
            [
              `# Peer review: ${mode}`,
              "",
              "The initial outcome and explicit repeat are in [outcomes.json](outcomes.json). Restore made no completion, tool, or permission invocation.",
              "",
              "Configuration changed before the repeat: careful model, permissions off, no tool timeout. The repeat extracted once. Full traffic is in [README.md](README.md); saved execution is in [journal.json](journal.json).",
              "",
              "| Provider | Model | Message count | Request bytes |",
              "| --- | --- | --- | --- |",
              ...requests.map(
                (request) =>
                  `| ${request.provider} | ${request.model} | ${request.messages} | ${request.bytes} |`,
              ),
              "",
              "Coordinator history and independent Anthropic requests are measured separately. No history storage change is applied.",
            ].join("\n"),
          );
        } finally {
          const journal = await persistence.load(
            session.snapshot.durable.conversation.sessionId,
            new AbortController().signal,
          );
          await Bun.write(`${capture.directory}/journal.json`, JSON.stringify(journal, null, 2));
          release.resolve();
          await session.close();
          await restored?.close();
          await capture.flush();
        }
      },
    );
    const logs = (await Bun.file(`${capture.directory}/diagnostics.jsonl`).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const warnings = logs.filter((log) => ["warning", "error"].includes(log.level));
    if (mode === "configuration") expect(warnings).toEqual([]);
    if (mode === "refusal")
      expect(
        warnings.some((log) => log.event === "permission.refused" && log.toolName === "extract"),
      ).toBe(true);
    if (mode === "timeout")
      expect(warnings.some((log) => log.event === "child.timed_out")).toBe(true);
    if (mode === "malformed-json")
      expect(
        warnings.some(
          (log) => log.event === "child.failed" && JSON.stringify(log).includes("JSON"),
        ),
      ).toBe(true);
  });
}
