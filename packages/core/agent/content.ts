import { z } from "zod";

export const MAX_BLOB_BYTES = 8 * 1024 * 1024;
export const BlobIdSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .brand<"BlobId">();
export type BlobId = z.infer<typeof BlobIdSchema>;
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

export const MediaKindSchema = z.enum([
  "text/markdown",
  "text/plain",
  "image/png",
  "image/jpeg",
  "application/pdf",
  ...AUDIO_MEDIA_KINDS,
]);
export type MediaKind = z.infer<typeof MediaKindSchema>;
export const BlobRefSchema = z
  .strictObject({
    id: BlobIdSchema,
    media: MediaKindSchema,
    bytes: z.number().int().nonnegative().max(MAX_BLOB_BYTES),
    name: z.string().min(1).optional(),
  })
  .readonly();
export type BlobRef = z.infer<typeof BlobRefSchema>;
export const BlobMetaSchema = BlobRefSchema;
export type BlobMeta = BlobRef;
export const BlobInputMetaSchema = BlobRefSchema.unwrap().pick({ media: true, name: true });
export const ContentPartSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), text: z.string() }).readonly(),
  z.strictObject({ type: z.literal("blob"), ref: BlobRefSchema }).readonly(),
]);
export type ContentPart = z.infer<typeof ContentPartSchema>;
export const ContentPartsSchema = z.array(ContentPartSchema).readonly();
export function partsText(parts: readonly ContentPart[]) {
  return parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}
export function blobRefs(
  messages: readonly { role: string; parts?: readonly ContentPart[] }[],
): BlobRef[] {
  return messages.flatMap((message) =>
    (message.parts ?? []).flatMap((part) => (part.type === "blob" ? [part.ref] : [])),
  );
}
/** Bytes are operation-local resources, never snapshot fields. */
export type BlobResolver = (id: BlobId) => Uint8Array;
export function hashBlob(bytes: Uint8Array): BlobId {
  return BlobIdSchema.parse(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"));
}
