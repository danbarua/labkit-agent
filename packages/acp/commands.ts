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
export function bindCommands(commands: readonly AcpCommand[] = []): readonly AcpCommand[] {
  const parsed = z.array(CommandSchema).max(64).parse(commands);
  if (new Set(parsed.map((command) => command.name)).size !== parsed.length)
    throw new Error("Duplicate ACP command name");
  return Object.freeze(
    parsed.map((command) =>
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
  const command = match && commands.find((command) => command.name === match[1]);
  if (!command) return blocks;
  const text = `[Command: /${command.name}]\n${command.prompt}${match[2] ? `\n\n${match[2]}` : ""}`;
  return blocks.map((value, offset) => (offset === index ? { ...block, text } : value));
}
