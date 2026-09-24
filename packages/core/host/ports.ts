import { isAbsolute } from "node:path";

import { z } from "zod";

import { createChatCompletion, type PreparedModel } from "../agent/agent.ts";
import type { BlobResolver } from "../agent/content.ts";
import { AgentIdSchema, ToolNameSchema } from "../agent/types.ts";
import { freeze } from "../fsm/fsm.ts";
import type { StreamDeltaSink } from "../providers/types.ts";

export const ToolKindSchema = z.enum([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
]);
export type ToolKind = z.infer<typeof ToolKindSchema>;
export const ToolLocationSchema = z
  .strictObject({
    path: z.string().refine(isAbsolute, "Tool location must be an absolute path"),
    line: z.number().int().nonnegative().optional(),
  })
  .readonly();
export type ToolLocation = z.infer<typeof ToolLocationSchema>;

/**
 * Existential tool adapter: defineTool retains input-schema inference at the authoring boundary.
 * Successful outputs must be JSON values. The host rejects undefined, Date, class instances,
 * functions and other non-JSON values as correlated failed tool outcomes. Return null for no value.
 * Strings pass through; other JSON values are serialized for model tool messages.
 */
/** Ephemeral display identity for this live invocation; never journaled or an authorization grant. */
export type ToolRunContext = Readonly<{ toolCallId: string }>;
export type Tool = Readonly<{
  description?: string;
  kind?: ToolKind;
  locations?: (input: unknown) => readonly ToolLocation[];
  parameters: Record<string, unknown>;
  parseInput: (raw: unknown) => Promise<unknown>;
  run: (
    input: unknown,
    signal: AbortSignal,
    context?: ToolRunContext,
  ) => unknown | Promise<unknown>;
}>;
export function defineTool<S extends z.ZodType>(definition: {
  input: S;
  description?: string;
  kind?: ToolKind;
  /** Pure display metadata derived from parsed input; no I/O or execution authorization. */
  locations?: (input: z.output<S>) => readonly ToolLocation[];
  run: (
    input: z.output<S>,
    signal: AbortSignal,
    context?: ToolRunContext,
  ) => unknown | Promise<unknown>;
}): Tool {
  const { input, description, locations, run } = definition;
  const kind = ToolKindSchema.parse(definition.kind ?? "other");
  return Object.freeze({
    description,
    kind,
    ...(locations ? { locations: (value: unknown) => locations(value as z.output<S>) } : {}),
    parameters: z.toJSONSchema(input, { io: "input" }),
    parseInput: (raw: unknown) => input.parseAsync(raw),
    run: (value: unknown, signal: AbortSignal, context?: ToolRunContext) =>
      run(value as z.output<S>, signal, context),
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
  onDelta?: StreamDeltaSink,
) => unknown | Promise<unknown>;
export const PermissionResponseSchema = z.strictObject({
  outcome: z.discriminatedUnion("outcome", [
    z.strictObject({
      outcome: z.literal("selected"),
      optionId: z.enum(["allow-once", "reject-once"]),
    }),
    z.strictObject({ outcome: z.literal("cancelled") }),
  ]),
});
export type PermissionRequest = Readonly<{
  sessionId?: string;
  turnId: string;
  requestId: string;
  toolCall: Readonly<{
    toolCallId: string;
    title: string;
    name: string;
    kind: ToolKind;
    status: "pending";
    rawInput: unknown;
    locations?: readonly ToolLocation[];
  }>;
  options: readonly Readonly<{
    optionId: "allow-once" | "reject-once";
    name: string;
    kind: "allow_once" | "reject_once";
  }>[];
}>;
/** Authoritative response, unlike display sinks. Exceptions and malformed responses fail closed. */
export type PermissionPort = (
  request: PermissionRequest,
  signal: AbortSignal,
) => unknown | Promise<unknown>;
export type ExecutionBindings = Readonly<{
  agents: ReadonlyMap<string, AgentDefinition>;
  tools?: ReadonlyMap<string, Tool>;
  complete: CompletionPort;
  requestPermission?: PermissionPort;
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
      Object.freeze({
        ...tool,
        kind: ToolKindSchema.parse(tool.kind ?? "other"),
        parameters: freeze(structuredClone(tool.parameters)),
      }),
    ]),
  );
  for (const agent of agents.values())
    for (const successor of agent.successors ?? [])
      if (!agents.has(successor)) throw new Error("Unknown successor agent");
  for (const agent of agents.values())
    for (const name of agent.tools) if (!tools.has(name)) throw new Error(`Unknown tool: ${name}`);
  return { agents, tools };
}
