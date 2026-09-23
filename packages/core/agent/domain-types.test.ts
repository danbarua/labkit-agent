import { expect, test } from "bun:test";

import type { ForkSnapshot, SessionRequest } from "./agent-conversation.ts";
import type { TurnState } from "./agent-fsm.ts";
import type { OperationState } from "./operation-actor.ts";
import { context } from "./test-support.ts";
import type { BatchState } from "./tool-batch.ts";
import { ref, SessionIdSchema, type Ref } from "./types.ts";

// Typechecked by tsc, never executed: each directive must correspond to a compiler error.
function invalidStates() {
  const turn = context();
  // @ts-expect-error idle cannot carry active work
  const idle: TurnState = {
    status: "idle",
    id: turn.id,
    agent: turn.agent,
    steps: turn.steps,
    child: ref("completion", "request"),
  };
  // @ts-expect-error preparation requires a validated positive allowance
  const preparing: TurnState = {
    status: "preparing_model",
    turn,
    child: ref("prepare", "request"),
  };
  // @ts-expect-error done requires an outcome
  const done: TurnState = { status: "done", record: { agent: turn.agent, messages: [] } };
  // @ts-expect-error executing tools requires a batch reference
  const executing: TurnState = {
    status: "executing_tools",
    turn,
    child: ref("completion", "request"),
  };
  // @ts-expect-error running batch must have a validated nonempty pending set
  const batch: BatchState = { status: "running", calls: [], pending: [], results: [] };
  // @ts-expect-error success requires validated complete results
  const success: BatchState = { status: "settled", outcome: { kind: "succeeded", results: [] } };
  // @ts-expect-error only running carries request identity
  const ready: OperationState<string> = { status: "ready", request: ref("completion", "request") };
  // @ts-expect-error successful operation must carry its result
  const completed: OperationState<string> = { status: "succeeded" };
  // @ts-expect-error actor references cannot cross operation kinds
  const reference: Ref<"completion"> = ref("tool", "request");
  const sessionId = SessionIdSchema.parse(crypto.randomUUID());
  // @ts-expect-error compaction messages must pass the context constructor
  const compact: SessionRequest = { kind: "compact", id: turn.id, sessionId, context: [] };
  // @ts-expect-error a published fork cannot carry an active child
  const activeFork: ForkSnapshot["turn"] = {
    status: "awaiting_model",
    turn,
    child: ref("completion", "request"),
  };
  // @ts-expect-error a fork never inherits its parent's queued requests
  const queuedFork: ForkSnapshot["pending"] = [{ kind: "fork", id: turn.id, sessionId }];
  void [
    idle,
    preparing,
    done,
    executing,
    batch,
    success,
    ready,
    completed,
    reference,
    compact,
    activeFork,
    queuedFork,
  ];
}
test("domain invariant type assertions are included in the TypeScript check", () => {
  expect(typeof invalidStates).toBe("function");
});
