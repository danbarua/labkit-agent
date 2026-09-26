import type { TurnRecord } from "../agent/types.ts";
import type { Continuation } from "../providers/types.ts";
import type { JournalState } from "./journal/state.ts";
import { SeedSchema, type Seed } from "./types.ts";

/**
 * The seed that starts a fork or compaction child session (not a child operation) from
 * `conversation`. It carries `state`'s registry, policy and standing instructions. Continuations
 * are kept only for a fork, and only those whose assistant message is in the context or log.
 *
 * @param conversation Conversation to seed from, defaulting to `state.conversation`. A branch
 *   passes its branched snapshot, which already holds the child's session ID and origin.
 * @throws Error when `conversation` has a running turn.
 */
export function toSeed(state: JournalState, conversation = state.conversation): Seed {
  if (conversation.turn.status !== "idle")
    throw new Error("Initialization requires an idle boundary");
  return SeedSchema.parse({
    sessionId: conversation.sessionId,
    origin: conversation.origin,
    context: conversation.context,
    log: conversation.log,
    sequence: conversation.sequence,
    allowance: conversation.allowance,
    agent: conversation.turn.agent,
    systemInputs: state.systemInputs,
    systemVersion: state.systemVersion,
    configuration: state.configuration,
    policy: state.policy,
    ...(state.continuations?.length && conversation.origin.kind !== "compaction"
      ? {
          continuations: state.continuations.filter((entry: Continuation) =>
            [
              ...conversation.context,
              ...conversation.log.flatMap((record: TurnRecord) => record.messages),
            ].some(
              (message) =>
                message.role === "assistant" &&
                message.owner?.turnId === entry.owner.turnId &&
                message.owner.generation === entry.owner.generation,
            ),
          ),
        }
      : {}),
  });
}

// Types
export type { ToolEntry, LastCompletionUsage, JournalState } from "./journal/state.ts";
export type { Fold } from "./journal/state.ts";
export type { JournalIntegrityRule, JournalLocation } from "./journal/replay.ts";

// Fold and Reducer
export { load } from "./journal/state.ts";

// Public helpers
export { accepts, partialResults } from "./journal/shared.ts";

// Encoding/Decoding
export { wireEvent, encodeRecord, decodeRecord } from "./journal/codec.ts";

// Seeding
export { seedConversation, foldSeed } from "./journal/seed.ts";

// Staging and replay
export { stage, stageCreation } from "./journal/stage.ts";
export { replay, JournalIntegrityError } from "./journal/replay.ts";

// Reducer
export { reduce } from "./journal/reduce.ts";

// Domain event
export { domainEvent } from "./journal/domain-event.ts";

// Rendering
export { journalJSONL, journalMarkdown } from "./journal/render.ts";
