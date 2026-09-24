import type { ToolRunContext } from "@labkit-agent/core/host";
import { diagnostic } from "@labkit-agent/core/logging";
import { z } from "zod";

import type { AcpToolContent } from "./tool-content.ts";

export const FileBeforeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string(), source: z.enum(["filesystem", "client"]) }),
  z.object({ kind: z.literal("absent"), source: z.literal("filesystem") }),
  z.object({
    kind: z.literal("unavailable"),
    reasonCode: z.enum(["read_not_supported", "read_failed"]),
    reason: z.string(),
    source: z.enum(["filesystem", "client"]),
  }),
]);

export type FileBefore = z.infer<typeof FileBeforeSchema>;

export const FileWriteResultSchema = z.object({
  path: z.string(),
  bytes: z.number().int().nonnegative(),
  before: FileBeforeSchema,
  newText: z.string(),
});

export type FileWriteResult = z.infer<typeof FileWriteResultSchema>;

export function recordWriteEvidence(result: FileWriteResult, context?: ToolRunContext) {
  const { before, path, bytes } = result;
  diagnostic(
    "acp.files",
    before.kind === "unavailable" && before.reasonCode !== "read_not_supported"
      ? "warning"
      : "info",
    before.kind === "unavailable"
      ? "workspace.write_evidence.unavailable"
      : "workspace.write_evidence.captured",
    {
      ...context,
      path,
      beforeKind: before.kind,
      source: before.source,
      ...(before.kind === "text" ? { beforeBytes: Buffer.byteLength(before.text) } : {}),
      bytes,
      reason:
        before.kind === "unavailable"
          ? `Write completed, but no before/after diff can be shown: ${before.reason}`
          : "Write completed; observed prior contents and written text are retained in the tool result",
    },
  );
}

export const workspaceWriteContent: AcpToolContent = ({ output }) => {
  const result = FileWriteResultSchema.parse(JSON.parse(output));
  if (result.before.kind === "unavailable")
    return [
      {
        type: "content",
        content: {
          type: "text",
          text: `Wrote ${result.bytes} bytes to ${result.path}. Diff unavailable: ${result.before.reason}`,
        },
      },
    ];
  return [
    {
      type: "diff",
      path: result.path,
      oldText: result.before.kind === "absent" ? null : result.before.text,
      newText: result.newText,
      _meta: {
        "labkit.dev/baseline":
          result.before.kind === "absent"
            ? "exclusive_file_creation"
            : result.before.source === "client"
              ? "editor_pre_write_read"
              : "filesystem_pre_write_read",
      },
    },
  ];
};

export const workspaceToolContent: ReadonlyMap<string, AcpToolContent> = new Map([
  ["write_file", workspaceWriteContent],
]);
