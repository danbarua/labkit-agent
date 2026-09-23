import { Actor, defineMachine, type Decision } from "../fsm/fsm.ts";
import { failure, type ChildRef, type Failure, type Result } from "./types.ts";

export type OperationState<T> =
  | Readonly<{ status: "ready" }>
  | Readonly<{ status: "validating_input" }>
  | Readonly<{ status: "running"; request: ChildRef }>
  | Readonly<{ status: "validating_output" }>
  | Readonly<{ status: "succeeded"; value: T }>
  | Readonly<{ status: "failed"; error: Failure }>
  | Readonly<{ status: "cancelled" }>;

type Event<I, O> =
  | { type: "start" }
  | { type: "cancel" }
  | { type: "input_valid"; value: I }
  | { type: "returned"; value: unknown }
  | { type: "output_valid"; value: O }
  | { type: "failed"; error: Failure };
type Command<I, O> =
  | { type: "validate_input" }
  | { type: "run"; input: I }
  | { type: "validate_output"; value: unknown }
  | { type: "cancel" }
  | { type: "notify"; result: Result<O> };

export type Operation<I, O> = {
  input: unknown;
  parseInput: (input: unknown) => I | Promise<I>;
  run: (input: I, signal: AbortSignal) => unknown | Promise<unknown>;
  parseOutput: (output: unknown) => O | Promise<O>;
};

/** Controllers and arbitrary values stay in the adapter; only validated outputs enter snapshots. */
export function createOperationActor<I, O>(
  request: ChildRef,
  operation: Operation<I, O>,
  settled: (result: Result<O>) => void,
) {
  type State = OperationState<O>;
  type Cmd = Command<I, O>;
  const cancel = (): Decision<State, Cmd> => ({
    state: { status: "cancelled" },
    commands: [{ type: "cancel" }, { type: "notify", result: { kind: "cancelled" } }],
  });
  const fail = (
    _: State,
    event: Extract<Event<I, O>, { type: "failed" }>,
  ): Decision<State, Cmd> => ({
    state: { status: "failed", error: event.error },
    commands: [
      { type: "cancel" },
      { type: "notify", result: { kind: "failed", error: event.error } },
    ],
  });
  const decide = defineMachine<State, Event<I, O>, Cmd>({
    ready: {
      start: () => ({
        state: { status: "validating_input" },
        commands: [{ type: "validate_input" }],
      }),
      cancel,
      failed: fail,
    },
    validating_input: {
      input_valid: (_, event) => ({
        state: { status: "running", request },
        commands: [{ type: "run", input: event.value }],
      }),
      cancel,
      failed: fail,
    },
    running: {
      returned: (_, event) => ({
        state: { status: "validating_output" },
        commands: [{ type: "validate_output", value: event.value }],
      }),
      cancel,
      failed: fail,
    },
    validating_output: {
      output_valid: (_, event) => ({
        state: { status: "succeeded", value: event.value },
        commands: [{ type: "notify", result: { kind: "succeeded", value: event.value } }],
      }),
      cancel,
      failed: fail,
    },
    succeeded: {},
    failed: {},
    cancelled: {},
  });
  const controller = new AbortController();
  let actor: Actor<State, Event<I, O>, Cmd>;
  const execute = (command: Cmd): undefined => {
    const launch = <T>(work: () => T | Promise<T>, done: (value: T) => Event<I, O>) => {
      void Promise.resolve()
        .then(() => {
          controller.signal.throwIfAborted();
          return work();
        })
        .then((value) => actor.send(done(value)))
        .catch((error) => actor.send({ type: "failed", error: failure(error) }));
    };
    switch (command.type) {
      case "validate_input":
        launch(
          () => operation.parseInput(operation.input),
          (value) => ({ type: "input_valid", value }),
        );
        break;
      case "run":
        launch(
          () => operation.run(command.input, controller.signal),
          (value) => ({ type: "returned", value }),
        );
        break;
      case "validate_output":
        launch(
          () => operation.parseOutput(command.value),
          (value) => ({ type: "output_valid", value }),
        );
        break;
      case "cancel":
        controller.abort();
        break;
      case "notify":
        settled(command.result);
        break;
    }
    return undefined;
  };
  actor = new Actor<State, Event<I, O>, Cmd>({ status: "ready" }, decide, execute, (_, error) => ({
    type: "failed",
    error: failure(error),
  }));
  return {
    get snapshot() {
      return actor.snapshot;
    },
    start: () => actor.send({ type: "start" }),
    cancel: () => actor.send({ type: "cancel" }),
  };
}
