import type { ConversationCommand, decideConversation } from "../../agent/agent-conversation.ts";
import type { BlobRef, ContentPart } from "../../agent/content.ts";
import type { AgentMessage, TurnData, TurnRecord } from "../../agent/types.ts";
import { effectiveToolResult } from "../../policy/policy.ts";
import type { SessionInput } from "../types.ts";
import type { JournalState } from "./state.ts";

/**
 * Why a record cannot apply: it names a turn, operation, batch or tool call that does not exist in
 * the folded state. Load checks only this; staging (`accepts`) adds the commit-time rules.
 */
export function missingTarget(state: JournalState, input: SessionInput): string | undefined {
  const c = state.conversation;
  if (input.kind === "event" && input.event.type === "child") {
    const { turnId, event } = input.event;
    if (turnId !== c.turnId) return `Event for turn ${turnId}; the current turn is ${c.turnId}`;
    if (c.turn.status === "idle")
      return `Event for ${event.child.kind} ${event.child.id}; turn ${turnId} is idle`;
    if (event.child.id !== c.turn.child.id || event.child.kind !== c.turn.child.kind)
      return `Event for ${event.child.kind} ${event.child.id}; the active operation is ${c.turn.child.kind} ${c.turn.child.id}`;
    return undefined;
  }
  if (input.kind !== "tool") return undefined;
  if (input.turnId !== c.turnId)
    return `Tool result for turn ${input.turnId}; the current turn is ${c.turnId}`;
  if (c.turn.status !== "executing_tools" && c.turn.status !== "cancelling_tools")
    return `Tool result for batch ${input.batchId}; turn ${c.turnId} has no tool batch`;
  if (input.batchId !== c.turn.child.id)
    return `Tool result for batch ${input.batchId}; the active batch is ${c.turn.child.id}`;
  const intents = c.turn.turn.messages.at(-1);
  if (intents?.role !== "assistant" || !intents.calls?.some((call) => call.id === input.callId))
    return `Tool result for call ${input.callId}; batch ${input.batchId} has no such call`;
  return undefined;
}

/**
 * Whether `input` still applies to `state`: the turn, operation, tool batch and call it names are
 * current, and a tool result arrives while its batch runs, once per call, with no earlier result of
 * the batch counting as failed under the policy's `toolFailure`. `false` marks a stale or
 * uncorrelated input: `decideSession` answers `ignored` and {@link stage} throws.
 */
export function accepts(state: JournalState, input: SessionInput): boolean {
  if (missingTarget(state, input)) return false;
  if (input.kind !== "tool") return true;
  // New results arrive only while the batch runs, once per call, and none after a failure.
  return (
    state.conversation.turn.status === "executing_tools" &&
    !state.partial.some(
      (entry) =>
        entry.callId === input.callId ||
        effectiveToolResult(entry.result, state.policy).kind !== "succeeded",
    )
  );
}

export function partialResults(state: JournalState) {
  return state.partial.flatMap((entry) => {
    const result = effectiveToolResult(entry.result, state.policy);
    return result.kind === "succeeded" ? [{ callId: entry.callId, text: result.value }] : [];
  });
}

export function replaceLastMessage(
  decision: ReturnType<typeof decideConversation>,
  update: (message: AgentMessage) => AgentMessage,
): ReturnType<typeof decideConversation> {
  const c = decision.state;
  const messages = c.turn.status === "idle" ? c.log.at(-1)!.messages : c.turn.turn.messages;
  const target = messages.at(-1)!;
  const attachMessages = (items: readonly AgentMessage[]) =>
    items.map((message) => (message === target ? update(message) : message));
  const attachTurn = (turn: TurnData): TurnData => ({
    ...turn,
    messages: attachMessages(turn.messages),
    view:
      turn.view.kind === "handoff"
        ? { ...turn.view, messages: attachMessages(turn.view.messages) }
        : turn.view,
  });
  const attachLog = (log: readonly TurnRecord[]) =>
    log.map((record) => ({ ...record, messages: attachMessages(record.messages) }));
  // Keep the decorated message in history, handoff views and pending branch commands.
  return {
    state: {
      ...c,
      log: attachLog(c.log),
      turn:
        c.turn.status === "idle"
          ? c.turn
          : ({ ...c.turn, turn: attachTurn(c.turn.turn) } as typeof c.turn),
    },
    commands: decision.commands.map((effect): ConversationCommand =>
      effect.type === "reply"
        ? {
            ...effect,
            result: {
              ...effect.result,
              state: { ...effect.result.state, log: attachLog(effect.result.state.log) },
            },
          }
        : {
            ...effect,
            command:
              "turn" in effect.command
                ? { ...effect.command, turn: attachTurn(effect.command.turn) }
                : effect.command,
          },
    ),
  };
}

export function withUserParts(
  decision: ReturnType<typeof decideConversation>,
  text: string,
  attachments?: readonly BlobRef[],
) {
  if (!attachments) return decision;
  const parts: readonly ContentPart[] = [
    ...(text ? [{ type: "text" as const, text }] : []),
    ...attachments.map((ref) => ({ type: "blob" as const, ref })),
  ];
  return replaceLastMessage(decision, (message) => {
    if (message.role !== "user") throw new Error("Input did not produce a user message");
    return { ...message, parts };
  });
}
