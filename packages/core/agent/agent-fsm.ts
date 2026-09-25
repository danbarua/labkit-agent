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

/** Dynamic registry admission is applied before the completion is sent to the turn. */
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

export type AdmittedCompletion = z.infer<ReturnType<typeof admittedCompletionSchema>>;

export type TurnState =
  | Readonly<{ status: "idle"; id: ActorId; agent: AgentId; steps: Steps }>
  | Readonly<{
      status: "preparing_model";
      turn: TurnData & { readonly steps: PositiveSteps };
      child: Ref<"prepare">;
    }>
  | Readonly<{ status: "awaiting_model"; turn: TurnData; child: Ref<"completion"> }>
  | Readonly<{ status: "preparing_handoff"; turn: TurnData; child: Ref<"handoff"> }>
  | Readonly<{
      status: "awaiting_permission";
      turn: TurnData;
      child: Ref<"permission">;
      batch: Ref<"batch">;
      completion: Extract<Completion, { kind: "tools" }>;
    }>
  | Readonly<{ status: "executing_tools"; turn: TurnData; child: Ref<"batch"> }>
  | Readonly<{ status: "cancelling_tools"; turn: TurnData; child: Ref<"batch"> }>
  | Readonly<{ status: "done"; record: TurnRecord }>;

export type TurnEvent =
  | { type: "user"; text: string }
  | { type: "abort" }
  | { type: "prepared"; child: Ref<"prepare">; result: Result<PreparedModel> }
  | {
      type: "model_settled";
      child: Ref<"completion">;
      result: Result<AdmittedCompletion>;
      continuation?: Continuation;
      usage?: CompletionUsage;
      permissionRequired?: true;
    }
  | { type: "handoff_prepared"; child: Ref<"handoff">; result: Result<readonly AgentMessage[]> }
  | { type: "permission_settled"; child: Ref<"permission">; result: Result<PermissionDecisions> }
  | { type: "batch_settled"; child: Ref<"batch">; outcome: BatchOutcome }
  | { type: "failed"; child: ChildRef; error: Failure };

export type TurnCommand =
  | { type: "prepare_model"; child: Ref<"prepare">; turn: TurnData }
  | { type: "complete"; child: Ref<"completion">; turn: TurnData; request: PreparedModel }
  | { type: "prepare_handoff"; child: Ref<"handoff">; turn: TurnData; from: AgentId }
  | {
      type: "request_permission";
      child: Ref<"permission">;
      batch: Ref<"batch">;
      completion: Extract<Completion, { kind: "tools" }>;
    }
  | {
      type: "run_tools";
      child: Ref<"batch">;
      permission?: Ref<"permission">;
      completion: Extract<Completion, { kind: "tools" }>;
    }
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
