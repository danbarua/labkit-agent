import { expect, test } from "bun:test";

import { admittedCompletionSchema, decideTurn, type TurnState } from "./agent-fsm.ts";
import { PreparedModelSchema } from "./agent.ts";
import { context } from "./test-support.ts";
import { ref } from "./types.ts";

const initial = (): TurnState => {
  const { id, agent, steps } = context();
  return { status: "idle", id, agent, steps };
};
const admitted = admittedCompletionSchema(new Set(["writer", "reviewer"]), new Set(["search"]));
function awaiting() {
  const preparing = decideTurn(initial(), { type: "user", text: "hello" }).state;
  if (preparing.status !== "preparing_model") throw new Error("Expected preparation");
  const next = decideTurn(preparing, {
    type: "prepared",
    child: preparing.child,
    result: {
      kind: "succeeded",
      value: PreparedModelSchema.parse({
        baseUrl: "http://localhost",
        model: "writer",
        messages: [],
      }),
    },
  }).state;
  if (next.status !== "awaiting_model") throw new Error("Expected completion");
  return next;
}
test("barge-in replaces the reference and emits cancellation in one pure decision", () => {
  const state = awaiting();
  const next = decideTurn(state, { type: "user", text: "actually" });
  expect(next.commands.map((command) => command.type)).toEqual(["cancel", "prepare_model"]);
  expect(next.state.status).toBe("preparing_model");
  if (next.state.status !== "preparing_model") throw new Error();
  expect(next.state.child.id).not.toBe(state.child.id);
  expect(next.state.turn.messages.map((message) => message.text)).toEqual(["hello", "actually"]);
  expect(state.turn.messages).toHaveLength(1);
  expect(
    decideTurn(next.state, {
      type: "model_settled",
      child: state.child,
      result: { kind: "succeeded", value: admitted.parse({ kind: "answer", text: "late" }) },
    }).state,
  ).toBe(next.state);
});
test("handoff changes agent and child together; stale same-kind requests cannot satisfy it", () => {
  const state = awaiting();
  expect(
    decideTurn(state, {
      type: "model_settled",
      child: ref("completion", "old"),
      result: { kind: "succeeded", value: admitted.parse({ kind: "answer", text: "late" }) },
    }).state,
  ).toBe(state);
  const next = decideTurn(state, {
    type: "model_settled",
    child: state.child,
    result: {
      kind: "succeeded",
      value: admitted.parse({ kind: "handoff", text: "review", agent: "reviewer" }),
    },
  });
  expect(next.state).toMatchObject({
    status: "preparing_handoff",
    turn: { agent: "reviewer" },
    child: { kind: "handoff" },
  });
  expect(next.commands[0]).toMatchObject({
    type: "prepare_handoff",
    from: "writer",
    turn: { agent: "reviewer" },
  });
});
test("completion and abort require outcomes and terminal states ignore late events", () => {
  const state = awaiting();
  const next = decideTurn(state, {
    type: "model_settled",
    child: state.child,
    result: { kind: "succeeded", value: admitted.parse({ kind: "answer", text: "done" }) },
  }).state;
  expect(next).toMatchObject({ status: "done", record: { outcome: { kind: "completed" } } });
  expect(decideTurn(next, { type: "abort" }).state).toBe(next);
  expect(decideTurn(state, { type: "abort" })).toMatchObject({
    state: { status: "done", record: { outcome: { kind: "aborted" } } },
    commands: [{ type: "cancel", child: state.child }],
  });
});
test("admission rejects empty batches, duplicate calls and unknown names", () => {
  for (const result of [
    { kind: "tools", text: "", calls: [] },
    {
      kind: "tools",
      text: "",
      calls: [
        { id: "a", name: "search", args: {} },
        { id: "a", name: "search", args: {} },
      ],
    },
    { kind: "tools", text: "", calls: [{ id: "a", name: "unknown", args: {} }] },
    { kind: "handoff", text: "", agent: "unknown" },
  ])
    expect(() => admitted.parse(result)).toThrow();
});
