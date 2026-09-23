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
  return new Map<string, readonly CommittedBatch[]>();
}
export function createMemoryPersistence(backing = createMemoryBacking()): SessionPersistence {
  return {
    lifetime: "process-local",
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
