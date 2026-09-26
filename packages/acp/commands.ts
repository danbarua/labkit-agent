import type { AvailableCommand, ContentBlock } from "@agentclientprotocol/sdk";
import { z } from "zod";

const CommandSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  description: z.string().min(1).max(1024),
  input: z.strictObject({ hint: z.string().min(1).max(1024) }).optional(),
  prompt: z.string().min(1).max(65536),
});
/** A prompt template, not an execution callback or permission bypass. */
export type AcpCommand = z.infer<typeof CommandSchema>;

/**
 * Name of the built-in `/export` command. It always appears in {@link bindCommands}'s result and
 * {@link availableCommands}, and {@link expandCommand} never expands it into a model prompt: the
 * session/prompt handler intercepts it and runs it locally. See `rpc/prompt.ts`.
 */
export const EXPORT_COMMAND_NAME = "export";

const exportCommand: AcpCommand = Object.freeze({
  name: EXPORT_COMMAND_NAME,
  description:
    "Write this session's history to a Markdown file under .labkit/exports and reply with its path.",
  prompt: "This command runs locally and must never reach the model.",
});

export function bindCommands(commands: readonly AcpCommand[] = []): readonly AcpCommand[] {
  const parsed = z
    .array(CommandSchema)
    .max(64)
    .parse(commands)
    .filter((command) => command.name !== EXPORT_COMMAND_NAME);
  if (new Set(parsed.map((command) => command.name)).size !== parsed.length)
    throw new Error("Duplicate ACP command name");
  return Object.freeze(
    [...parsed, exportCommand].map((command) =>
      Object.freeze({
        ...command,
        ...(command.input ? { input: Object.freeze(command.input) } : {}),
      }),
    ),
  );
}
export function availableCommands(commands: readonly AcpCommand[]): AvailableCommand[] {
  return commands.map(({ prompt: _, ...command }) => structuredClone(command));
}
export function expandCommand(
  blocks: ContentBlock[],
  commands: readonly AcpCommand[],
): ContentBlock[] {
  const index = blocks.findIndex((block) => block.type === "text");
  const block = blocks[index];
  if (block?.type !== "text") return blocks;
  const match = /^\s*\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/.exec(block.text);
  const command =
    match &&
    match[1] !== EXPORT_COMMAND_NAME &&
    commands.find((command) => command.name === match[1]);
  if (!command) return blocks;
  const text = `[Command: /${command.name}]\n${command.prompt}${match[2] ? `\n\n${match[2]}` : ""}`;
  return blocks.map((value, offset) => (offset === index ? { ...block, text } : value));
}
