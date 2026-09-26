import type { ConversationCommand, ConversationState } from "../../agent/agent-conversation.ts";
import type { BlobRef } from "../../agent/content.ts";
import type { ActorIdSchema } from "../../agent/types.ts";
import type { Policy, PolicyResolvers } from "../../policy/policy.ts";
import type { Continuation } from "../../providers/types.ts";
import type { CompletionUsage } from "../../providers/usage.ts";
import type { Revision } from "../persistence.ts";
import type { Configuration, JournalBody, JournalRecord, SystemVersionSchema } from "../types.ts";

/** A `tool` record's body: one tool call's raw result, committed before its tool batch settles. */
export type ToolEntry = Extract<JournalBody, { kind: "tool" }>;

/** Accounting of the latest committed completion that reported usage. */
export type LastCompletionUsage = Readonly<{
  /** Turn whose step produced the completion. */
  turnId: string;
  /** ID of the completion: a child operation of the turn, not a child session. */
  operationId: string;
  usage: CompletionUsage;
}>;

/**
 * Session state folded from journal records: the conversation plus everything the records set.
 * {@link replay} builds it on load; {@link stage} returns the next one for new work. A staged state
 * is a proposal until its append commits.
 */
export type JournalState = Readonly<{
  /** Accounting of the latest committed completion that reported usage; kept when one has none. */
  lastCompletionUsage?: LastCompletionUsage;
  /** Current turn, turn log, inherited context and pending branch requests. */
  conversation: ConversationState;
  /**
   * Provider continuation payloads (such as thinking signatures) committed with settled steps, each
   * owned by the assistant message of one turn and generation.
   */
  continuations?: readonly Continuation[];
  /**
   * Configuration (the user-selectable settings) in force. Policy records are staged only at an
   * idle boundary, so a running turn keeps the policy it started with.
   */
  policy: Policy;
  /**
   * Queued inputs, oldest first, each waiting for the current turn to end. Not the in-memory
   * submissions of `SessionState.queue`.
   */
  pendingInputs?: readonly Readonly<{
    inputId: ReturnType<typeof ActorIdSchema.parse>;
    text: string;
    attachments?: readonly BlobRef[];
  }>[];
  /** The registry (tool and agent definitions); the user-selectable configuration is `policy`. */
  configuration: Configuration;
  /** Standing session instructions, not system notices. */
  systemInputs: readonly string[];
  systemVersion: ReturnType<typeof SystemVersionSchema.parse>;
  /**
   * `tool` records committed for the running tool batch, in commit order. Cleared when the batch
   * settles or the turn ends.
   */
  partial: readonly ToolEntry[];
  /** Revision of the last record in `records`; 0 before the creation record. */
  revision: Revision;
  /** Every record folded so far, in revision order. A staged state ends with uncommitted ones. */
  records: readonly JournalRecord[];
}>;

/**
 * How records fold into state. `stage` admits new work and enforces every commit-time rule against
 * the live resolvers. `load` rebuilds state from committed records: each stored record is taken as
 * written, and only what the fold needs to apply it is checked.
 */
export type Fold =
  Readonly<{ mode: "stage"; resolvers: PolicyResolvers }> | Readonly<{ mode: "load" }>;

export const load: Fold = { mode: "load" };

export type ReducibleBody = Exclude<JournalBody, { kind: "created" | "terminal" }>;

export type Reduction = {
  state: JournalState;
  commands: readonly ConversationCommand[];
};

export type Reducer<K extends ReducibleBody["kind"]> = (
  state: JournalState,
  input: Extract<ReducibleBody, { kind: K }>,
  fold: Fold,
) => Reduction;
