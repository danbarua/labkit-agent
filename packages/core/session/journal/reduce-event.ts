import { decideConversation } from "../../agent/agent-conversation.ts";
import type { AgentMessage } from "../../agent/types.ts";
import { ContinuationSchema } from "../../providers/types.ts";
import { domainEvent } from "./domain-event.ts";
import { replaceLastMessage, withUserParts } from "./shared.ts";
import type { Fold, JournalState, ReducibleBody, Reduction } from "./state.ts";

/**
 * Reduces an event record: processes a domain event (user input, completion, tool batch,
 * permission decision, system notice, or child operation result), updates conversation
 * state, and collects usage and continuation data if applicable. Stage validates system
 * and policy versions, barge-in policy, and continuation consistency.
 */
function reduceEvent(
  state: JournalState,
  input: Extract<ReducibleBody, { kind: "event" }>,
  fold: Fold,
): Reduction {
  if (fold.mode === "stage") {
    if (input.systemVersion !== state.systemVersion)
      throw new Error("Turn system version mismatch");
    if (input.policyVersion !== state.policy?.version)
      throw new Error("Turn policy version mismatch");
    if (
      input.event.type === "user" &&
      state.policy &&
      state.conversation.turn.status !== "idle" &&
      (!state.policy.bargeIn || state.policy.admission === "queue-user")
    )
      throw new Error("Policy rejects barge-in");
  }
  const settled =
    input.event.type === "child" && input.event.event.type === "model_settled"
      ? input.event.event
      : undefined;
  if (fold.mode === "stage" && settled?.usage && settled.result.kind !== "succeeded")
    throw new Error("Completion usage requires an admitted completion");
  const envelope = settled?.continuation;
  if (envelope) {
    ContinuationSchema.parse(envelope);
    const active = state.conversation.turn;
    if (
      fold.mode === "stage" &&
      (settled?.result.kind !== "succeeded" ||
        active.status !== "awaiting_model" ||
        envelope.owner.turnId !== state.conversation.turnId ||
        envelope.owner.generation !== active.turn.generation ||
        envelope.provider !== state.policy?.provider ||
        state.continuations?.some(
          (entry) =>
            entry.owner.turnId === envelope.owner.turnId &&
            entry.owner.generation === envelope.owner.generation,
        ))
    )
      throw new Error("Continuation owner/provider mismatch");
    // Load keeps the stored owner, but the envelope needs the assistant message its completion made.
    if (settled?.result.kind !== "succeeded")
      throw new Error("Continuation without an admitted completion");
  }
  let decision = decideConversation(state.conversation, domainEvent(state, input.event, fold));
  if (input.event.type === "user")
    decision = withUserParts(decision, input.event.text, input.event.attachments);
  if (envelope)
    decision = replaceLastMessage(decision, (message: AgentMessage) => {
      if (message.role !== "assistant") throw new Error("Completion did not produce an assistant");
      return { ...message, owner: envelope.owner };
    });
  return {
    state: {
      ...state,
      conversation: decision.state,
      ...(settled?.usage && decision.state !== state.conversation && input.event.type === "child"
        ? {
            lastCompletionUsage: {
              turnId: input.event.turnId,
              operationId: settled.child.id,
              usage: settled.usage,
            },
          }
        : {}),
      ...(envelope ? { continuations: [...(state.continuations ?? []), envelope] } : {}),
      partial:
        (input.event.type === "child" && input.event.event.type === "batch_settled") ||
        decision.state.sequence !== state.conversation.sequence
          ? []
          : state.partial,
    },
    commands: decision.commands,
  };
}

export { reduceEvent };
