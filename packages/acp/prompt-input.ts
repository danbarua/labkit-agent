import { basename, extname } from "node:path";
import { fileURLToPath } from "node:url";

import { RequestError, type ContentBlock } from "@agentclientprotocol/sdk";
import {
  MAX_BLOB_BYTES,
  MediaKindSchema,
  type BlobRef,
  type MediaKind,
  type SessionPersistence,
} from "@labkit-agent/core";
import type { SessionIdSchema } from "@labkit-agent/core/types";
import type { z } from "zod";

import { workspaceFiles } from "./workspace-files.ts";

export async function promptInput(
  blocks: ContentBlock[],
  cwd: string,
  persistence: SessionPersistence,
  sessionId: z.infer<typeof SessionIdSchema>,
  signal: AbortSignal,
  supportedMedia?: readonly MediaKind[],
  additionalDirectories: readonly string[] = [],
) {
  const text: string[] = [];
  const attachments: BlobRef[] = [];
  // Validate block types and lexical paths before reading bytes; reads also check symlinks.
  const pending: (
    { path: string; media: MediaKind } | { bytes: Uint8Array; name: string; media: MediaKind }
  )[] = [];
  let files: Awaited<ReturnType<typeof workspaceFiles>> | undefined;
  for (const block of blocks) {
    signal.throwIfAborted();
    if (block.type === "text") {
      text.push(block.text);
      continue;
    }
    if (block.type === "image" || block.type === "resource") {
      const resource = block.type === "resource" ? block.resource : undefined;
      const name = resource?.uri || (block.type === "image" ? block.uri : undefined) || "image";
      let media: MediaKind;
      let bytes: Uint8Array;
      if (resource && "text" in resource) {
        media = resource.mimeType === "text/markdown" ? "text/markdown" : "text/plain";
        if (Buffer.byteLength(resource.text) > MAX_BLOB_BYTES)
          throw RequestError.invalidParams(undefined, "Embedded resource exceeds 8 MiB");
        bytes = new TextEncoder().encode(resource.text);
      } else {
        const mime = block.type === "image" ? block.mimeType : resource?.mimeType;
        const parsed = MediaKindSchema.safeParse(mime);
        if (!parsed.success || (block.type === "image" && !parsed.data.startsWith("image/")))
          throw RequestError.invalidParams(undefined, "Unsupported embedded media type");
        media = parsed.data;
        const encoded =
          block.type === "image" ? block.data : resource && "blob" in resource ? resource.blob : "";
        if (encoded.length > 4 * Math.ceil(MAX_BLOB_BYTES / 3))
          throw RequestError.invalidParams(undefined, "Embedded resource exceeds 8 MiB");
        bytes = Buffer.from(encoded, "base64");
        if (Buffer.from(bytes).toString("base64") !== encoded)
          throw RequestError.invalidParams(undefined, "Embedded content must be canonical base64");
        if (bytes.byteLength > MAX_BLOB_BYTES)
          throw RequestError.invalidParams(undefined, "Embedded resource exceeds 8 MiB");
        if (media.startsWith("text/")) {
          try {
            new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch {
            throw RequestError.invalidParams(undefined, "Embedded text must be UTF-8");
          }
        }
      }
      text.push(`[Attachment: ${name}]`);
      pending.push({ bytes, name, media });
      continue;
    }
    if (block.type !== "resource_link")
      throw RequestError.invalidParams(undefined, `Unsupported prompt content: ${block.type}`);
    text.push(
      `[Resource: ${block.name}] ${block.uri}${block.description ? `\n${block.description}` : ""}`,
    );
    const scheme = /^[a-z][a-z\d+.-]*:/i.exec(block.uri)?.[0];
    if (scheme && scheme.toLowerCase() !== "file:") continue; // References only, never HTTP fetches.
    try {
      if (decodeURIComponent(block.uri).split(/[\\/]/).includes(".."))
        throw new Error("Parent traversal is not allowed");
      const raw = scheme ? fileURLToPath(block.uri) : block.uri;
      files ??= await workspaceFiles(cwd, additionalDirectories);
      const path = files.path(raw);
      const extension = extname(path).toLowerCase();
      const media: MediaKind =
        extension === ".pdf"
          ? "application/pdf"
          : extension === ".png"
            ? "image/png"
            : [".jpg", ".jpeg"].includes(extension)
              ? "image/jpeg"
              : [".md", ".markdown"].includes(extension)
                ? "text/markdown"
                : "text/plain";
      pending.push({ path, media });
    } catch (error) {
      throw RequestError.invalidParams(
        undefined,
        error instanceof Error ? error.message : "Invalid workspace resource",
      );
    }
  }
  if (!text.join("\n").trim())
    throw RequestError.invalidParams(undefined, "Prompt must not be empty");
  for (const { media } of pending)
    if (supportedMedia && !supportedMedia.includes(media))
      throw RequestError.invalidParams(
        undefined,
        `Provider does not support attachment media: ${media}`,
      );
  for (const item of pending) {
    const { media } = item;
    signal.throwIfAborted();
    let bytes: Uint8Array;
    try {
      bytes = "bytes" in item ? item.bytes : await files!.read(item.path, signal, MAX_BLOB_BYTES);
      if (media.startsWith("text/")) new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      if (signal.aborted) throw error;
      throw RequestError.invalidParams(
        undefined,
        error instanceof Error ? error.message : "Cannot read workspace resource",
      );
    }
    signal.throwIfAborted();
    attachments.push(
      await persistence.putBlob(
        sessionId,
        bytes,
        { media, name: "name" in item ? item.name : basename(item.path) },
        signal,
      ),
    );
  }
  signal.throwIfAborted();
  return { text: text.join("\n"), ...(attachments.length ? { attachments } : {}) };
}
