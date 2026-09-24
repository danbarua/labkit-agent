import { defineTool } from "@labkit-agent/core";
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
          "Read a UTF-8 file inside the workspace, at most 256 KiB. Use list_dir to narrow large directories." +
          scope,
        input: z.object({ path }),
        kind: "read",
        locations: ({ path }) => [{ path }],
        run: async ({ path }, signal, context) => ({
          path,
          text: client.readText
            ? await client.readText(path, signal, context)
            : await files.readText(path, signal, context),
        }),
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
