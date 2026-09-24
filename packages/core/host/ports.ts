import { z } from "zod";

import { createChatCompletion, type PreparedModel } from "../agent/agent.ts";
import type { BlobResolver } from "../agent/content.ts";
import { AgentIdSchema, ToolNameSchema } from "../agent/types.ts";
import { freeze } from "../fsm/fsm.ts";

/**
 * Existential tool adapter: defineTool retains input-schema inference at the authoring boundary.
 * Successful outputs must be JSON values. The host rejects undefined, Date, class instances,
 * functions and other non-JSON values as correlated failed tool outcomes. Return null for no value.
 * Strings pass through; other JSON values are serialized for model tool messages.
 */
export type Tool = Readonly<{
  description?: string;
  parameters: Record<string, unknown>;
  parseInput: (raw: unknown) => Promise<unknown>;
  run: (input: unknown, signal: AbortSignal) => unknown | Promise<unknown>;
}>;
export function defineTool<S extends z.ZodType>(definition: {
  input: S;
  description?: string;
  run: (input: z.output<S>, signal: AbortSignal) => unknown | Promise<unknown>;
}): Tool {
  return Object.freeze({
    description: definition.description,
    parameters: z.toJSONSchema(definition.input, { io: "input" }),
    parseInput: (raw) => definition.input.parseAsync(raw),
    run: (input, signal) => definition.run(input as z.output<S>, signal),
  });
}

export const AgentDefinitionSchema = z
  .strictObject({
    model: z.string().min(1),
    successors: z.array(AgentIdSchema).readonly().optional(),
    systemPrompt: z.string().optional(),
    tools: z.array(ToolNameSchema).default([]).readonly(),
  })
  .readonly();
export type AgentDefinition = z.input<typeof AgentDefinitionSchema>;
export type CompletionPort = (
  request: PreparedModel,
  signal: AbortSignal,
  blobs?: BlobResolver,
) => unknown | Promise<unknown>;
export type ExecutionBindings = Readonly<{
  agents: ReadonlyMap<string, AgentDefinition>;
  tools?: ReadonlyMap<string, Tool>;
  complete: CompletionPort;
}>;
/** Connection settings remain in the transport closure, never in the session journal. */
export function completionTransport(options: {
  baseUrl: string;
  apiKey?: string;
  fetch?: typeof fetch;
}): CompletionPort {
  const baseUrl = z.url({ protocol: /^https?$/ }).parse(options.baseUrl);
  const { apiKey, fetch: fetcher } = options;
  return (request, signal) =>
    createChatCompletion({ ...request, baseUrl, apiKey, signal }, fetcher);
}
export function copyRegistries(bindings: Pick<ExecutionBindings, "agents" | "tools">) {
  const agents = new Map(
    [...bindings.agents].map(([id, definition]) => [
      AgentIdSchema.parse(id),
      AgentDefinitionSchema.parse(definition),
    ]),
  );
  const tools = new Map(
    [...(bindings.tools ?? [])].map(([name, tool]) => [
      ToolNameSchema.parse(name),
      Object.freeze({ ...tool, parameters: freeze(structuredClone(tool.parameters)) }),
    ]),
  );
  for (const agent of agents.values())
    for (const successor of agent.successors ?? [])
      if (!agents.has(successor)) throw new Error("Unknown successor agent");
  for (const agent of agents.values())
    for (const name of agent.tools) if (!tools.has(name)) throw new Error(`Unknown tool: ${name}`);
  return { agents, tools };
}
