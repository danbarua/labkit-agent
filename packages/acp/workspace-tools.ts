import { dirname } from "node:path";

import {
  BlobIdSchema,
  defineTool,
  renderBlobPointer,
  type SessionPersistence,
} from "@labkit-agent/core";
import { diagnostic, diagnosticError } from "@labkit-agent/core/logging";
import { SessionIdSchema } from "@labkit-agent/core/types";
import { z } from "zod";

import type { ClientFiles } from "./client-files.ts";
import { recordWriteEvidence, type FileBefore } from "./file-write.ts";
import { FileReadRangeSchema, MAX_FILE_BYTES, type WorkspaceFiles } from "./workspace-files.ts";

const BLOB_SCHEME = /^blob:\/\//i;
const BLOB_URI = /^blob:\/\/([a-f0-9]{64})\.([a-z0-9]+)$/;

export function workspaceTools(
  files: WorkspaceFiles,
  client: ClientFiles = {},
  persistence?: SessionPersistence,
) {
  const scope = ` Relative paths use ${files.root}; allowed roots: ${JSON.stringify(files.roots)}.`;
  const path = z.string().min(1).transform(files.path);
  const readPath = z
    .string()
    .min(1)
    .transform((raw) => (BLOB_SCHEME.test(raw) ? raw : files.path(raw)));
  return new Map([
    [
      "read_file",
      defineTool({
        description:
          "Read a UTF-8 file inside the workspace, at most 256 KiB per result. Use line (1-based) and limit (line count) to read large files in sections; for example {path, line: 1, limit: 100}. If a path is missing, use list_dir on its parent to discover actual names before another read. If that directory is also missing, list an existing ancestor or the workspace root. Do not invent file paths or create a missing file merely to read it. A `blob://<sha256>.<ext>` path (from a prompt or tool result pointer) resolves the referenced attachment instead of a workspace file." +
          scope,
        input: FileReadRangeSchema.extend({ path: readPath }),
        kind: "read",
        locations: ({ path, line }) =>
          BLOB_SCHEME.test(path) ? [] : [{ path, ...(line === undefined ? {} : { line }) }],
        run: async ({ path, line, limit }, signal, context) => {
          if (BLOB_SCHEME.test(path)) {
            const match = BLOB_URI.exec(path);
            if (!match)
              throw new Error(
                `Invalid blob reference ${JSON.stringify(path)}: expected blob://<64-character lowercase hex sha256>.<ext>`,
              );
            if (!persistence) throw new Error(`Cannot resolve ${path}: no blob storage is bound`);
            const sessionId = context?.sessionId;
            if (!sessionId) throw new Error(`Cannot resolve ${path}: missing session context`);
            const loaded = await persistence.getBlob(
              SessionIdSchema.parse(sessionId),
              BlobIdSchema.parse(match[1]),
              signal,
            );
            if ("kind" in loaded) throw new Error(`Blob not found: ${path}`);
            const { meta, bytes } = loaded;
            if (meta.media !== "text/plain" && meta.media !== "text/markdown") {
              const text = `Attachment ${renderBlobPointer(meta)}`;
              return {
                text,
                parts: [
                  { type: "text", text },
                  {
                    type: "blob",
                    bytes,
                    media: meta.media,
                    ...(meta.name ? { name: meta.name } : {}),
                  },
                ],
              };
            }
            const full = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
            const lines = full.split("\n");
            const start = (line ?? 1) - 1;
            const selected = lines.slice(start, limit === undefined ? undefined : start + limit);
            const text = selected.join("\n");
            if (Buffer.byteLength(text) > MAX_FILE_BYTES)
              throw new Error(
                `read_file failed for ${JSON.stringify(path)}: result exceeds 256 KiB. ` +
                  `Call read_file with ${JSON.stringify({ path, line: line ?? 1, limit: limit === undefined ? 100 : Math.max(1, Math.floor(limit / 2)) })} to select fewer lines.`,
              );
            return { path, text };
          }
          const range = line === undefined && limit === undefined ? undefined : { line, limit };
          try {
            return {
              path,
              text: client.readText
                ? await client.readText(path, signal, context, range)
                : await files.readText(path, signal, context, range),
            };
          } catch (error) {
            if (signal.aborted || (error instanceof Error && error.name === "TimeoutError"))
              throw error;
            const cause = diagnosticError(error);
            throw new Error(
              `read_file failed for ${JSON.stringify(path)}: ${cause.message}. ` +
                `For an oversized response, call read_file with ${JSON.stringify({ path, line: line ?? 1, limit: limit === undefined ? 100 : Math.max(1, Math.floor(limit / 2)) })} to select fewer lines. ` +
                `For a missing or incorrect path, call list_dir with ${JSON.stringify({ path: dirname(path) })} to discover existing names, then read a path returned by that listing. ` +
                `If the parent is missing, list an existing ancestor or list_dir with {"path":"."} (workspace root ${JSON.stringify(files.root)}). ` +
                "A listing does not guarantee the requested file exists. Do not create or overwrite files to recover a read, or bypass a permission or workspace restriction.",
              { cause: error },
            );
          }
        },
      }),
    ],
    [
      "write_file",
      defineTool({
        description:
          "Replace or create a UTF-8 workspace file, at most 256 KiB. Capture readable prior contents to report the change; an unavailable diff does not prevent an approved write. Parent directories must exist." +
          scope,
        input: z.object({
          path,
          text: z
            .string()
            .refine(
              (value) => Buffer.byteLength(value) <= MAX_FILE_BYTES,
              "Write exceeds 256 KiB; narrow the write",
            ),
        }),
        kind: "edit",
        locations: ({ path }) => [{ path }],
        run: async ({ path, text }, signal, context) => {
          if (!client.write) {
            const result = await files.write(path, text, signal, context);
            recordWriteEvidence(result, context);
            return result;
          }
          let before: FileBefore = {
            kind: "unavailable",
            reasonCode: "read_not_supported",
            source: "client",
            reason:
              "The editor does not advertise fs.readTextFile; prior buffer contents are unknown",
          };
          if (client.readText) {
            try {
              before = {
                kind: "text",
                source: "client",
                text: await client.readText(path, signal, context),
              };
            } catch (error) {
              signal.throwIfAborted();
              if (error instanceof Error && error.name === "TimeoutError") throw error;
              diagnostic("acp.files", "warning", "workspace.write_baseline.failed", {
                ...context,
                path,
                source: "client",
                reason:
                  "Editor prior contents could not be captured; no diff can be produced if the write completes",
                error: diagnosticError(error),
              });
              before = {
                kind: "unavailable",
                reasonCode: "read_failed",
                source: "client",
                reason: `Editor baseline read failed: ${diagnosticError(error).message}. File existence is unknown`,
              };
            }
          }
          signal.throwIfAborted();
          const written = await client.write(path, text, signal, context);
          const result = { ...written, before, newText: text };
          recordWriteEvidence(result, context);
          return result;
        },
      }),
    ],
    [
      "list_dir",
      defineTool({
        description:
          "List one workspace directory without recursion; use path '.' for the workspace root." +
          scope,
        input: z.object({ path }),
        kind: "search",
        locations: ({ path }) => [{ path }],
        run: ({ path }, signal, context) => files.list(path, signal, context),
      }),
    ],
  ]);
}
