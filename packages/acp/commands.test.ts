import { expect, test } from "bun:test";

import type { ContentBlock } from "@agentclientprotocol/sdk";

import { availableCommands, bindCommands, expandCommand } from "./commands.ts";

const command = {
  name: "review",
  description: "Review files",
  input: { hint: "focus" },
  prompt: "Review actual contents.",
};
test("command catalog copies bindings and advertises metadata without prompt templates", () => {
  const original = structuredClone(command);
  const commands = bindCommands([original]);
  original.prompt = "mutated";
  original.input.hint = "mutated";
  expect(commands[0]).toEqual(command);
  expect(availableCommands(commands)).toEqual([
    { name: "review", description: "Review files", input: { hint: "focus" } },
  ]);
  expect(() => bindCommands([command, command])).toThrow("Duplicate");
  expect(() => bindCommands([{ ...command, name: "/review" }])).toThrow();
});
test("only declared command prefixes expand; attachments and subsequent text are retained", () => {
  const commands = bindCommands([command]);
  const blocks: ContentBlock[] = [
    { type: "resource", resource: { uri: "untitled:design", text: "draft" } },
    { type: "text", text: "/review correctness\nand race conditions" },
    { type: "text", text: "extra context" },
  ];
  const result = expandCommand(blocks, commands);
  expect(result).toEqual([
    blocks[0]!,
    {
      type: "text",
      text: "[Command: /review]\nReview actual contents.\n\ncorrectness\nand race conditions",
    },
    blocks[2]!,
  ]);
  expect(blocks[1]).toEqual({ type: "text", text: "/review correctness\nand race conditions" });
  for (const text of ["/unknown thing", "/reviewing", "/tmp/file", "Explain /review"]) {
    const prompt: ContentBlock[] = [{ type: "text", text }];
    expect(expandCommand(prompt, commands)).toBe(prompt);
  }
});
