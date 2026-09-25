import { z } from "zod";

import type { BlobId, BlobMeta, MediaKind } from "../agent/content.ts";
import { FailureSchema, SessionIdSchema } from "../agent/types.ts";

export * from "../agent/content.ts";

/** Position in a session's journal stream: the number of committed records. 0 is an empty stream. */
export const RevisionSchema = z.number().int().nonnegative().brand<"JournalRevision">();
/**
 * Stable identity of one append batch within a session. A retry reuses it, which lets the store
 * recognize an identical retry and reject reuse with different content.
 */
export const AppendIdSchema = z.string().min(1).brand<"AppendId">();
/** Journal position: the number of committed records ({@link RevisionSchema}). */
export type Revision = z.infer<typeof RevisionSchema>;
/** Stable identity of one append batch ({@link AppendIdSchema}). */
export type AppendId = z.infer<typeof AppendIdSchema>;
/** Revision of an absent stream; the append that creates a session expects it. */
export const INITIAL_REVISION = RevisionSchema.parse(0);
/**
 * One journal append batch (not a tool batch), accepted or refused as a whole. `expectedRevision`
 * is the stream revision the batch was staged against; `records` are serialized journal records.
 */
export const AppendRequestSchema = z
  .strictObject({
    sessionId: SessionIdSchema,
    expectedRevision: RevisionSchema,
    appendId: AppendIdSchema,
    records: z.array(z.string()).min(1).readonly(),
  })
  .readonly();
/** One atomic journal append batch ({@link AppendRequestSchema}). */
export type AppendRequest = z.infer<typeof AppendRequestSchema>;
/** Proof that an append committed; `revision` is the stream revision after its batch. */
export const ReceiptSchema = z
  .strictObject({
    sessionId: SessionIdSchema,
    appendId: AppendIdSchema,
    revision: RevisionSchema,
  })
  .readonly();
/** Proof that an append committed ({@link ReceiptSchema}). */
export type Receipt = z.infer<typeof ReceiptSchema>;
/** A stored append batch: the request as appended plus the stream revision after it. */
export const CommittedBatchSchema = AppendRequestSchema.unwrap()
  .extend({ revision: RevisionSchema })
  .readonly();
/** A stored append batch ({@link CommittedBatchSchema}). */
export type CommittedBatch = z.infer<typeof CommittedBatchSchema>;
/**
 * Result of {@link SessionPersistence.load}: `loaded` is a consistent committed prefix, batches in
 * append order and `revision` the revision after the last one; `not_found` is an absent stream;
 * `failed` means the store could not answer and says nothing about what is committed.
 */
export const LoadResultSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("loaded"),
      revision: RevisionSchema,
      batches: z.array(CommittedBatchSchema).readonly(),
    }),
    z.strictObject({ kind: z.literal("not_found") }),
    z.strictObject({
      kind: z.literal("failed"),
      message: z.string(),
      error: FailureSchema.optional(),
    }),
  ])
  .readonly();
/** Result of a journal load ({@link LoadResultSchema}). */
export type LoadResult = z.infer<typeof LoadResultSchema>;
/**
 * Result of {@link SessionPersistence.append}:
 * - `committed`: the whole batch is stored; `receipt` proves it.
 * - `conflict`: the stream is at `revision`, not the expected one; nothing was written.
 * - `rejected`: refused without writing, for example an append ID reused with different content.
 * - `indeterminate`: the outcome is unknown (lost acknowledgement, cancellation after dispatch).
 *   The session then reconciles with a load and may retry the same append once.
 *
 * A session fails on `conflict`, `rejected` or an indeterminate append it cannot reconcile.
 */
export const AppendResultSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("committed"), receipt: ReceiptSchema }),
    z.strictObject({ kind: z.literal("conflict"), revision: RevisionSchema }),
    z.strictObject({
      kind: z.literal("rejected"),
      message: z.string(),
      error: FailureSchema.optional(),
    }),
    z.strictObject({
      kind: z.literal("indeterminate"),
      message: z.string(),
      error: FailureSchema.optional(),
    }),
  ])
  .readonly();
/** Result of a journal append ({@link AppendResultSchema}). */
export type AppendResult = z.infer<typeof AppendResultSchema>;

/**
 * Journal and blob store a session writes to, supplied and owned by the caller. A conforming port
 * loads a consistent committed prefix and appends an entire batch atomically.
 * Revisions count records. Revision zero creates an absent stream; records are never overwritten.
 * Append IDs are scoped to a session and retained for the advertised storage lifetime. An identical
 * retry (including expectedRevision) returns its original receipt, even after subsequent writes.
 * Reuse with different bytes/metadata is rejected before revision checking. Conflicts and rejected
 * results certify no write by this request. A lost receipt or cancellation after dispatch must be
 * indeterminate unless the adapter can prove a committed or uncommitted result. A load after append
 * settlement must observe any committed write. Adapters must settle cancellation so reconciliation
 * is possible; they must not commit later after reporting an uncommitted/indeterminate result and
 * completing a subsequent consistent load. Thrown append errors are treated as indeterminate.
 * No close operation: storage lifetime and ownership belong to the caller.
 */
export interface SessionPersistence {
  /** Readable description of how long records, append IDs and blobs are retained. */
  readonly lifetime: string;
  /**
   * Stores immutable, session-scoped bytes under their SHA-256 `BlobId` and resolves with their
   * metadata. Identical bytes return the same ID; more than 8 MiB is rejected before writing. Does
   * not advance the journal revision.
   */
  putBlob(
    sessionId: z.infer<typeof SessionIdSchema>,
    bytes: Uint8Array,
    meta: { media: MediaKind; name?: string },
    signal: AbortSignal,
  ): Promise<BlobMeta>;
  /** Reads a stored blob of this session; `{ kind: "not_found" }` when it is absent. */
  getBlob(
    sessionId: z.infer<typeof SessionIdSchema>,
    id: BlobId,
    signal: AbortSignal,
  ): Promise<{ meta: BlobMeta; bytes: Uint8Array } | { kind: "not_found" }>;
  /** Reads every committed batch of the session's journal; see {@link LoadResultSchema}. */
  load(sessionId: z.infer<typeof SessionIdSchema>, signal: AbortSignal): Promise<LoadResult>;
  /**
   * Commits one batch atomically if the stream is at `request.expectedRevision`; see
   * {@link AppendResultSchema}. A thrown error counts as `indeterminate`.
   */
  append(request: AppendRequest, signal: AbortSignal): Promise<AppendResult>;
}
