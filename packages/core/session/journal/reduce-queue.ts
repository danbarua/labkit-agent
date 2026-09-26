import { decideConversation } from "../../agent/agent-conversation.ts";
import { withUserParts } from "./shared.ts";
import type { Fold, JournalState, ReducibleBody, Reduction } from "./state.ts";

/**
 * Reduces a queued input record: appends a pending input (text, attachments, inputId)
 * to the queue. Stage requires the turn to be running and policy to permit queueing.
 */
function reduceQueued(
  state: JournalState,
  input: Extract<ReducibleBody, { kind: "queued" }>,
  fold: Fold,
): Reduction {
  const c = state.conversation;
  if (fold.mode === "stage") {
    if (
      !state.policy ||
      input.policyVersion !== state.policy.version ||
      c.turn.status === "idle" ||
      state.records.some(
        (record) => record.body.kind === "queued" && record.body.inputId === input.inputId,
      )
    )
      throw new Error("Invalid queued input");
    if (
      state.policy.admission !== "queue-user" &&
      !(
        state.policy.admission === "abort-tools-on-user" &&
        ["awaiting_permission", "executing_tools", "cancelling_tools"].includes(c.turn.status)
      )
    )
      throw new Error("Policy does not queue this input");
  }
  return {
    state: {
      ...state,
      pendingInputs: [
        ...(state.pendingInputs ?? []),
        {
          inputId: input.inputId,
          text: input.text,
          ...(input.attachments ? { attachments: input.attachments } : {}),
        },
      ],
    },
    commands: [],
  };
}

/**
 * Reduces an input_cancelled record: removes a pending input by inputId.
 */
function reduceInputCancelled(
  state: JournalState,
  input: Extract<ReducibleBody, { kind: "input_cancelled" }>,
  _fold: Fold,
): Reduction {
  if (!state.pendingInputs?.some((entry) => entry.inputId === input.inputId))
    throw new Error("Unknown cancelled input");
  return {
    state: {
      ...state,
      pendingInputs: state.pendingInputs.filter((entry) => entry.inputId !== input.inputId),
    },
    commands: [],
  };
}

/**
 * Reduces a dequeued input record: dequeues and processes a pending input, starting a
 * new turn with its text and attachments. Stage requires the turn to be idle and this
 * input to be at the head of the queue.
 */
function reduceDequeued(
  state: JournalState,
  input: Extract<ReducibleBody, { kind: "dequeued" }>,
  fold: Fold,
): Reduction {
  if (
    fold.mode === "stage" &&
    (state.conversation.turn.status !== "idle" ||
      state.pendingInputs?.[0]?.inputId !== input.inputId ||
      input.policyVersion !== state.policy?.version)
  )
    throw new Error("Invalid dequeue boundary");
  // Load needs only the queued input whose text starts the turn.
  const pending = state.pendingInputs?.find((entry) => entry.inputId === input.inputId);
  if (!pending) throw new Error(`Dequeued input ${input.inputId} is not queued`);
  const decision = withUserParts(
    decideConversation(state.conversation, { type: "user", text: pending.text }),
    pending.text,
    pending.attachments,
  );
  return {
    state: {
      ...state,
      conversation: decision.state,
      pendingInputs: state.pendingInputs!.filter((entry) => entry !== pending),
    },
    commands: decision.commands,
  };
}

export { reduceQueued, reduceInputCancelled, reduceDequeued };
