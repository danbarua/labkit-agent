import { Actor, defineMachine, type Decision } from "../fsm/fsm.ts";
import { failure, type ChildRef, type Failure, type Result } from "./types.ts";

/**
 * State of one child operation of a turn (not a child session), such as a prompt projection, LLM
 * call, permission request, handoff or single tool call. It runs ready → validating_input → running →
 * validating_output → succeeded; `failed` and `cancelled` are reachable from any non-terminal state.
 */
export type OperationState<T> =
  | Readonly<{ status: "ready" }>
  | Readonly<{ status: "validating_input" }>
  | Readonly<{ status: "running"; request: ChildRef }>
  | Readonly<{ status: "validating_output" }>
  | Readonly<{ status: "succeeded"; value: T }>
  /** Failed while validating or running, or cancelled with a `timeout` reason. */
  | Readonly<{ status: "failed"; error: Failure }>
  | Readonly<{ status: "cancelled"; reason?: Failure }>;

type Event<I, O> =
  | { type: "start" }
  | { type: "cancel"; reason?: Failure }
  | { type: "input_valid"; value: I }
  | { type: "returned"; value: unknown }
  | { type: "output_valid"; value: O }
  | { type: "failed"; error: Failure };

type Command<I, O> =
  | { type: "observe" }
  | { type: "validate_input" }
  | { type: "run"; input: I }
  | { type: "validate_output"; value: unknown }
  | { type: "cancel"; reason?: Failure }
  | { type: "notify"; result: Result<O> };

/** The work an operation actor runs: parse the untrusted input, run, then parse the untrusted output. */
export type Operation<I, O> = {
  /** Untrusted input, parsed by `parseInput`. */
  input: unknown;
  /** Merged into every failure the operation reports. */
  failureContext?: Partial<Failure>;
  /** Deadline in ms, enforced by the host (not the actor): on expiry the operation fails with `timeout`. */
  timeoutMs?: number;
  /** Rejections fail the operation as `invalid_input`. */
  parseInput: (input: unknown) => I | Promise<I>;
  /** `signal` aborts on cancel. Rejections fail the operation as `execution`. */
  run: (input: I, signal: AbortSignal) => unknown | Promise<unknown>;
  /** Rejections fail the operation as `invalid_output`. */
  parseOutput: (output: unknown) => O | Promise<O>;
};

/**
 * Creates the actor that runs one child operation of a turn. Nothing runs until `start()`.
 * Controllers and arbitrary values stay in the adapter; only validated outputs enter snapshots.
 * @param settled Called exactly once with the result when the operation succeeds, fails or is cancelled.
 * A cancel whose reason is classified `timeout` settles as `failed`, not `cancelled`.
 * @param observe Called with each new state for display; its errors are ignored.
 * @returns `snapshot`, `start()` and `cancel(reason?)`. Their promises resolve when the event is
 * decided, not when the operation settles; `settled` reports that.
 */
export function createOperationActor<I, O>(
  request: ChildRef,
  operation: Operation<I, O>,
  settled: (result: Result<O>) => void,
  observe?: (state: OperationState<O>) => unknown,
) {
  type State = OperationState<O>;
  type Cmd = Command<I, O>;
  const cancel = (
    _: State,
    event: Extract<Event<I, O>, { type: "cancel" }>,
  ): Decision<State, Cmd> =>
    event.reason?.classification === "timeout"
      ? {
          state: { status: "failed", error: event.reason },
          commands: [
            { type: "cancel", reason: event.reason },
            { type: "notify", result: { kind: "failed", error: event.reason } },
          ],
        }
      : {
          state: { status: "cancelled", ...(event.reason ? { reason: event.reason } : {}) },
          commands: [
            { type: "cancel", reason: event.reason },
            { type: "notify", result: { kind: "cancelled" } },
          ],
        };
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
        .catch((error) =>
          actor.send({
            type: "failed",
            error: failure(error, {
              classification:
                command.type === "validate_input"
                  ? "invalid_input"
                  : command.type === "validate_output"
                    ? "invalid_output"
                    : "execution",
              ...operation.failureContext,
              operation: {
                id: request.id,
                kind: request.kind,
                ...operation.failureContext?.operation,
              },
              phase: command.type,
            }),
          }),
        );
    };
    switch (command.type) {
      case "observe":
        // Display only: observer failures must never become operation failures.
        try {
          void Promise.resolve(observe?.(actor.snapshot)).catch(() => {});
        } catch {}
        break;
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
        controller.abort(command.reason);
        break;
      case "notify":
        settled(command.result);
        break;
    }
    return undefined;
  };
  actor = new Actor<State, Event<I, O>, Cmd>(
    { status: "ready" },
    (state, event) => {
      const decision = decide(state, event);
      return observe && decision.state !== state
        ? { ...decision, commands: [{ type: "observe" }, ...decision.commands] }
        : decision;
    },
    execute,
    (_, error) => ({ type: "failed", error: failure(error) }),
  );
  return {
    get snapshot() {
      return actor.snapshot;
    },
    start: () => actor.send({ type: "start" }),
    cancel: (reason?: Failure) =>
      actor.send({ type: "cancel", reason: reason ? failure(reason) : undefined }),
  };
}
