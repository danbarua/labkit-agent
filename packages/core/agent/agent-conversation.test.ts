import { expect, test } from "@logtape/testing-bun/autoload";

import { Actor } from "../fsm/fsm.ts";
import {
  decideConversation,
  initialConversation,
  type ConversationCommand,
  type ConversationEvent,
  type ConversationState,
} from "./agent-conversation.ts";
import { context } from "./test-support.ts";

function conversation() {
  const { agent, steps } = context();
  return new Actor<ConversationState, ConversationEvent, ConversationCommand>(
    initialConversation(agent, steps),
    decideConversation,
    () => undefined,
    (command) => ({ type: "dispatch_failed", command, error: { message: "failed" } }),
  );
}
test("recording and replacement commit before the next queued user event", async () => {
  const parent = conversation();
  await parent.send({ type: "user", text: "first" });
  const first = parent.snapshot;
  await Promise.all([
    parent.send({ type: "abort" }),
    parent.send({ type: "user", text: "second" }),
  ]);
  expect<unknown>(parent.snapshot.log).toMatchObject([
    { agent: "writer", outcome: { kind: "aborted" }, messages: [{ role: "user", text: "first" }] },
  ]);
  expect(parent.snapshot.turnId).not.toBe(first.turnId);
  const current = parent.snapshot;
  await parent.send({ type: "child", turnId: first.turnId, event: { type: "abort" } });
  expect(parent.snapshot).toBe(current);
  expect(first.log).toEqual([]);
});
test("failed preparation records an outcome and restores the turn allowance", async () => {
  const parent = conversation();
  await parent.send({ type: "user", text: "first" });
  const state = parent.snapshot;
  if (state.turn.status !== "preparing_model") throw new Error();
  await parent.send({
    type: "child",
    turnId: state.turnId,
    event: {
      type: "prepared",
      child: state.turn.child,
      result: { kind: "failed", error: { message: "offline" } },
    },
  });
  expect(parent.snapshot.log[0]?.outcome).toEqual({
    kind: "failed",
    error: { message: "offline" },
  });
  expect<unknown>(parent.snapshot.turn).toMatchObject({
    status: "idle",
    id: parent.snapshot.turnId,
    agent: "writer",
    steps: 6,
  });
  expect(Object.isFrozen(parent.snapshot.log[0]?.messages)).toBe(true);
});

test("a rejected fork identity preserves the active state and cannot poison later outcomes", async () => {
  const parent = conversation();
  await parent.send({ type: "user", text: "work" });
  const before = parent.snapshot;
  await expect(
    parent.send({
      type: "request",
      request: { kind: "fork", id: before.turnId, sessionId: before.sessionId },
    }),
  ).rejects.toThrow("new session identity");
  expect(parent.snapshot).toBe(before);
  expect(parent.snapshot.pending).toHaveLength(0);
  await parent.send({ type: "abort" });
  expect(parent.snapshot.log[0]?.outcome.kind).toBe("aborted");
});
