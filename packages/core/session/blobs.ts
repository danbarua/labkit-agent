import { z } from "zod";

import type { PreparedModel } from "../agent/agent.ts";
import {
  blobRefs,
  BlobRefSchema,
  hashBlob,
  type BlobRef,
  type BlobResolver,
  type MediaKind,
} from "../agent/content.ts";
import type { SessionId } from "../agent/types.ts";
import { ContinuationSchema, type Continuation } from "../providers/types.ts";
import type { SessionPersistence } from "./persistence.ts";

async function readBlob(
  port: SessionPersistence,
  sessionId: SessionId,
  ref: BlobRef,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const loaded = await port.getBlob(sessionId, ref.id, signal);
  signal.throwIfAborted();
  if ("kind" in loaded) throw new Error(`Missing attachment blob: ${ref.id}`);
  const meta = BlobRefSchema.parse(loaded.meta);
  if (!(loaded.bytes instanceof Uint8Array) || loaded.bytes.byteLength !== ref.bytes)
    throw new Error(`Attachment byte count mismatch: ${ref.id}`);
  const bytes = Uint8Array.from(loaded.bytes);
  if (
    meta.id !== ref.id ||
    meta.media !== ref.media ||
    meta.bytes !== ref.bytes ||
    bytes.byteLength !== ref.bytes ||
    hashBlob(bytes) !== ref.id
  )
    throw new Error(`Attachment metadata or hash mismatch: ${ref.id}`);
  return { meta, bytes };
}
/**
 * Reads and verifies the blobs a prepared completion request refers to and returns a resolver that
 * hands out copies of their bytes. Called inside operation lifetimes only. Replay never reads the
 * object store.
 * @param media Attachment media the bound provider accepts; checked for message attachments only.
 * @param includeContinuations Also read the payload blobs of continuations (provider continuation
 * payloads, not the next step).
 * @throws when an attachment's media is unsupported, a blob is missing, or its size, media or hash
 * does not match its ref.
 */
export async function resolveRequestBlobs(
  port: SessionPersistence,
  sessionId: SessionId,
  request: PreparedModel,
  media: readonly MediaKind[],
  signal: AbortSignal,
  includeContinuations = false,
): Promise<BlobResolver> {
  const refs = blobRefs(request.messages);
  for (const ref of refs)
    if (!media.includes(ref.media))
      throw new Error(`Provider does not support attachment media: ${ref.media}`);
  if (includeContinuations) refs.push(...continuationBlobRefs(request.continuations ?? []));
  const blobs = new Map<string, { ref: BlobRef; bytes: Uint8Array }>();
  for (const ref of refs) {
    const existing = blobs.get(ref.id);
    if (existing && (existing.ref.media !== ref.media || existing.ref.bytes !== ref.bytes))
      throw new Error("Conflicting attachment metadata");
    if (!existing)
      blobs.set(ref.id, { ref, bytes: (await readBlob(port, sessionId, ref, signal)).bytes });
  }
  return (id) => {
    const blob = blobs.get(id);
    if (!blob) throw new Error(`Unresolved attachment blob: ${id}`);
    return blob.bytes.slice();
  };
}
/**
 * Copies the blobs a child session (fork or compaction) inherits from its parent. Copy only refs
 * inherited by the child, before publishing its creation.
 * @throws when a blob is missing or corrupt in the parent, or the child's copy does not match.
 */
export async function copyBranchBlobs(
  port: SessionPersistence,
  parent: SessionId,
  child: SessionId,
  refs: readonly BlobRef[],
  signal: AbortSignal,
) {
  const copied = new Set<string>();
  for (const ref of refs) {
    if (copied.has(ref.id)) continue;
    const loaded = await readBlob(port, parent, ref, signal);
    const meta = await port.putBlob(
      child,
      loaded.bytes,
      { media: loaded.meta.media, ...(loaded.meta.name ? { name: loaded.meta.name } : {}) },
      signal,
    );
    signal.throwIfAborted();
    if (meta.id !== ref.id || meta.media !== ref.media || meta.bytes !== ref.bytes)
      throw new Error("Branch blob copy mismatch");
    copied.add(ref.id);
  }
}

/** Blob refs of continuations whose payload was stored as a blob rather than inline. */
export function continuationBlobRefs(entries: readonly Continuation[]) {
  return entries.flatMap((entry) => (entry.payloadBlob ? [entry.payloadBlob] : []));
}
/**
 * Builds the continuation (provider continuation payload) to journal with a settled step. A
 * payload up to 65,536 characters of JSON stays inline; a larger one is stored as a `text/plain`
 * blob and referenced by `payloadBlob`.
 * @throws when the payload is not JSON or the stored blob does not match.
 */
export async function storeContinuation(
  port: SessionPersistence,
  sessionId: SessionId,
  entry: { provider: string; owner: Continuation["owner"]; payload: unknown },
  signal: AbortSignal,
): Promise<Continuation> {
  signal.throwIfAborted();
  const payload = z.json().parse(entry.payload);
  const serialized = JSON.stringify(payload);
  if (serialized.length <= 65536) return ContinuationSchema.parse({ ...entry, payload });
  const bytes = new TextEncoder().encode(serialized);
  const payloadBlob = await port.putBlob(sessionId, bytes, { media: "text/plain" }, signal);
  signal.throwIfAborted();
  if (payloadBlob.id !== hashBlob(bytes) || payloadBlob.bytes !== bytes.length)
    throw new Error("Continuation blob write mismatch");
  return ContinuationSchema.parse({ provider: entry.provider, owner: entry.owner, payloadBlob });
}
