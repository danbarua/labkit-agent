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

export const ToolResultSchema = z
  .strictObject({ callId: ToolCallIdSchema, text: z.string() })
  .readonly();
export type ToolResult = z.infer<typeof ToolResultSchema>;
const CompleteResultsSchema = z
  .tuple([ToolResultSchema])
  .rest(ToolResultSchema)
  .readonly()
  .brand<"CompleteResults">();
export function completeResults(calls: ToolCalls, results: readonly ToolResult[]) {
  return CompleteResultsSchema.refine(
    (values) =>
      values.length === calls.length &&
      new Set(values.map((value) => value.callId)).size === calls.length &&
      values.every((value) => calls.some((call) => call.id === value.callId)),
    "Results must match every tool call exactly once",
  ).parse(results);
}
export type CompleteResults = z.infer<typeof CompleteResultsSchema>;
export type BatchOutcome =
  | Readonly<{ kind: "succeeded"; results: CompleteResults }>
  | Readonly<{ kind: "failed"; results: readonly ToolResult[]; error: Failure }>
  | Readonly<{ kind: "cancelled"; results: readonly ToolResult[] }>;
export type BatchState =
  | Readonly<{ status: "ready"; calls: ToolCalls }>
  | Readonly<{
      status: "running";
      calls: ToolCalls;
      pending: ToolCalls;
      results: readonly ToolResult[];
    }>
  | Readonly<{ status: "settled"; outcome: BatchOutcome }>;
export type BatchEvent =
  | { type: "start" }
  | { type: "cancel" }
  | { type: "tool_settled"; callId: ToolResult["callId"]; result: Result<string> }
  | { type: "failed"; error: Failure };
export type BatchCommand =
  | { type: "spawn_tool"; child: Ref<"tool">; call: ToolCalls[number] }
  | { type: "cancel_tool"; child: Ref<"tool"> }
  | { type: "notify"; outcome: BatchOutcome };

export function toolBatchMachine(id: Ref<"batch">) {
  const toolRef = (callId: string) => ref("tool", `${id.id}/${callId}`);
  const settle = (
    pending: ToolCalls,
    outcome: BatchOutcome,
  ): Decision<BatchState, BatchCommand> => ({
    state: { status: "settled", outcome },
    commands: [
      ...pending.map((call) => ({ type: "cancel_tool" as const, child: toolRef(call.id) })),
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
