import { dirname } from "node:path";

import { defineTool } from "@labkit-agent/core";
import { diagnosticError } from "@labkit-agent/core/logging";
import { z } from "zod";

import type { ClientFiles } from "./client-files.ts";
import { MAX_FILE_BYTES, type WorkspaceFiles } from "./workspace-files.ts";

export function workspaceTools(files: WorkspaceFiles, client: ClientFiles = {}) {
  const scope = ` Relative paths use ${files.root}; allowed roots: ${JSON.stringify(files.roots)}.`;
  const path = z.string().min(1).transform(files.path);
  return new Map([
    [
      "read_file",
      defineTool({
        description:
          "Read a UTF-8 file inside the workspace, at most 256 KiB. If a path is missing, use list_dir on its parent to discover actual names before another read. If that directory is also missing, list an existing ancestor or the workspace root. Do not invent file paths or create a missing file merely to read it." +
          scope,
        input: z.object({ path }),
        kind: "read",
        locations: ({ path }) => [{ path }],
        run: async ({ path }, signal, context) => {
          try {
            return {
              path,
              text: client.readText
                ? await client.readText(path, signal, context)
                : await files.readText(path, signal, context),
            };
          } catch (error) {
            if (signal.aborted || (error instanceof Error && error.name === "TimeoutError"))
              throw error;
            const cause = diagnosticError(error);
            throw new Error(
              `read_file failed for ${JSON.stringify(path)}: ${cause.message}. ` +
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
          "Replace or create a UTF-8 workspace file, at most 256 KiB. Parent directories must exist." +
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
        run: ({ path, text }, signal, context) =>
          client.write
            ? client.write(path, text, signal, context)
            : files.write(path, text, signal, context),
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
