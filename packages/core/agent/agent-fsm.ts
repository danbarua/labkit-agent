import type { z } from "zod";

import { defineMachine, stay, type Decision } from "../fsm/fsm.ts";
import type { Continuation } from "../providers/types.ts";
import type { CompletionUsage } from "../providers/usage.ts";
import type { PreparedModel } from "./agent.ts";
import { validatePermissionDecisions, type PermissionDecisions } from "./permissions.ts";
import type { BatchOutcome } from "./tool-batch.ts";
import {
  appendMessage,
  CompletionSchema,
  failure,
  PositiveStepsSchema,
  ref,
  StepsSchema,
  type ActorId,
  type AgentId,
  type AgentMessage,
  type ChildRef,
  type Completion,
  type Failure,
  type Outcome,
  type PositiveSteps,
  type Ref,
  type Result,
  type Steps,
  type TurnData,
  type TurnRecord,
} from "./types.ts";

/**
 * Builds the schema that admits a model completion against the live registry: a handoff must name a
 * known agent and every tool call must name a permitted tool. "Admitted" here means checked against
 * the registry (not an input receipt). The completion operation parses its output with this schema
 * before the turn sees it as a `model_settled` event.
 * @param agents Agent ids a handoff may target.
 * @param tools Tool names the step may call.
 */
export const admittedCompletionSchema = (agents: ReadonlySet<string>, tools: ReadonlySet<string>) =>
  CompletionSchema.refine(
    (result) => result.kind !== "handoff" || agents.has(result.agent),
    "Unknown handoff agent",
  )
    .refine(
      (result) => result.kind !== "tools" || result.calls.every((call) => tools.has(call.name)),
      "Unpermitted tool",
    )
    .brand<"AdmittedCompletion">();

/** A step's completion that passed {@link admittedCompletionSchema}; the only completion the turn machine accepts. */
export type AdmittedCompletion = z.infer<ReturnType<typeof admittedCompletionSchema>>;

/**
 * State of one turn: from the user prompt until the model stops. Each active state holds exactly one
 * `child`: the operation the turn is waiting on (not a child session). A step runs
 * `preparing_model` → `awaiting_model`, then ends the turn, hands off, or runs its tool batch
 * (optionally after `awaiting_permission`) before the next step starts.
 */
export type TurnState =
  /** No prompt yet. `steps` is the allowance the turn will start with. */
  | Readonly<{ status: "idle"; id: ActorId; agent: AgentId; steps: Steps }>
  /**
   * Step boundary: the prompt projection for the next step is being assembled. `turn.steps` is at
   * least 1 here and is decremented when the model is called. User input here is a barge-in.
   */
  | Readonly<{
      status: "preparing_model";
      turn: TurnData & { readonly steps: PositiveSteps };
      child: Ref<"prepare">;
    }>
  /** The step's LLM call is in flight. User input here is a barge-in that re-issues the step. */
  | Readonly<{ status: "awaiting_model"; turn: TurnData; child: Ref<"completion"> }>
  /**
   * The settled step handed off; the successor agent's handoff context is being prepared. `turn.agent`
   * is already the successor. User input here restarts preparation like a barge-in.
   */
  | Readonly<{ status: "preparing_handoff"; turn: TurnData; child: Ref<"handoff"> }>
  /**
   * The settled step proposed tool calls that need user permission. `batch` is the ref the tool
   * batch will use once permission is granted.
   */
  | Readonly<{
      status: "awaiting_permission";
      turn: TurnData;
      child: Ref<"permission">;
      batch: Ref<"batch">;
      completion: Extract<Completion, { kind: "tools" }>;
    }>
  /** The step's tool batch is running; the next step starts only after the whole batch settles. */
  | Readonly<{ status: "executing_tools"; turn: TurnData; child: Ref<"batch"> }>
  /**
   * Abort arrived while tools ran; waiting for the batch to settle so finished results are kept. The
   * turn then ends aborted.
   */
  | Readonly<{ status: "cancelling_tools"; turn: TurnData; child: Ref<"batch"> }>
  /** The turn ended; `record` holds its messages and outcome. */
  | Readonly<{ status: "done"; record: TurnRecord }>;

/**
 * Input to the turn machine: user input, abort, or the settlement of the turn's current child
 * operation. Settlement events whose `child` is not the current child are ignored as late, and
 * events without an edge in the current state are ignored.
 */
export type TurnEvent =
  /**
   * User text. When idle it starts the turn. While preparing or awaiting the model, or preparing a
   * handoff, it is a barge-in: the child is cancelled, the text is appended and the step is prepared
   * again. It has no edge while permission or tools are pending.
   */
  | { type: "user"; text: string }
  /** Ends the turn as aborted. While tools run it first waits for the batch to settle (`cancelling_tools`). */
  | { type: "abort" }
  /** The step's prompt projection settled; on success the model is called. */
  | { type: "prepared"; child: Ref<"prepare">; result: Result<PreparedModel> }
  /**
   * The step's LLM call settled (a settled step). An answer ends the turn completed; tool calls start
   * the batch or a permission request; a handoff prepares the successor agent.
   * @property continuation Provider continuation payload (thinking signatures), not the next step.
   * @property permissionRequired Ask the user before running the proposed tool calls.
   */
  | {
      type: "model_settled";
      child: Ref<"completion">;
      result: Result<AdmittedCompletion>;
      continuation?: Continuation;
      usage?: CompletionUsage;
      permissionRequired?: true;
    }
  /** The successor agent's handoff context is ready; the next step is prepared with it. */
  | { type: "handoff_prepared"; child: Ref<"handoff">; result: Result<readonly AgentMessage[]> }
  /**
   * The user answered the permission request. Any `reject_once` ends the turn failed
   * (`permission_refused`); any `cancelled` ends it aborted; otherwise the batch runs.
   */
  | { type: "permission_settled"; child: Ref<"permission">; result: Result<PermissionDecisions> }
  /**
   * The step's whole tool batch settled. Collected results are appended as tool messages; a
   * succeeded batch prepares the next step, a failed or cancelled one ends the turn.
   */
  | { type: "batch_settled"; child: Ref<"batch">; outcome: BatchOutcome }
  /** Dispatching or running the current child failed outside its result; ends the turn failed. */
  | { type: "failed"; child: ChildRef; error: Failure };

/**
 * Effect the turn asks its host to perform after a decision commits. Each command that names a
 * `child` starts that child operation; its settlement comes back as a {@link TurnEvent}.
 */
export type TurnCommand =
  /** Assemble the next step's prompt (prompt projection); answers with `prepared`. */
  | { type: "prepare_model"; child: Ref<"prepare">; turn: TurnData }
  /** Make the step's LLM call with the prepared request; answers with `model_settled`. */
  | { type: "complete"; child: Ref<"completion">; turn: TurnData; request: PreparedModel }
  /** Build the successor agent's handoff context; `turn.agent` is the successor. Answers with `handoff_prepared`. */
  | { type: "prepare_handoff"; child: Ref<"handoff">; turn: TurnData; from: AgentId }
  /** Ask the user to permit the step's tool calls; answers with `permission_settled`. */
  | {
      type: "request_permission";
      child: Ref<"permission">;
      batch: Ref<"batch">;
      completion: Extract<Completion, { kind: "tools" }>;
    }
  /**
   * Run the step's tool batch; answers with `batch_settled`. `permission` names the permission
   * operation whose grants apply, when one ran.
   */
  | {
      type: "run_tools";
      child: Ref<"batch">;
      permission?: Ref<"permission">;
      completion: Extract<Completion, { kind: "tools" }>;
    }
  /** Cancel a child operation the turn no longer waits for (abort, failure or barge-in). */
  | { type: "cancel"; child: ChildRef };

type Active = Exclude<TurnState, { status: "idle" | "done" }>;

type D = Decision<TurnState, TurnCommand>;

function done(turn: TurnData, outcome: Outcome): D {
  return {
    state: { status: "done", record: { agent: turn.agent, messages: turn.messages, outcome } },
    commands: [],
  };
}

function prepare(turn: TurnData): D {
  if (turn.steps === 0) return done(turn, { kind: "exhausted" });
  const next = {
    ...turn,
    steps: PositiveStepsSchema.parse(turn.steps),
    generation: turn.generation + 1,
  };
  const child = ref("prepare", `${turn.id}/${next.generation}`);
  return {
    state: { status: "preparing_model", turn: next, child },
    commands: [{ type: "prepare_model", child, turn: next }],
  };
}

function abort(state: Active): D {
  return {
    ...done(state.turn, {
      kind: "aborted",
      reason: failure({
        message: "User cancelled the active turn",
        classification: "cancelled",
        operation: { ...state.child, turnId: state.turn.id },
      }),
    }),
    commands: [{ type: "cancel", child: state.child }],
  };
}

function fail(state: Active, event: { child: ChildRef; error: Failure }): D {
  if (event.child.id !== state.child.id || event.child.kind !== state.child.kind)
    return stay(state);
  return {
    ...done(state.turn, { kind: "failed", error: event.error }),
    commands: [{ type: "cancel", child: state.child }],
  };
}

function resultFailure(turn: TurnData, result: Exclude<Result<unknown>, { kind: "succeeded" }>): D {
  return done(
    turn,
    result.kind === "failed" ? { kind: "failed", error: result.error } : { kind: "aborted" },
  );
}

function bargeIn(state: Active, event: { text: string }): D {
  const next = prepare(appendMessage(state.turn, { role: "user", text: event.text }));
  return { ...next, commands: [{ type: "cancel", child: state.child }, ...next.commands] };
}

/**
 * The turn machine: a pure transition from a {@link TurnState} and {@link TurnEvent} to the next
 * state and the {@link TurnCommand}s to dispatch. Each step consumes one of the turn's steps when the
 * model is called; a turn with no steps left at a step boundary ends `exhausted`.
 */
export const decideTurn = defineMachine<TurnState, TurnEvent, TurnCommand>({
  idle: {
    user: (state, event) =>
      prepare({
        id: state.id,
        generation: 0,
        agent: state.agent,
        steps: state.steps,
        messages: [{ role: "user", text: event.text }],
        view: { kind: "history" },
      }),
    abort: (state) => ({
      state: {
        status: "done",
        record: { agent: state.agent, messages: [], outcome: { kind: "aborted" } },
      },
      commands: [],
    }),
  },
  preparing_model: {
    user: bargeIn,
    abort,
    failed: fail,
    prepared: (state, event) => {
      if (event.child.id !== state.child.id) return stay(state);
      if (event.result.kind !== "succeeded") return resultFailure(state.turn, event.result);
      const turn = {
        ...state.turn,
        generation: state.turn.generation + 1,
        steps: StepsSchema.parse(state.turn.steps - 1),
      };
      const child = ref("completion", `${turn.id}/${turn.generation}`);
      return {
        state: { status: "awaiting_model", turn, child },
        commands: [{ type: "complete", child, turn, request: event.result.value }],
      };
    },
  },
  awaiting_model: {
    user: bargeIn,
    abort,
    failed: fail,
    model_settled: (state, event) => {
      if (event.child.id !== state.child.id) return stay(state);
      if (event.result.kind !== "succeeded") return resultFailure(state.turn, event.result);
      const result = event.result.value;
      const turn = appendMessage(
        state.turn,
        result.kind === "tools"
          ? { role: "assistant", text: result.text, calls: result.calls }
          : { role: "assistant", text: result.text },
      );
      if (result.kind === "answer") return done(turn, { kind: "completed" });
      const next = { ...turn, generation: turn.generation + 1 };
      if (result.kind === "tools") {
        if (event.permissionRequired) {
          const child = ref("permission", `${turn.id}/${next.generation}`);
          const batch = ref("batch", `${turn.id}/${next.generation + 1}`);
          return {
            state: { status: "awaiting_permission", turn: next, child, batch, completion: result },
            commands: [{ type: "request_permission", child, batch, completion: result }],
          };
        }
        const child = ref("batch", `${turn.id}/${next.generation}`);
        return {
          state: { status: "executing_tools", turn: next, child },
          commands: [{ type: "run_tools", child, completion: result }],
        };
      }
      const child = ref("handoff", `${turn.id}/${next.generation}`);
      const successor = { ...next, agent: result.agent };
      return {
        state: { status: "preparing_handoff", turn: successor, child },
        commands: [{ type: "prepare_handoff", child, turn: successor, from: turn.agent }],
      };
    },
  },
  preparing_handoff: {
    user: bargeIn,
    abort,
    failed: fail,
    handoff_prepared: (state, event) => {
      if (event.child.id !== state.child.id) return stay(state);
      if (event.result.kind !== "succeeded") return resultFailure(state.turn, event.result);
      return prepare({ ...state.turn, view: { kind: "handoff", messages: event.result.value } });
    },
  },
  awaiting_permission: {
    abort,
    failed: fail,
    permission_settled: (state, event) => {
      if (event.child.id !== state.child.id) return stay(state);
      if (event.result.kind !== "succeeded") return resultFailure(state.turn, event.result);
      const decisions = validatePermissionDecisions(state.completion.calls, event.result.value);
      const refused = decisions.find(
        (entry) => entry.decision === "reject_once" || entry.decision === "cancelled",
      );
      if (refused)
        return done(
          state.turn,
          refused.decision === "cancelled"
            ? {
                kind: "aborted",
                reason: failure({
                  message: "User cancelled permission request",
                  classification: "cancelled",
                  operation: { ...state.child, turnId: state.turn.id, callId: refused.callId },
                }),
              }
            : {
                kind: "failed",
                error: failure({
                  message: "Tool permission rejected",
                  classification: "permission_refused",
                  phase: "permission",
                  operation: {
                    id: state.child.id,
                    kind: "permission",
                    turnId: state.turn.id,
                    callId: refused.callId,
                    toolName: state.completion.calls.find((call) => call.id === refused.callId)!
                      .name,
                  },
                }),
              },
        );
      return {
        state: {
          status: "executing_tools",
          turn: { ...state.turn, generation: state.turn.generation + 1 },
          child: state.batch,
        },
        commands: [
          {
            type: "run_tools",
            child: state.batch,
            permission: state.child,
            completion: state.completion,
          },
        ],
      };
    },
  },
  executing_tools: {
    abort: (state) => ({
      state: { ...state, status: "cancelling_tools" },
      commands: [{ type: "cancel", child: state.child }],
    }),
    failed: fail,
    batch_settled: (state, event) => {
      if (event.child.id !== state.child.id) return stay(state);
      const turn = event.outcome.results.reduce(
        (current, result) =>
          appendMessage(current, {
            role: "tool",
            text: result.text,
            callId: result.callId,
          }),
        state.turn,
      );
      return event.outcome.kind === "succeeded"
        ? prepare(turn)
        : resultFailure(turn, event.outcome);
    },
  },
  cancelling_tools: {
    failed: fail,
    batch_settled: (state, event) => {
      if (event.child.id !== state.child.id) return stay(state);
      const turn = event.outcome.results.reduce(
        (current, result) =>
          appendMessage(current, {
            role: "tool",
            text: result.text,
            callId: result.callId,
          }),
        state.turn,
      );
      return done(turn, {
        kind: "aborted",
        reason: failure({
          message: "User cancelled the active tool batch",
          classification: "cancelled",
          operation: { ...state.child, turnId: turn.id },
        }),
      });
    },
  },
  done: {},
});
