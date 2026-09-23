import { z } from "zod";
import { defineTool, type SessionOptions } from "./session-runtime.ts";
import { createMemoryPersistence } from "./testing/memory-persistence.ts";
export { deferred, until } from "../agent/test-support.ts";

export function deterministicIds() {
  let sequence = 0;
  return () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
}
export function testOptions(overrides: Partial<SessionOptions> = {}): SessionOptions {
  return {
    agent: "a",
    steps: 4,
    baseUrl: "https://example.invalid",
    apiKey: "SECRET_SENTINEL",
    agents: new Map([
      ["a", { model: "test-model", systemPrompt: "Agent A", tools: ["echo"] }],
      ["b", { model: "test-model", systemPrompt: "Agent B", tools: ["echo"] }],
    ]),
    tools: new Map([
      ["echo", defineTool({ input: z.object({ text: z.string() }), run: ({ text }) => text })],
    ]),
    complete: () => ({ kind: "answer", text: "Hello" }),
    persistence: createMemoryPersistence(),
    id: deterministicIds(),
    ...overrides,
  };
}
export function scriptedCompletion(outcomes: readonly unknown[], requests: unknown[] = []) {
  let index = 0;
  return (request: Parameters<NonNullable<SessionOptions["complete"]>>[0]) => {
    requests.push(
      structuredClone({ model: request.model, messages: request.messages, tools: request.tools }),
    );
    const result = outcomes[index++];
    if (result instanceof Error) throw result;
    if (result === undefined) throw new Error("Completion script exhausted");
    return result;
  };
}
export function lostAcknowledgement(
  port: SessionOptions["persistence"],
  predicate: (records: readonly string[]) => boolean = () => true,
): SessionOptions["persistence"] {
  let lost = false;
  return {
    lifetime: port.lifetime,
    load: port.load.bind(port),
    async append(request, signal) {
      const result = await port.append(request, signal);
      if (!lost && result.kind === "committed" && predicate(request.records)) {
        lost = true;
        return { kind: "indeterminate", message: "Receipt lost" };
      }
      return result;
    },
  };
}
