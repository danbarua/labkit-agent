import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { ContentBlock } from "@agentclientprotocol/sdk";
import { journalMarkdown, type JournalState } from "@labkit-agent/core";

import { EXPORT_COMMAND_NAME } from "./commands.ts";

const LEADING_COMMAND = /^\s*\/([a-z][a-z0-9_-]*)(?:\s|$)/;

/**
 * True when the prompt's leading text block invokes the built-in `/export` command. The
 * `session/prompt` handler checks this before calling {@link expandCommand} so the request never
 * reaches the model.
 */
export function isExportCommand(blocks: readonly ContentBlock[]): boolean {
  const block = blocks.find((candidate) => candidate.type === "text");
  return block?.type === "text" && LEADING_COMMAND.exec(block.text)?.[1] === EXPORT_COMMAND_NAME;
}

/**
 * Renders the session's journal as Markdown (facts only, no stored prompts; blob parts render as
 * their `blob://` URI) and writes it under the workspace, without consulting or calling the model.
 * Returns the absolute path written.
 */
export async function writeSessionExport(
  cwd: string,
  sessionId: string,
  state: JournalState,
): Promise<string> {
  const directory = join(cwd, ".labkit", "exports");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${sessionId}.md`);
  await Bun.write(path, journalMarkdown(state));
  return path;
}
