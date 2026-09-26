import { blobUri, type BlobRef, type MediaKind } from "../agent/content.ts";
import type { AgentMessage, Json, Outcome, TurnRecord } from "../agent/types.ts";
import type { JournalState } from "./journal/state.ts";

/**
 * One attachment referenced from a message, as a consumer would render it: the same fields as
 * {@link BlobRef} plus its resolvable `blob://` URI. Never carries the bytes.
 */
export type ViewBlob = Readonly<{
  id: string;
  media: MediaKind;
  bytes: number;
  name?: string;
  uri: string;
}>;

/** One tool call a step proposed, as a consumer would render it. */
export type ViewToolCall = Readonly<{ id: string; name: string; args: Json }>;

/** The step that produced an assistant message. See {@link AgentMessage}'s `owner`. */
export type ViewOwner = Readonly<{ turnId: string; generation: number }>;

/**
 * One projected message. This is the one shared view of a fact every consumer (ACP replay and
 * live updates, the web console, `/export`) renders from, instead of each deriving its own shape
 * from the folded conversation state.
 */
export type MessageView =
  | Readonly<{ role: "system" | "user"; text: string; blobs: readonly ViewBlob[] }>
  | Readonly<{
      role: "assistant";
      text: string;
      blobs: readonly ViewBlob[];
      calls?: readonly ViewToolCall[];
      owner?: ViewOwner;
    }>
  | Readonly<{ role: "tool"; text: string; callId: string; blobs: readonly ViewBlob[] }>;

/** A finished turn, projected. */
export type TurnView = Readonly<{
  agent: string;
  outcome: Outcome;
  messages: readonly MessageView[];
}>;

/** A session's whole conversation, projected: inherited context, settled turns, and the live turn. */
export type ConversationView = Readonly<{
  sessionId: string;
  context: readonly MessageView[];
  log: readonly TurnView[];
  live: readonly MessageView[];
}>;

function projectBlob(ref: BlobRef): ViewBlob {
  return {
    id: ref.id,
    media: ref.media,
    bytes: ref.bytes,
    ...(ref.name ? { name: ref.name } : {}),
    uri: blobUri(ref),
  };
}

/**
 * Projects one fact message into its consumer view: text, blob refs (with their `blob://` URI),
 * including those of a tool result, tool calls, and the tool call a result answers. A pure
 * function of the message; never stored, never compared with a stored copy.
 */
export function projectMessage(message: AgentMessage): MessageView {
  const blobs = (message.parts ?? []).flatMap((part) =>
    part.type === "blob" ? [projectBlob(part.ref)] : [],
  );
  if (message.role === "tool")
    return { role: "tool", text: message.text, callId: message.callId, blobs };
  if (message.role === "assistant")
    return {
      role: "assistant",
      text: message.text,
      blobs,
      ...(message.calls
        ? {
            calls: message.calls.map((call) => ({ id: call.id, name: call.name, args: call.args })),
          }
        : {}),
      ...(message.owner
        ? { owner: { turnId: message.owner.turnId, generation: message.owner.generation } }
        : {}),
    };
  return { role: message.role, text: message.text, blobs };
}

/** Projects one finished turn: its messages, in the same order they were committed. */
export function projectTurn(turn: TurnRecord): TurnView {
  return { agent: turn.agent, outcome: turn.outcome, messages: turn.messages.map(projectMessage) };
}

/**
 * Projects a session's whole conversation from folded state: inherited context, every settled
 * turn, and the messages the live turn has added so far (empty while idle). Consumers project
 * this further into their own wire shape (ACP `session/update`, the web console, `/export`); none
 * of them derive conversation history separately.
 */
export function projectConversation(state: JournalState): ConversationView {
  const c = state.conversation;
  return {
    sessionId: c.sessionId,
    context: c.context.map(projectMessage),
    log: c.log.map(projectTurn),
    live: c.turn.status === "idle" ? [] : c.turn.turn.messages.map(projectMessage),
  };
}
