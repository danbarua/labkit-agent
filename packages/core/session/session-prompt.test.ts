import { expect, test } from "@logtape/testing-bun/autoload";

import { ActorIdSchema, AgentIdSchema, StepsSchema } from "../agent/types.ts";
import { defaultPolicy, projectPolicy } from "../policy/policy.ts";
import { projectSessionPrompt } from "./session-prompt.ts";
import { createSession, restoreSession } from "./session-runtime.ts";
import { scriptedCompletion, testOptions } from "./test-support.ts";

const turn = {
  id: ActorIdSchema.parse("turn"),
  generation: 1,
  agent: AgentIdSchema.parse("a"),
  steps: StepsSchema.parse(1),
  messages: [{ role: "user" as const, text: "current" }],
  view: { kind: "history" as const },
};
test("configured system, ordered session inputs, context, history and current messages", () => {
  expect(
    projectSessionPrompt(
      {
        agent: { model: "m", systemPrompt: "configured", tools: [] },
        context: [{ role: "user", text: "context" }],
        log: [
          {
            agent: turn.agent,
            outcome: { kind: "completed" },
            messages: [{ role: "assistant", text: "history" }],
          },
        ],
        turn,
      },
      ["first", "second"],
    ).map((message) => message.content),
  ).toEqual(["configured", "first", "second", "context", "history", "current"]);
});
test("a handoff step sees the resolver's packet and later messages, not the predecessor's history", () => {
  const policy = defaultPolicy({ agents: [["a", { tools: [] }]] }, 3);
  expect(
    projectPolicy(
      {
        agent: { model: "m", systemPrompt: "configured", tools: [] },
        log: [
          {
            agent: turn.agent,
            outcome: { kind: "completed" },
            messages: [{ role: "assistant", text: "history" }],
          },
        ],
        turn: {
          ...turn,
          messages: [
            { role: "user", text: "earlier" },
            { role: "assistant", text: "draft" },
            { role: "user", text: "current" },
            { role: "assistant", text: "review this" },
            { role: "user", text: "after" },
          ],
          view: { kind: "handoff", from: AgentIdSchema.parse("writer"), at: 4 },
        },
      },
      ["session"],
      policy,
    ).messages.map((message) => message.content),
  ).toEqual(["configured", "session", "current", "review this", "after"]);
});
test("an invalid correlation in the projected context rejects", () => {
  expect(() =>
    projectSessionPrompt(
      {
        agent: { model: "m", tools: [] },
        log: [],
        context: [{ role: "tool", callId: "x" as never, text: "orphan" }],
        turn,
      },
      [],
    ),
  ).toThrow();
});
test("restored sessions project the same next request as an ordinary inherited fork", async () => {
  const requests: any[] = [];
  const options = testOptions({
    systemInputs: ["ordered"],
    complete: scriptedCompletion(
      Array.from({ length: 3 }, () => ({ kind: "answer", text: "answer" })),
      requests,
    ),
  });
  const parent = await createSession(options);
  await parent.input("one").settled;
  const child = await parent.fork();
  const restored = await restoreSession(options, parent.snapshot.durable.conversation.sessionId);
  await child.input("two").settled;
  await restored.input("two").settled;
  expect(requests[1]).toEqual(requests[2]);
});
