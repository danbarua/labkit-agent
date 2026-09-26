import { z } from "zod";

/** Largest attachment (blob) size that {@link BlobRefSchema} accepts, in bytes (8 MiB). */
export const MAX_BLOB_BYTES = 8 * 1024 * 1024;
/**
 * Content address of a stored attachment: the lowercase hex SHA-256 of its bytes.
 * Equal bytes always get the same id; see {@link hashBlob}.
 */
export const BlobIdSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .brand<"BlobId">();
/** Content address of a stored attachment: lowercase hex SHA-256 of its bytes. */
export type BlobId = z.infer<typeof BlobIdSchema>;
/** Audio media types an attachment may declare. Part of {@link MediaKindSchema}. */
export const AUDIO_MEDIA_KINDS = [
  "audio/wav",
  "audio/mpeg",
  "audio/mp3",
  "audio/aiff",
  "audio/aac",
  "audio/ogg",
  "audio/flac",
  "audio/m4a",
  "audio/l16",
  "audio/opus",
  "audio/alaw",
  "audio/mulaw",
  "audio/webm",
] as const;

/** Media types an attachment may declare: text, Markdown, PNG, JPEG, PDF and the audio kinds. */
export const MediaKindSchema = z.enum([
  "text/markdown",
  "text/plain",
  "image/png",
  "image/jpeg",
  "application/pdf",
  ...AUDIO_MEDIA_KINDS,
]);
/** Media type of an attachment. See {@link MediaKindSchema}. */
export type MediaKind = z.infer<typeof MediaKindSchema>;
/**
 * Reference to an attachment stored outside the message, carried in a `blob` content part.
 * History and snapshots hold only this reference; the bytes are fetched by id with a
 * {@link BlobResolver} while a completion request is encoded.
 *
 * `bytes` is the stored size in bytes (at most {@link MAX_BLOB_BYTES}); `name` is an optional
 * display file name.
 */
export const BlobRefSchema = z
  .strictObject({
    id: BlobIdSchema,
    media: MediaKindSchema,
    bytes: z.number().int().nonnegative().max(MAX_BLOB_BYTES),
    name: z.string().min(1).optional(),
  })
  .readonly();
/** Reference to a stored attachment; the bytes stay outside history. See {@link BlobRefSchema}. */
export type BlobRef = z.infer<typeof BlobRefSchema>;
/** Stored metadata of a blob. Same shape as {@link BlobRefSchema}. */
export const BlobMetaSchema = BlobRefSchema;
/** Stored metadata of a blob. Same shape as {@link BlobRef}. */
export type BlobMeta = BlobRef;
/**
 * Metadata a caller supplies when storing new blob bytes: the media type and an optional name.
 * The id and size are derived from the bytes.
 */
export const BlobInputMetaSchema = BlobRefSchema.unwrap().pick({ media: true, name: true });
/**
 * One piece of message content: inline `text`, or a `blob` that references a stored attachment.
 * A message's `text` must equal the concatenation of its text parts (see {@link partsText}).
 */
export const ContentPartSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), text: z.string() }).readonly(),
  z.strictObject({ type: z.literal("blob"), ref: BlobRefSchema }).readonly(),
]);
/** One piece of message content: inline text or a stored attachment reference. */
export type ContentPart = z.infer<typeof ContentPartSchema>;
/** Ordered content parts of one message. */
export const ContentPartsSchema = z.array(ContentPartSchema).readonly();
/** Joins the text parts in order, with no separator. Blob parts contribute nothing. */
export function partsText(parts: readonly ContentPart[]) {
  return parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}
/** Lists every blob reference in the messages' content parts, in order, duplicates included. */
export function blobRefs(
  messages: readonly { role: string; parts?: readonly ContentPart[] }[],
): BlobRef[] {
  return messages.flatMap((message) =>
    (message.parts ?? []).flatMap((part) => (part.type === "blob" ? [part.ref] : [])),
  );
}
/**
 * Returns the stored bytes for a blob id.
 * Bytes are operation-local resources, never snapshot fields.
 */
export type BlobResolver = (id: BlobId) => Uint8Array;
/** Computes the {@link BlobId} of the bytes: their lowercase hex SHA-256 digest. */
export function hashBlob(bytes: Uint8Array): BlobId {
  return BlobIdSchema.parse(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"));
}

/**
 * How well a projection target can read one media kind: `supported` renders the content directly,
 * `unsupported` never can, `unknown` means the target's capabilities were not confirmed for it.
 * `unsupported` and `unknown` both render as a pointer; see {@link renderBlobPointer}.
 */
export const MediaSupportSchema = z.enum(["supported", "unsupported", "unknown"]);
/** See {@link MediaSupportSchema}. */
export type MediaSupport = z.infer<typeof MediaSupportSchema>;

/** File extension a stored blob's {@link blobUri} uses, by media type. */
const MEDIA_EXTENSION: Record<MediaKind, string> = {
  "text/markdown": "md",
  "text/plain": "txt",
  "image/png": "png",
  "image/jpeg": "jpg",
  "application/pdf": "pdf",
  "audio/wav": "wav",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/aiff": "aiff",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "audio/m4a": "m4a",
  "audio/l16": "l16",
  "audio/opus": "opus",
  "audio/alaw": "alaw",
  "audio/mulaw": "mulaw",
  "audio/webm": "webm",
};

/** The reference form of a stored blob: `blob://<sha256>.<ext>`. The harness resolves it. */
export function blobUri(ref: BlobRef): string {
  return `blob://${ref.id}.${MEDIA_EXTENSION[ref.media]}`;
}

function formatBlobBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${Number(value.toFixed(value < 10 ? 1 : 0))} ${units[unit]}`;
}

/**
 * Renders a blob a projection target cannot, or might not be able to, read as pointer text the
 * model can follow with a tool that resolves `blob://` URIs, for example
 * `[image/png, 68 KiB: blob://9f86d0….png]`. Shared by prompt projection and tool result parts.
 */
export function renderBlobPointer(ref: BlobRef): string {
  const name = ref.name ? `, ${ref.name}` : "";
  return `[${ref.media}, ${formatBlobBytes(ref.bytes)}${name}: ${blobUri(ref)}]`;
}
