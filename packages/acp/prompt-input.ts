import { basename, extname } from "node:path";
import { fileURLToPath } from "node:url";

import { RequestError, type ContentBlock } from "@agentclientprotocol/sdk";
import {
  MAX_BLOB_BYTES,
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
) {
  const text: string[] = [];
  const attachments: BlobRef[] = [];
  // Validate block types and lexical paths before reading bytes; reads also check symlinks.
  const locals: { path: string; media: MediaKind }[] = [];
  let files: Awaited<ReturnType<typeof workspaceFiles>> | undefined;
  for (const block of blocks) {
    signal.throwIfAborted();
    if (block.type === "text") {
      text.push(block.text);
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
      files ??= await workspaceFiles(cwd);
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
      locals.push({ path, media });
    } catch (error) {
      throw RequestError.invalidParams(
        undefined,
        error instanceof Error ? error.message : "Invalid workspace resource",
      );
    }
  }
  if (!text.join("\n").trim())
    throw RequestError.invalidParams(undefined, "Prompt must not be empty");
  for (const { path, media } of locals) {
    signal.throwIfAborted();
    let bytes: Uint8Array;
    try {
      bytes = await files!.read(path, signal, MAX_BLOB_BYTES);
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
      await persistence.putBlob(sessionId, bytes, { media, name: basename(path) }, signal),
    );
  }
  signal.throwIfAborted();
  return { text: text.join("\n"), ...(attachments.length ? { attachments } : {}) };
}
