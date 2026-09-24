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
/** Called inside operation lifetimes only. Replay never reads the object store. */
export async function resolveRequestBlobs(
  port: SessionPersistence,
  sessionId: SessionId,
  request: PreparedModel,
  media: readonly MediaKind[],
  signal: AbortSignal,
): Promise<BlobResolver> {
  const refs = blobRefs(request.messages);
  for (const ref of refs)
    if (!media.includes(ref.media))
      throw new Error(`Provider does not support attachment media: ${ref.media}`);
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
/** Copy only refs inherited by the child, before publishing its creation. */
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
