import { expect, test } from "@logtape/testing-bun/autoload";
import { z } from "zod";

import { PreparedModelSchema } from "../agent/agent.ts";
import { until } from "../agent/test-support.ts";
import {
  ActorIdSchema,
  AgentIdSchema,
  CompletionSchema,
  ref,
  StepsSchema,
} from "../agent/types.ts";
import { createHost, type HostToolOutcome } from "./host.ts";
import { completionTransport, defineTool } from "./ports.ts";
import { completionContract } from "./testing/completion-contract.ts";
import { toolContract } from "./testing/tool-contract.ts";

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
    model: "m",
    messages: [{ role: "user", content: "hello" }],
  });
  await complete(request, new AbortController().signal);
  expect(sent.headers.Authorization).toBe("Bearer secret");
  expect(JSON.stringify(request)).not.toContain("secret");
});

test("preparation commands reject missing prompt context before spawning operations", () => {
  const host = createHost(
    {
      agents: new Map([["a", { model: "m" }]]),
      complete: () => {
        throw new Error("Must not execute");
      },
    },
    {
      turn: () => {
        throw new Error("Must not report a child");
      },
      tool: () => {
        throw new Error("Must not execute tools");
      },
    },
  );
  const turn = {
    id: ActorIdSchema.parse("turn"),
    agent: AgentIdSchema.parse("a"),
    generation: 1,
    steps: StepsSchema.parse(1),
    messages: [],
    view: { kind: "history" as const },
  };
  expect(() =>
    host.dispatch(
      {
        type: "turn",
        turnId: turn.id,
        command: { type: "prepare_model", child: ref("prepare", "prepare"), turn },
      },
      { projectPrompt: () => [] },
    ),
  ).toThrow("prepare_model requires prompt context");
  expect(() =>
    host.dispatch(
      {
        type: "turn",
        turnId: turn.id,
        command: {
          type: "prepare_handoff",
          child: ref("handoff", "handoff"),
          turn,
          from: turn.agent,
        },
      },
      { projectPrompt: () => [] },
    ),
  ).toThrow("prepare_handoff requires prompt context");
  expect(host.snapshot).toHaveLength(0);
  host.close();
});
