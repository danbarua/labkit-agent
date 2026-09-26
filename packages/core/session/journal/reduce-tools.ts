import { decideConversation } from "../../agent/agent-conversation.ts";
import { failure, MessagesSchema } from "../../agent/types.ts";
import { partialResults } from "./shared.ts";
import type { Fold, JournalState, ReducibleBody, Reduction } from "./state.ts";

/**
 * Reduces a tool result record: appends the tool result to the partial batch.
 */
function reduceTool(
  state: JournalState,
  input: Extract<ReducibleBody, { kind: "tool" }>,
  _fold: Fold,
): Reduction {
  return { state: { ...state, partial: [...state.partial, input] }, commands: [] };
}

/**
 * Reduces a recovery record: resumes a turn that encountered an error or was interrupted,
 * collecting partial tool results and passing the failure to the model's conversation state.
 */
function reduceRecovery(
  state: JournalState,
  input: Extract<ReducibleBody, { kind: "recovery" }>,
  fold: Fold,
): Reduction {
  const c = state.conversation;
  if (input.turnId !== c.turnId) throw new Error("Recovery turn mismatch");
  if (c.turn.status === "idle") {
    if (fold.mode === "stage" && !state.pendingInputs?.length)
      throw new Error("Recovery requires interrupted work");
    return { state, commands: [] };
  }
  const messages = MessagesSchema.parse([
    ...c.turn.turn.messages,
    ...partialResults(state).map((result) => ({
      role: "tool",
      callId: result.callId,
      text: result.text,
    })),
  ]);
  const recovered = decideConversation(
    {
      ...c,
      pending: [],
      turn:
        c.turn.status === "preparing_model"
          ? { ...c.turn, turn: { ...c.turn.turn, messages } }
          : { ...c.turn, turn: { ...c.turn.turn, messages } },
    },
    {
      type: "child",
      turnId: c.turnId,
      event: {
        type: "failed",
        child: c.turn.child,
        error: failure(input.reason, {
          classification: "interrupted",
          phase: c.turn.status,
          operation: { ...c.turn.child, sessionId: c.sessionId, turnId: c.turnId },
        }),
      },
    },
  );
  return { state: { ...state, conversation: recovered.state, partial: [] }, commands: [] };
}

export { reduceTool, reduceRecovery };
