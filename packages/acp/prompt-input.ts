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

import { diagnostic, diagnosticError } from "../core/logging/index.ts";
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
  const started = performance.now();
  let stage = "validate";
  let blockIndex = -1;
  let path: string | undefined;
  let media: string | undefined;
  diagnostic("acp", "debug", "prompt.ingest.started", { sessionId, cwd, count: blocks.length });
  try {
    const text: string[] = [];
    const attachments: BlobRef[] = [];
    // Validate block types and lexical paths before reading bytes; reads also check symlinks.
    const pending: (
      { path: string; media: MediaKind } | { bytes: Uint8Array; name: string; media: MediaKind }
    )[] = [];
    let files: Awaited<ReturnType<typeof workspaceFiles>> | undefined;
    for (const block of blocks) {
      blockIndex++;
      signal.throwIfAborted();
      if (block.type === "text") {
        text.push(block.text);
        continue;
      }
      if (block.type === "image" || block.type === "audio" || block.type === "resource") {
        const resource = block.type === "resource" ? block.resource : undefined;
        const name =
          resource?.uri || (block.type === "image" ? block.uri : undefined) || block.type;
        let media: MediaKind;
        let bytes: Uint8Array;
        if (resource && "text" in resource) {
          media = resource.mimeType === "text/markdown" ? "text/markdown" : "text/plain";
          if (Buffer.byteLength(resource.text) > MAX_BLOB_BYTES)
            throw RequestError.invalidParams(undefined, "Embedded resource exceeds 8 MiB");
          bytes = new TextEncoder().encode(resource.text);
        } else {
          const mime =
            block.type === "image" || block.type === "audio" ? block.mimeType : resource?.mimeType;
          const parsed = MediaKindSchema.safeParse(mime);
          if (
            !parsed.success ||
            (block.type === "image" && !parsed.data.startsWith("image/")) ||
            (block.type === "audio" && !parsed.data.startsWith("audio/"))
          )
            throw RequestError.invalidParams(undefined, "Unsupported embedded media type");
          media = parsed.data;
          const encoded =
            block.type === "image" || block.type === "audio"
              ? block.data
              : resource && "blob" in resource
                ? resource.blob
                : "";
          if (encoded.length > 4 * Math.ceil(MAX_BLOB_BYTES / 3))
            throw RequestError.invalidParams(undefined, "Embedded resource exceeds 8 MiB");
          bytes = Buffer.from(encoded, "base64");
          if (Buffer.from(bytes).toString("base64") !== encoded)
            throw RequestError.invalidParams(
              undefined,
              "Embedded content must be canonical base64",
            );
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
        throw RequestError.invalidParams(undefined, "Unsupported prompt content");
      text.push(
        `[Resource: ${block.name}] ${block.uri}${block.description ? `\n${block.description}` : ""}`,
      );
      const scheme = /^[a-z][a-z\d+.-]*:/i.exec(block.uri)?.[0];
      if (scheme && scheme.toLowerCase() !== "file:") continue; // References only, never HTTP fetches.
      try {
        if (decodeURIComponent(block.uri).split(/[\\/]/).includes(".."))
          throw new Error("Parent traversal is not allowed");
        const raw = scheme ? fileURLToPath(block.uri) : block.uri;
        path = raw;
        files ??= await workspaceFiles(cwd, additionalDirectories);
        path = files.path(raw);
        const extension = extname(path).toLowerCase();
        const declared = MediaKindSchema.safeParse(block.mimeType);
        const audioExtension: Record<string, MediaKind> = {
          ".wav": "audio/wav",
          ".mp3": "audio/mpeg",
          ".aiff": "audio/aiff",
          ".aac": "audio/aac",
          ".ogg": "audio/ogg",
          ".flac": "audio/flac",
          ".m4a": "audio/m4a",
          ".opus": "audio/opus",
          ".webm": "audio/webm",
        };
        const media: MediaKind =
          declared.success && declared.data.startsWith("audio/")
            ? declared.data
            : (audioExtension[extension] ??
              (extension === ".pdf"
                ? "application/pdf"
                : extension === ".png"
                  ? "image/png"
                  : [".jpg", ".jpeg"].includes(extension)
                    ? "image/jpeg"
                    : [".md", ".markdown"].includes(extension)
                      ? "text/markdown"
                      : "text/plain"));
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
    for (const item of pending) {
      media = item.media;
      if (supportedMedia && !supportedMedia.includes(item.media))
        throw RequestError.invalidParams(
          undefined,
          `Provider does not support attachment media: ${media}; supported media: ${supportedMedia.join(", ") || "none"}`,
        );
    }
    for (const item of pending) {
      media = item.media;
      path = "path" in item ? item.path : undefined;
      stage = "read";
      diagnostic("acp", "debug", "attachment.read.started", {
        sessionId,
        path,
        media,
        source: "path" in item ? "file" : "embedded",
        maxBytes: MAX_BLOB_BYTES,
      });
      const itemMedia = item.media;
      signal.throwIfAborted();
      let bytes: Uint8Array;
      try {
        bytes = "bytes" in item ? item.bytes : await files!.read(item.path, signal, MAX_BLOB_BYTES);
        if (itemMedia.startsWith("text/")) new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch (error) {
        if (signal.aborted) throw error;
        throw RequestError.invalidParams(
          undefined,
          error instanceof Error ? error.message : "Cannot read workspace resource",
        );
      }
      signal.throwIfAborted();
      stage = "put_blob";
      const ref = await persistence.putBlob(
        sessionId,
        bytes,
        { media: itemMedia, name: "name" in item ? item.name : basename(item.path) },
        signal,
      );
      attachments.push(ref);
      diagnostic("acp", "debug", "attachment.stored", {
        sessionId,
        path,
        media,
        blobId: ref.id,
        bytes: bytes.byteLength,
      });
    }
    signal.throwIfAborted();
    diagnostic("acp", "debug", "prompt.ingest.completed", {
      sessionId,
      count: attachments.length,
      durationMs: performance.now() - started,
    });
    return { text: text.join("\n"), ...(attachments.length ? { attachments } : {}) };
  } catch (error) {
    diagnostic(
      "acp",
      signal.aborted ? "info" : "warning",
      signal.aborted ? "prompt.ingest.cancelled" : "prompt.ingest.failed",
      {
        sessionId,
        path,
        media,
        stage,
        blockIndex,
        durationMs: performance.now() - started,
        error: diagnosticError(error),
      },
    );
    throw error;
  }
}
