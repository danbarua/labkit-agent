import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import { diagnostic } from "../../logging/index.ts";
import type { PolicyPatch } from "../../policy/policy.ts";
import {
  anthropicMessagesV2,
  anthropicMessagesV3,
  googleGenerate,
  googleGenerateV2,
  googleGenerateV3,
  openaiChat,
  openaiChatV2,
  openaiResponsesV2,
  openaiResponsesV3,
} from "../../providers/index.ts";
import { defineTool, type SessionOptions, type SessionRuntime } from "../session-runtime.ts";
import { deferred, deterministicIds, lostAcknowledgement, testOptions } from "../test-support.ts";
import { createMemoryBacking, createMemoryPersistence } from "../testing/memory-persistence.ts";
import { BodySchema } from "../types.ts";

export type Dependencies = {
  format?: 2;
  providerResponses?: true;
  permissions?: readonly unknown[];
  policy?: PolicyPatch;
  allowance?: number;
  fault?: "reject-input" | "lose-input" | "lose-recovery";
  completions: readonly unknown[];
};

export type Observation =
  | { kind: "action"; description: string }
  | {
      kind: "assertion";
      description: string;
      passed: boolean;
      actual: unknown;
      expected: unknown;
    };

export type Scenario = {
  name: string;
  version: 1 | 2;
  group: string;
  purpose: string;
  source: string;
  baseline?: "assertions";
  environment?: string;
  dependencies: Dependencies;
  run: (fixture: Fixture) => Promise<void>;
};
/** Deterministic environment only: scenarios themselves call the public session API. */
export function fixtureEnvironment(scenario: Dependencies) {
  const observations: Observation[] = [];
  const toolRuns: string[] = [];
  const backing = createMemoryBacking();
  const base = createMemoryPersistence(backing);
  const matches = (records: readonly string[], kind: "input" | "recovery") =>
    records.some((serialized) => {
      const body = BodySchema.parse(JSON.parse(serialized).body);
      return kind === "recovery"
        ? body.kind === "recovery"
        : body.kind === "event" && body.event.type === "user";
    });
  const port =
    scenario.fault === "lose-input" || scenario.fault === "lose-recovery"
      ? lostAcknowledgement(base, (records) =>
          matches(records, scenario.fault === "lose-recovery" ? "recovery" : "input"),
        )
      : scenario.fault === "reject-input"
        ? {
            ...base,
            append: (request: Parameters<typeof base.append>[0], signal: AbortSignal) =>
              matches(request.records, "input")
                ? Promise.resolve({
                    kind: "rejected" as const,
                    message: "Scripted rejected append",
                  })
                : base.append(request, signal),
          }
        : base;
  const requests: unknown[] = [];
  const results: unknown[] = [];
  const sessions = new Map<string, SessionRuntime>();
  const deferredWork = new Map<
    string,
    { promise: Promise<unknown>; resolve: (value: unknown) => void; value?: unknown }
  >();
  let completionIndex = 0;
  let permissionIndex = 0;
  const options = testOptions({
    persistence: port,
    id: deterministicIds(),
    steps: scenario.allowance ?? 4,
    tools: new Map([
      [
        "echo",
        defineTool({
          input: z.object({ text: z.string() }),
          run: ({ text }) => {
            toolRuns.push(text);
            if (text.startsWith("error:")) throw new Error(text.slice(6));
            if (!text.startsWith("defer:")) return text;
            const work = deferred<unknown>();
            deferredWork.set(text.slice(6), work);
            return work.promise;
          },
        }),
      ],
    ]),
    complete(request) {
      requests.push({ model: request.model, messages: request.messages, tools: request.tools });
      const outcome = scenario.completions[completionIndex++];
      if (outcome === undefined) throw new Error("Fixture completion script exhausted");
      if (typeof outcome === "object" && outcome !== null && "error" in outcome)
        throw new Error(String(outcome.error));
      if (typeof outcome === "object" && outcome !== null && "defer" in outcome) {
        const work = deferred<unknown>();
        deferredWork.set(String(outcome.defer), {
          ...work,
          value: "value" in outcome ? outcome.value : undefined,
        });
        return work.promise;
      }
      return outcome;
    },
  });
  const bind = (configured: SessionOptions): SessionOptions => ({
    persistence: configured.persistence,
    configuration: {
      agent: configured.configuration.agent,
      agents: configured.configuration.agents,
      steps: configured.configuration.steps,
      policy: scenario.policy,
    },
    bindings: {
      tools: configured.bindings.tools,
      id: configured.bindings.id,
      ...(scenario.permissions
        ? {
            requestPermission: (request: import("../../host/ports.ts").PermissionRequest) => {
              results.push({ permission: request });
              const response = scenario.permissions![permissionIndex++];
              if (response === undefined) throw new Error("Fixture permission script exhausted");
              if (typeof response === "object" && response !== null && "defer" in response) {
                const work = deferred<unknown>();
                deferredWork.set(String(response.defer), work);
                return work.promise;
              }
              return response;
            },
          }
        : {}),
      ...(scenario.providerResponses
        ? {
            providers: new Map(
              [
                anthropicMessagesV2,
                anthropicMessagesV3,
                googleGenerate,
                googleGenerateV2,
                googleGenerateV3,
                openaiChat,
                openaiChatV2,
                openaiResponsesV2,
                openaiResponsesV3,
              ].map((profile) => [
                profile.id,
                {
                  profile,
                  transport: {
                    baseUrl: "https://example.invalid",
                    fetch: (async (_url, init) => {
                      requests.push(JSON.parse(String(init?.body)));
                      const response = scenario.completions[completionIndex++];
                      if (response === undefined)
                        throw new Error("Fixture provider script exhausted");
                      if (typeof response === "object" && response !== null && "sse" in response)
                        return new Response(z.string().parse(response.sse), {
                          headers: { "content-type": "text/event-stream" },
                        });
                      return Response.json(response);
                    }) as typeof fetch,
                  },
                },
              ]),
            ),
          }
        : {
            complete: (request, signal) => configured.bindings.complete!(request, signal),
          }),
    },
  });

  return {
    options: bind(options),
    // Reopen the same backing store through a fresh persistence handle. No model work on restore.
    restoreOptions: () =>
      bind({
        ...options,
        persistence: scenario.fault === "lose-recovery" ? port : createMemoryPersistence(backing),
        bindings: {
          ...options.bindings,
          complete: () => {
            throw new Error("Restoration invoked completion");
          },
        },
      }),
    persistence: port,
    sessions,
    requests,
    results,
    observations,
    toolRuns,
    get permissionCount() {
      return permissionIndex;
    },
    track(alias: string, session: SessionRuntime) {
      if (sessions.has(alias)) throw new Error(`Duplicate session alias: ${alias}`);
      sessions.set(alias, session);
      return session;
    },
    record(value: unknown) {
      results.push(value);
    },
    action(description: string) {
      observations.push({ kind: "action", description });
      diagnostic("fixture", "info", "scenario.action", { description });
    },
    check(description: string, actual: unknown, expected: unknown) {
      const passed = isDeepStrictEqual(actual, expected);
      observations.push({ kind: "assertion", description, passed, actual, expected });
      diagnostic("fixture", passed ? "info" : "error", "scenario.assertion", {
        description,
        passed,
        actual,
        expected,
      });
      if (!passed)
        throw new Error(
          `${description}\nExpected: ${JSON.stringify(expected)}\nObserved: ${JSON.stringify(actual)}`,
        );
    },
    async release(name: string, value?: unknown) {
      const work = deferredWork.get(name);
      if (!work) throw new Error(`Deferred work not started: ${name}`);
      work.resolve(value ?? work.value);
      await work.promise;
    },
  };
}

export type Fixture = ReturnType<typeof fixtureEnvironment>;
