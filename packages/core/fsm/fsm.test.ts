import { expect, test } from "bun:test";

import { Actor, defineMachine } from "./fsm.ts";

type State =
  { status: "idle" } | { status: "running"; value: number } | { status: "failed"; error: string };
type Event =
  { type: "start" } | { type: "add" } | { type: "bad" } | { type: "failed"; error: string };
type Command = { type: "work" };
const decide = defineMachine<State, Event, Command>({
  idle: { start: () => ({ state: { status: "running", value: 0 }, commands: [{ type: "work" }] }) },
  running: {
    add: (state) => ({ state: { ...state, value: state.value + 1 }, commands: [] }),
    bad: () => {
      throw new Error("invalid decision");
    },
    failed: (_, event) => ({ state: { status: "failed", error: event.error }, commands: [] }),
  },
  failed: {},
});
test("commits a complete frozen state before dispatching commands or reentrant events", async () => {
  const seen: State[] = [];
  const actor = new Actor<State, Event, Command>(
    { status: "idle" },
    decide,
    () => {
      seen.push(actor.snapshot);
      expect(Object.isFrozen(actor.snapshot)).toBe(true);
      void actor.send({ type: "add" });
      return undefined;
    },
    (_, error) => ({ type: "failed", error: String(error) }),
  );
  await actor.send({ type: "start" });
  await actor.send({ type: "add" });
  expect(seen).toEqual([{ status: "running", value: 0 }]);
  expect(actor.snapshot).toEqual({ status: "running", value: 2 });
});
test("a rejected decision preserves state and dispatches nothing; the mailbox recovers", async () => {
  let commands = 0;
  const actor = new Actor<State, Event, Command>(
    { status: "idle" },
    decide,
    () => {
      commands++;
      return undefined;
    },
    (_, error) => ({ type: "failed", error: String(error) }),
  );
  await actor.send({ type: "start" });
  const before = actor.snapshot;
  await expect(actor.send({ type: "bad" })).rejects.toThrow("invalid decision");
  expect(actor.snapshot).toBe(before);
  expect(commands).toBe(1);
  await Promise.all([actor.send({ type: "add" }), actor.send({ type: "add" })]);
  expect(actor.snapshot).toEqual({ status: "running", value: 2 });
});
test("command failure is another event and does not undo the committed transition", async () => {
  let observed: State | undefined;
  const actor = new Actor<State, Event, Command>(
    { status: "idle" },
    decide,
    () => {
      observed = actor.snapshot;
      throw new Error("offline");
    },
    (_, error) => ({ type: "failed", error: String(error) }),
  );
  await actor.send({ type: "start" });
  await actor.send({ type: "add" });
  expect(observed).toEqual({ status: "running", value: 0 });
  expect(actor.snapshot).toEqual({ status: "failed", error: "Error: offline" });
  const terminal = actor.snapshot;
  await actor.send({ type: "start" });
  expect(actor.snapshot).toBe(terminal);
});
