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
import { createHost, type ExecutionContext, type HostToolOutcome } from "./host.ts";
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
    { projectPrompt: () => ({ messages: [], pointers: [] }) },
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

test("a step command rejects missing prompt context before spawning operations", () => {
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
        command: { type: "complete", child: ref("completion", "complete"), turn },
      },
      { projectPrompt: () => ({ messages: [], pointers: [] }) },
    ),
  ).toThrow("complete requires prompt context");
  expect(host.snapshot).toHaveLength(0);
  host.close();
});

for (const cancelled of [false, true])
  test(`a streaming step ${cancelled ? "cancelled during prompt projection publishes no stream status" : "publishes paired stream statuses"}`, async () => {
    const statuses: unknown[] = [];
    const events: { type: string; result?: { kind: string } }[] = [];
    let completions = 0;
    const host = createHost(
      {
        agents: new Map([["a", { model: "m", tools: [], successors: [] }]]),
        complete: () => {
          completions++;
          return { kind: "answer", text: "done" };
        },
      },
      {
        turn: (_, event) => {
          events.push(event);
        },
        tool: () => {
          throw new Error("Must not execute tools");
        },
        streamUpdate: (update) => {
          if ("status" in update && update.status) statuses.push(update.status);
        },
      },
    );
    let release: (messages: readonly unknown[]) => void = () => {};
    const projected = new Promise<readonly unknown[]>((resolve) => {
      release = resolve;
    });
    const turn = {
      id: ActorIdSchema.parse("turn"),
      agent: AgentIdSchema.parse("a"),
      generation: 1,
      steps: StepsSchema.parse(1),
      messages: [{ role: "user" as const, text: "hi" }],
      view: { kind: "history" as const },
    };
    const child = ref("completion", "turn/1");
    // Called right after projection resolves, so it shows the step's run resumed past it.
    let loads = 0;
    let projecting = false;
    const context: ExecutionContext = {
      prompt: { log: [], turn, agent: { model: "m", tools: [] } },
      provider: { provider: "p", stream: true },
      projectPrompt: () => {
        projecting = true;
        return projected.then((messages) => ({ messages, pointers: [] }));
      },
      loadBlobs: async () => {
        loads++;
        return () => {
          throw new Error("No blobs in this step");
        };
      },
    };
    host.dispatch(
      { type: "turn", turnId: turn.id, command: { type: "complete", child, turn } },
      context,
    );
    await until(() => projecting);
    if (cancelled)
      host.dispatch({ type: "turn", turnId: turn.id, command: { type: "cancel", child } }, context);
    release([{ role: "user", content: "hi" }]);
    await until(() => events.length === 1 && loads > 0);
    expect(events[0]).toMatchObject({
      type: "model_settled",
      result: { kind: cancelled ? "cancelled" : "succeeded" },
    });
    expect(completions).toBe(cancelled ? 0 : 1);
    expect(statuses).toEqual(cancelled ? [] : ["pending", "in_progress", "completed"]);
    host.close();
  });
