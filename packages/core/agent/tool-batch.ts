import { z } from "zod";

import { defineMachine, stay, type Decision } from "../fsm/fsm.ts";
import {
  ref,
  ToolCallIdSchema,
  ToolCallsSchema,
  type Failure,
  type Ref,
  type Result,
  type ToolCalls,
} from "./types.ts";

/** Result text of one tool call, as sent back to the model in the next step. */
export const ToolResultSchema = z
  .strictObject({ callId: ToolCallIdSchema, text: z.string() })
  .readonly();
/** See {@link ToolResultSchema}. */
export type ToolResult = z.infer<typeof ToolResultSchema>;
const CompleteResultsSchema = z
  .tuple([ToolResultSchema])
  .rest(ToolResultSchema)
  .readonly()
  .brand<"CompleteResults">();
/**
 * Checks that `results` answers every call in `calls` exactly once.
 * @throws ZodError when a result is missing, duplicated or names an unknown call.
 */
export function completeResults(calls: ToolCalls, results: readonly ToolResult[]) {
  return CompleteResultsSchema.refine(
    (values) =>
      values.length === calls.length &&
      new Set(values.map((value) => value.callId)).size === calls.length &&
      values.every((value) => calls.some((call) => call.id === value.callId)),
    "Results must match every tool call exactly once",
  ).parse(results);
}
/** Results that cover every call of a tool batch exactly once; see {@link completeResults}. */
export type CompleteResults = z.infer<typeof CompleteResultsSchema>;
/**
 * How a tool batch settled. `results` holds the results of the calls that succeeded before it settled.
 */
export type BatchOutcome =
  /** Every call succeeded; the turn prepares the next step. */
  | Readonly<{ kind: "succeeded"; results: CompleteResults }>
  /**
   * A call failed (after the host applied the tool-failure policy) or the batch failed; the other
   * pending calls were cancelled with `error` and the turn ends failed.
   */
  | Readonly<{ kind: "failed"; results: readonly ToolResult[]; error: Failure }>
  /** The batch or a call was cancelled; the other pending calls were cancelled and the turn ends aborted. */
  | Readonly<{ kind: "cancelled"; results: readonly ToolResult[] }>;
/** State of the tool batch of one step: all calls the step proposed. Calls run concurrently. */
export type BatchState =
  | Readonly<{ status: "ready"; calls: ToolCalls }>
  /** `pending` are calls not yet settled; `results` are those that succeeded, in settle order. */
  | Readonly<{
      status: "running";
      calls: ToolCalls;
      pending: ToolCalls;
      results: readonly ToolResult[];
    }>
  | Readonly<{ status: "settled"; outcome: BatchOutcome }>;
/** Input to the tool batch machine. Events for calls that are not pending are ignored. */
export type BatchEvent =
  /** Spawn every call. */
  | { type: "start" }
  /** Cancel all pending calls and settle `cancelled`. */
  | { type: "cancel" }
  /** One call settled; a failed or cancelled call settles the whole batch. */
  | { type: "tool_settled"; callId: ToolResult["callId"]; result: Result<string> }
  | { type: "failed"; error: Failure };
/** Effect the batch asks its host to perform; `notify` reports the {@link BatchOutcome} to the turn. */
export type BatchCommand =
  | { type: "spawn_tool"; child: Ref<"tool">; call: ToolCalls[number] }
  | { type: "cancel_tool"; child: Ref<"tool">; reason?: Failure }
  | { type: "notify"; outcome: BatchOutcome };

/**
 * Builds the tool batch machine for batch `id`. Each call runs as a `tool` child with ref
 * `<batch id>/<call id>`. The batch settles once: when every call succeeded, or at the first failed or
 * cancelled call.
 */
export function toolBatchMachine(id: Ref<"batch">) {
  const toolRef = (callId: string) => ref("tool", `${id.id}/${callId}`);
  const settle = (
    pending: ToolCalls,
    outcome: BatchOutcome,
  ): Decision<BatchState, BatchCommand> => ({
    state: { status: "settled", outcome },
    commands: [
      ...pending.map((call) => ({
        type: "cancel_tool" as const,
        child: toolRef(call.id),
        ...(outcome.kind === "failed" ? { reason: outcome.error } : {}),
      })),
      { type: "notify", outcome },
    ],
  });
  return defineMachine<BatchState, BatchEvent, BatchCommand>({
    ready: {
      start: (state) => ({
        state: { status: "running", calls: state.calls, pending: state.calls, results: [] },
        commands: state.calls.map((call) => ({
          type: "spawn_tool",
          child: toolRef(call.id),
          call,
        })),
      }),
      cancel: (state) => settle(state.calls, { kind: "cancelled", results: [] }),
      failed: (state, event) =>
        settle(state.calls, { kind: "failed", error: event.error, results: [] }),
    },
    running: {
      tool_settled: (state, event) => {
        if (!state.pending.some((call) => call.id === event.callId)) return stay(state);
        if (event.result.kind === "failed")
          return settle(state.pending, {
            kind: "failed",
            error: event.result.error,
            results: state.results,
          });
        if (event.result.kind === "cancelled")
          return settle(state.pending, { kind: "cancelled", results: state.results });
        const results = [...state.results, { callId: event.callId, text: event.result.value }];
        const remaining = state.pending.filter((call) => call.id !== event.callId);
        if (remaining.length)
          return {
            state: {
              status: "running",
              calls: state.calls,
              pending: ToolCallsSchema.parse(remaining),
              results,
            },
            commands: [],
          };
        const outcome: BatchOutcome = {
          kind: "succeeded",
          results: completeResults(state.calls, results),
        };
        return { state: { status: "settled", outcome }, commands: [{ type: "notify", outcome }] };
      },
      cancel: (state) => settle(state.pending, { kind: "cancelled", results: state.results }),
      failed: (state, event) =>
        settle(state.pending, { kind: "failed", error: event.error, results: state.results }),
    },
    settled: {},
  });
}
