import { expect, test } from "bun:test";
import { z } from "zod";
import { completionContract } from "./testing/completion-contract.ts";
import { toolContract } from "./testing/tool-contract.ts";
import { defineTool, completionTransport } from "./ports.ts";
import { createHost, type HostToolOutcome } from "./host.ts";
import { ActorIdSchema, CompletionSchema, ref } from "../agent/types.ts";
import { PreparedModelSchema } from "../agent/agent.ts";
import { until } from "../agent/test-support.ts";
completionContract("completion port through operation host", (source) => source);
toolContract("defineTool through operation host", (run) =>
  defineTool({ input: z.object({ text: z.string() }), run }),
);

test("host reports tools but cannot advance a batch before explicit release", async () => {
  const outcomes: HostToolOutcome[] = [];
  const events: unknown[] = [];
  const host = createHost(
    {
      agents: new Map([["a", { model: "m", tools: ["echo"] }]]),
      tools: new Map([
        ["echo", defineTool({ input: z.object({ text: z.string() }), run: ({ text }) => text })],
      ]),
      complete: () => ({ kind: "answer", text: "unused" }),
    },
    {
      turn: (_, event) => {
        events.push(event);
      },
      tool: (outcome) => {
        outcomes.push(outcome);
      },
    },
  );
  const completion = CompletionSchema.parse({
    kind: "tools",
    text: "work",
    calls: [{ id: "c", name: "echo", args: { text: "ok" } }],
  });
  if (completion.kind !== "tools") throw new Error("Expected tools");
  host.dispatch(
    {
      type: "turn",
      turnId: ActorIdSchema.parse("turn"),
      command: { type: "run_tools", child: ref("batch", "batch"), completion },
    },
    { projectPrompt: () => [] },
  );
  await until(() => outcomes.length === 1);
  expect(events).toHaveLength(0);
  host.releaseTool(outcomes[0]!);
  host.releaseTool(outcomes[0]!);
  await until(() => events.length === 1);
  expect(events[0]).toMatchObject({ type: "batch_settled", outcome: { kind: "succeeded" } });
  host.close();
});
test("transport binding supplies credentials outside the serializable request", async () => {
  let sent: any;
  const complete = completionTransport({
    baseUrl: "https://provider.invalid",
    apiKey: "secret",
    fetch: (async (_url, init) => {
      sent = init;
      return Response.json({ choices: [{ message: { content: "answer" } }] });
    }) as typeof fetch,
  });
  const request = PreparedModelSchema.parse({
    baseUrl: "https://journal.invalid",
    model: "m",
    messages: [{ role: "user", content: "hello" }],
  });
  await complete(request, new AbortController().signal);
  expect(sent.headers.Authorization).toBe("Bearer secret");
  expect(JSON.stringify(request)).not.toContain("secret");
});
