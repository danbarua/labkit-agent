import { freeze } from "../../fsm/fsm.ts";
import type { CommittedBatch } from "../persistence.ts";
import type { JournalRecord } from "../types.ts";
import { decodeFailure, decodeRecord } from "./codec.ts";
import { reduce } from "./reduce.ts";
import { foldSeed } from "./seed.ts";
import { load } from "./state.ts";
import type { JournalState } from "./state.ts";

/**
 * Integrity rules a committed journal must satisfy to load. Nothing else is checked on load; the
 * commit-time rules run only when new work is staged. "Batch" in these rules is a journal append
 * batch (`CommittedBatch`), except in `record_applicable`, where it is a tool batch.
 */
export type JournalIntegrityRule =
  /** Each append ID is committed once. */
  | "append_unique"
  /** An append batch is non-empty and continues the journal at its expected revision. */
  | "batch_continuity"
  /** A record decodes as a current-format journal record. */
  | "record_decode"
  /** Every record belongs to the batch's and the creation record's session. */
  | "session_identity"
  /** A record carries its batch's append ID. */
  | "append_identity"
  /** Record revisions increase by one from 1. */
  | "revision_sequence"
  /** An entry ID is `<appendId>/<index in batch>`; unique append IDs make entry IDs unique. */
  | "entry_format"
  /** The first record, and only the first, creates the session. */
  | "creation_first"
  /** A record that ends a turn is followed by that turn's terminal record. */
  | "terminal_required"
  /** A terminal record follows a record that ended its turn. */
  | "terminal_unexpected"
  /** A turn's terminal record is committed in the same append as the record that ended the turn. */
  | "terminal_same_batch"
  /**
   * The record applies to the folded state: it names a turn, operation, tool batch, call or queued
   * input the state has. Any other error while folding a record is reported under this rule too.
   */
  | "record_applicable";

/** Position of an offending record: its own fields, or where it was expected when undecodable. */
export type JournalLocation = Readonly<{ revision?: number; appendId?: string; entryId?: string }>;

/**
 * A committed journal that cannot load, naming the violated rule and the offending record. Thrown
 * by {@link replay}. The message reads `Journal integrity (<rule>) at <entryId>: <detail>`.
 */
export class JournalIntegrityError extends Error {
  readonly rule: JournalIntegrityRule;
  /** Revision of the offending record, or where it was expected; absent for an empty journal. */
  readonly revision?: number;
  /** Append ID of the offending record's batch; absent for an empty journal. */
  readonly appendId?: string;
  /** Entry ID of the offending record, or where it was expected; absent for an empty journal. */
  readonly entryId?: string;

  constructor(
    rule: JournalIntegrityRule,
    detail: string,
    at: JournalLocation,
    options?: ErrorOptions,
  ) {
    super(`Journal integrity (${rule}) at ${at.entryId ?? "journal"}: ${detail}`, options);
    this.name = "JournalIntegrityError";
    this.rule = rule;
    this.revision = at.revision;
    this.appendId = at.appendId;
    this.entryId = at.entryId;
  }
}

/**
 * Loads a journal: folds committed batches into state, checking only journal integrity
 * ({@link JournalIntegrityRule}). Each stored record is taken as written. Commit-time rules (prompt
 * projection, policy patches, permissions, admission, bindings) are not re-run, so a journal the
 * runtime committed keeps loading after code, configuration or bindings change. A turn that process
 * exit interrupted stays open in the result; closing it is a separately staged `recovery` record.
 *
 * @throws {@link JournalIntegrityError} naming the first violated rule and the offending record.
 */
export function replay(batches: readonly CommittedBatch[]): JournalState {
  let state: JournalState | undefined;
  let ended: { turnId: string; at: JournalLocation } | undefined;
  const appends = new Set<string>();
  const fold = (at: JournalLocation, apply: () => JournalState) => {
    try {
      return apply();
    } catch (error) {
      throw new JournalIntegrityError(
        "record_applicable",
        error instanceof Error ? error.message : String(error),
        at,
        { cause: error },
      );
    }
  };
  for (const batch of batches) {
    const revision = state?.revision ?? 0;
    // A batch-level failure names the batch's first record as the batch itself describes it.
    const first = {
      revision: batch.expectedRevision + 1,
      appendId: batch.appendId,
      entryId: `${batch.appendId}/0`,
    };
    if (appends.has(batch.appendId))
      throw new JournalIntegrityError(
        "append_unique",
        `Append ${batch.appendId} is committed twice`,
        first,
      );
    if (
      !batch.records.length ||
      batch.expectedRevision !== revision ||
      batch.revision !== batch.expectedRevision + batch.records.length
    )
      throw new JournalIntegrityError(
        "batch_continuity",
        `Batch of ${batch.records.length} records from revision ${batch.expectedRevision} to ${batch.revision}; the journal is at revision ${revision}`,
        first,
      );
    appends.add(batch.appendId);
    for (const [index, serialized] of batch.records.entries()) {
      const expected = {
        revision: (state?.revision ?? 0) + 1,
        appendId: batch.appendId,
        entryId: `${batch.appendId}/${index}`,
      };
      let record: JournalRecord;
      try {
        record = decodeRecord(serialized);
      } catch (error) {
        throw new JournalIntegrityError("record_decode", decodeFailure(serialized), expected, {
          cause: error,
        });
      }
      const at = { revision: record.revision, appendId: record.appendId, entryId: record.entryId };
      const sessionId = state?.conversation.sessionId ?? batch.sessionId;
      if (record.sessionId !== batch.sessionId || record.sessionId !== sessionId)
        throw new JournalIntegrityError(
          "session_identity",
          `Record of session ${record.sessionId} in the journal of session ${sessionId}`,
          at,
        );
      if (record.appendId !== batch.appendId)
        throw new JournalIntegrityError(
          "append_identity",
          `Record of append ${record.appendId} in batch ${batch.appendId}`,
          at,
        );
      if (record.revision !== expected.revision)
        throw new JournalIntegrityError(
          "revision_sequence",
          `Record revision ${record.revision} does not follow revision ${expected.revision - 1}`,
          at,
        );
      if (record.entryId !== expected.entryId)
        throw new JournalIntegrityError(
          "entry_format",
          `Entry ID ${record.entryId} should be ${expected.entryId}`,
          at,
        );
      const body = record.body;
      if (!state) {
        if (body.kind !== "created")
          throw new JournalIntegrityError(
            "creation_first",
            `The first record is ${body.kind}, not created`,
            at,
          );
        if (body.seed.sessionId !== record.sessionId)
          throw new JournalIntegrityError(
            "session_identity",
            `Creation record seeds session ${body.seed.sessionId} in the journal of session ${record.sessionId}`,
            at,
          );
        const seed = body.seed;
        state = fold(at, () => foldSeed(seed));
      } else if (body.kind === "created") {
        throw new JournalIntegrityError("creation_first", "A second creation record", at);
      } else if (ended) {
        if (body.kind !== "terminal" || body.turnId !== ended.turnId)
          throw new JournalIntegrityError(
            "terminal_required",
            `Turn ${ended.turnId} ended at ${ended.at.entryId}, but the next record is ${body.kind === "terminal" ? `the terminal record of turn ${body.turnId}` : body.kind}`,
            at,
          );
        // The stored terminal record is the turn's log entry, whatever the fold derived.
        const c = state.conversation;
        state = {
          ...state,
          conversation: {
            ...c,
            log: [...c.log.slice(0, -1), body.record],
            turn: c.turn.status === "idle" ? { ...c.turn, agent: body.record.agent } : c.turn,
          },
        };
        ended = undefined;
      } else if (body.kind === "terminal") {
        throw new JournalIntegrityError(
          "terminal_unexpected",
          `Terminal record of turn ${body.turnId}, but no turn ended`,
          at,
        );
      } else {
        const before = state;
        state = fold(at, () => reduce(before, body, load).state);
        if (state.conversation.sequence !== before.conversation.sequence)
          ended = { turnId: before.conversation.turnId, at };
      }
      state = { ...state, revision: record.revision, records: [...state.records, record] };
    }
    if (ended)
      throw new JournalIntegrityError(
        "terminal_same_batch",
        `Turn ${ended.turnId} ended without a terminal record in append ${batch.appendId}`,
        ended.at,
      );
  }
  if (!state) throw new JournalIntegrityError("creation_first", "The journal has no records", {});
  return freeze(state);
}
