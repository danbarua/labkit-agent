import { expect, test } from "bun:test";
import { createAgentMachine } from "./agent-fsm.ts";
import { createConversationMachine } from "./agent-conversation.ts";
import { actions, context } from "./test-support.ts";

function conversation() {
  return createConversationMachine(context(), { createAgentMachine: ctx => createAgentMachine(ctx, actions()) });
}

test("serializes completion, recording and replacement before the next user event", async () => {
  const parent = conversation();
  await parent.fire({ type: "user", text: "first" });
  const first = parent.snapshot;
  await Promise.all([
    parent.fire({ type: "agent", turnId: first.turnId, event: { type: "model_done", text: "answer" } }),
    parent.fire({ type: "user", text: "second" }),
  ]);
  expect(parent.snapshot.log).toEqual([{ agent: "writer", completion: "completed", messages: [
    { role: "user", text: "first" }, { role: "assistant", text: "answer" },
  ] }]);
  expect(parent.snapshot.child).not.toBe(first.child);
  expect(parent.snapshot.agentContext.messages).toEqual([{ role: "user", text: "second" }]);
  await parent.fire({ type: "agent", turnId: first.turnId, event: { type: "abort" } });
  expect(parent.snapshot.child.snapshot.state).toBe("awaiting_model");
});

test("records terminal reason, clears transient context and restores the per-turn budget", async () => {
  const parent = createConversationMachine(context(), { createAgentMachine: ctx => createAgentMachine(ctx, actions({
    startCompletion: current => ({ ...current, budget: { ...current.budget, steps: 0 },
      operation: { id: 1, kind: "model", controller: new AbortController() } }),
  })) });
  await parent.fire({ type: "user", text: "first" });
  await parent.fire({ type: "agent", turnId: 1, event: { type: "failed", error: "offline" } });
  expect(parent.snapshot.log[0]?.completion).toBe("failed");
  expect(parent.snapshot.log[0]?.error).toBe("offline");
  expect(parent.snapshot.agentContext).toEqual(context());
});

test("deeply freezes recorded tool arguments and preserves earlier snapshots", async () => {
  const parent = conversation();
  await parent.fire({ type: "user", text: "first" });
  await parent.fire({ type: "agent", turnId: 1, event: { type: "model_done", text: "", toolCalls: [
    { id: "1", name: "search", args: { nested: { value: 1 } } },
  ] } });
  await parent.fire({ type: "abort" });
  const snapshot = parent.snapshot;
  const call = snapshot.log[0]!.messages[1]!.toolCalls![0]!;
  expect(Object.isFrozen(call.args)).toBe(true);
  expect(Object.isFrozen((call.args as { nested: unknown }).nested)).toBe(true);
  expect(snapshot.log[0]?.completion).toBe("aborted");
  expect(parent.snapshot.agentContext.pendingTools).toEqual([]);
  await parent.fire({ type: "user", text: "second" });
  await parent.fire({ type: "abort" });
  expect(snapshot.log).toHaveLength(1);
  expect(parent.snapshot.log[0]).toBe(snapshot.log[0]!);
});
