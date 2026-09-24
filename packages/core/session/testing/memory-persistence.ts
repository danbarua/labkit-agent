import {
  BlobIdSchema,
  BlobInputMetaSchema,
  BlobMetaSchema,
  hashBlob,
  MAX_BLOB_BYTES,
  type BlobMeta,
} from "../../agent/content.ts";
import { SessionIdSchema } from "../../agent/types.ts";
import { freeze } from "../../fsm/fsm.ts";
import {
  AppendRequestSchema,
  INITIAL_REVISION,
  RevisionSchema,
  type CommittedBatch,
  type SessionPersistence,
} from "../persistence.ts";

/** Shared process-local data, intentionally outside all domain snapshots. No crash durability. */
export function createMemoryBacking() {
  return Object.assign(new Map<string, readonly CommittedBatch[]>(), {
    blobs: new Map<string, Map<string, { meta: BlobMeta; bytes: Uint8Array }>>(),
  });
}
export function createMemoryPersistence(backing = createMemoryBacking()): SessionPersistence {
  return {
    lifetime: "process-local",
    async putBlob(rawSessionId, rawBytes, rawMeta, signal) {
      signal.throwIfAborted();
      const sessionId = SessionIdSchema.parse(rawSessionId);
      const metadata = BlobInputMetaSchema.parse(rawMeta);
      if (!(rawBytes instanceof Uint8Array)) throw new Error("Blob must be a Uint8Array");
      if (rawBytes.byteLength > MAX_BLOB_BYTES) throw new Error("Blob exceeds 8 MiB");
      const bytes = Uint8Array.from(rawBytes);
      const id = hashBlob(bytes);
      const blobs = backing.blobs.get(sessionId) ?? new Map();
      const previous = blobs.get(id);
      if (previous) {
        if (previous.meta.media !== metadata.media)
          throw new Error("Blob media cannot change for existing bytes");
        return previous.meta;
      }
      const meta = BlobMetaSchema.parse({ ...metadata, id, bytes: bytes.byteLength });
      blobs.set(id, { meta, bytes });
      backing.blobs.set(sessionId, blobs);
      return meta;
    },
    async getBlob(rawSessionId, rawId, signal) {
      signal.throwIfAborted();
      const sessionId = SessionIdSchema.parse(rawSessionId);
      const id = BlobIdSchema.parse(rawId);
      const entry = backing.blobs.get(sessionId)?.get(id);
      return entry ? { meta: entry.meta, bytes: entry.bytes.slice() } : { kind: "not_found" };
    },
    async load(sessionId, signal) {
      if (signal.aborted) return { kind: "failed", message: "Load cancelled" };
      const batches = backing.get(sessionId);
      return batches
        ? freeze({
            kind: "loaded",
            revision: batches.at(-1)!.revision,
            batches: structuredClone(batches),
          })
        : { kind: "not_found" };
    },
    async append(raw, signal) {
      const parsed = AppendRequestSchema.safeParse(raw);
      if (!parsed.success) return { kind: "rejected", message: parsed.error.message };
      const request = parsed.data;
      const batches = backing.get(request.sessionId) ?? [];
      const previous = batches.find((batch) => batch.appendId === request.appendId);
      if (previous) {
        const { revision, ...original } = previous;
        return JSON.stringify(original) === JSON.stringify(request)
          ? {
              kind: "committed",
              receipt: { sessionId: request.sessionId, appendId: request.appendId, revision },
            }
          : { kind: "rejected", message: "Append ID reused with different content" };
      }
      if (signal.aborted) return { kind: "rejected", message: "Cancelled before append" };
      const revision = batches.at(-1)?.revision ?? INITIAL_REVISION;
      if (revision !== request.expectedRevision) return { kind: "conflict", revision };
      const next = RevisionSchema.parse(revision + request.records.length);
      backing.set(
        request.sessionId,
        freeze([...batches, { ...structuredClone(request), revision: next }]),
      );
      return {
        kind: "committed",
        receipt: { sessionId: request.sessionId, appendId: request.appendId, revision: next },
      };
    },
  };
}
