import type { ConversationEvent } from "../../agent/agent-conversation.ts";
import { completeResults } from "../../agent/tool-batch.ts";
import type { WireEvent } from "../types.ts";
import { partialResults } from "./shared.ts";
import type { Fold, JournalState } from "./state.ts";

/**
 * Converts a {@link WireEvent} into the richer event the turn machine reads:
 * `model_settled` gets a `permissionRequired` flag derived fresh from the
 * policy in force (never stored, so there is nothing to compare against on load), and
 * `batch_settled` gets its results assembled from the batch's committed `tool` records (never
 * stored on the wire either). A failed dispatch of a turn's child operation becomes a `failed`
 * child event.
 *
 * @throws Error for a failed branch reply, which has no journaled form.
 */
export function domainEvent(state: JournalState, event: WireEvent, fold: Fold): ConversationEvent {
  if (event.type !== "child") return event;
  const child = event.event;
  if (child.type === "model_settled") {
    if (fold.mode === "stage" && child.result.kind === "succeeded") {
      const result = child.result.value;
      const c = state.conversation;
      const activeAgent = c.turn.status === "idle" ? c.turn.agent : c.turn.turn.agent;
      const agent = state.configuration.agents.find(
        ([id]: readonly [string, unknown]) => id === activeAgent,
      )?.[1];
      if (
        result.kind === "handoff" &&
        !(
          agent?.successors ??
          state.configuration.agents.map(([id]: readonly [string, unknown]) => id)
        ).includes(result.agent)
      )
        throw new Error("Unknown handoff agent");
      if (
        result.kind === "tools" &&
        result.calls.some(
          (call) => !(state.policy?.tools[activeAgent] ?? agent?.tools)?.includes(call.name),
        )
      )
        throw new Error("Unpermitted tool");
    }
    // The permission route is always derived from the policy in force, both when staging and on
    // load; it is never stored, so there is nothing for a stored copy to disagree with.
    const permissionRequired =
      state.policy?.permissions === "ask" &&
      child.result.kind === "succeeded" &&
      child.result.value.kind === "tools";
    return {
      ...event,
      event: { ...child, ...(permissionRequired ? { permissionRequired: true as const } : {}) },
    };
  }
  if (child.type !== "batch_settled") return { ...event, event: child };
  // Individual results are never stored on the wire; both staging and load assemble them from the
  // batch's committed `tool` records.
  const results = partialResults(state);
  if (child.outcome.kind !== "succeeded")
    return { ...event, event: { ...child, outcome: { ...child.outcome, results } } };
  const turn = state.conversation.turn;
  if (turn.status !== "executing_tools" && turn.status !== "cancelling_tools")
    throw new Error("Batch outside tool phase");
  const message = turn.turn.messages.at(-1);
  if (message?.role !== "assistant" || !message.calls) throw new Error("Missing tool intents");
  return {
    ...event,
    event: {
      ...child,
      outcome: { kind: "succeeded", results: completeResults(message.calls, results) },
    },
  };
}
