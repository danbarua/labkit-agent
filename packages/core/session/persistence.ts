import { z } from "zod";

import { SessionIdSchema } from "../agent/types.ts";

export const RevisionSchema = z.number().int().nonnegative().brand<"JournalRevision">();
export const AppendIdSchema = z.string().min(1).brand<"AppendId">();
export type Revision = z.infer<typeof RevisionSchema>;
export type AppendId = z.infer<typeof AppendIdSchema>;
export const INITIAL_REVISION = RevisionSchema.parse(0);
export const AppendRequestSchema = z
  .strictObject({
    sessionId: SessionIdSchema,
    expectedRevision: RevisionSchema,
    appendId: AppendIdSchema,
    records: z.array(z.string()).min(1).readonly(),
  })
  .readonly();
export type AppendRequest = z.infer<typeof AppendRequestSchema>;
export const ReceiptSchema = z
  .strictObject({
    sessionId: SessionIdSchema,
    appendId: AppendIdSchema,
    revision: RevisionSchema,
  })
  .readonly();
export type Receipt = z.infer<typeof ReceiptSchema>;
export const CommittedBatchSchema = AppendRequestSchema.unwrap()
  .extend({ revision: RevisionSchema })
  .readonly();
export type CommittedBatch = z.infer<typeof CommittedBatchSchema>;
export const LoadResultSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("loaded"),
      revision: RevisionSchema,
      batches: z.array(CommittedBatchSchema).readonly(),
    }),
    z.strictObject({ kind: z.literal("not_found") }),
    z.strictObject({ kind: z.literal("failed"), message: z.string() }),
  ])
  .readonly();
export type LoadResult = z.infer<typeof LoadResultSchema>;
export const AppendResultSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("committed"), receipt: ReceiptSchema }),
    z.strictObject({ kind: z.literal("conflict"), revision: RevisionSchema }),
    z.strictObject({ kind: z.literal("rejected"), message: z.string() }),
    z.strictObject({ kind: z.literal("indeterminate"), message: z.string() }),
  ])
  .readonly();
export type AppendResult = z.infer<typeof AppendResultSchema>;

/**
 * A conforming port loads a consistent committed prefix and appends an entire batch atomically.
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
  readonly lifetime: string;
  load(sessionId: z.infer<typeof SessionIdSchema>, signal: AbortSignal): Promise<LoadResult>;
  append(request: AppendRequest, signal: AbortSignal): Promise<AppendResult>;
}
