import { isAbsolute } from "node:path";

import { z } from "zod";

import { createChatCompletion, type PreparedModel } from "../agent/agent.ts";
import type { BlobResolver } from "../agent/content.ts";
import { AgentIdSchema, ToolNameSchema, type CompletionSchema } from "../agent/types.ts";
import { freeze } from "../fsm/fsm.ts";
import type { StreamDeltaSink } from "../providers/types.ts";
import type { CompletionUsage } from "../providers/usage.ts";

/**
 * Display category of a tool (the ACP tool-call kinds). Adapters use it to pick a card or icon.
 * It grants no authority and does not affect permission or execution.
 */
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

/** Display category of a tool; see {@link ToolKindSchema}. */
export type ToolKind = z.infer<typeof ToolKindSchema>;

/**
 * A file a tool call reads or changes, shown to the user (for example to follow along in an
 * editor). Display metadata only; it is not a sandbox or an access rule. `path` must be absolute.
 */
export const ToolLocationSchema = z
  .strictObject({
    path: z.string().refine(isAbsolute, "Tool location must be an absolute path"),
    line: z.number().int().nonnegative().optional(),
  })
  .readonly();

/** A file a tool call reads or changes, for display; see {@link ToolLocationSchema}. */
export type ToolLocation = z.infer<typeof ToolLocationSchema>;

/**
 * Identity of one live tool invocation, passed to {@link Tool.run}.
 * Ephemeral display identity for this live invocation; never journaled or an authorization grant.
 */
export type ToolRunContext = Readonly<{
  /**
   * Unique operation ID of this call, `${batchId}/${callId}`. Matches the permission request's
   * `toolCall.toolCallId` and the tool notifications.
   */
  toolCallId: string;
  sessionId?: string;
  turnId?: string;
  /** The tool batch (all calls proposed by one step) this call belongs to. */
  batchId?: string;
  /** The provider's call ID, unique only within its tool batch. */
  callId?: string;
}>;

/**
 * Existential tool adapter: defineTool retains input-schema inference at the authoring boundary.
 * Successful outputs must be JSON values. The host rejects undefined, Date, class instances,
 * functions and other non-JSON values as correlated failed tool outcomes. Return null for no value.
 * Strings pass through; other JSON values are serialized for model tool messages.
 */
export type Tool = Readonly<{
  /** Sent to the model together with {@link Tool.parameters}. */
  description?: string;
  kind?: ToolKind;
  /**
   * Pure display metadata derived from the parsed input. May run before permission is granted.
   * A throw or invalid location is logged and ignored.
   */
  locations?: (input: unknown) => readonly ToolLocation[];
  /** JSON Schema for the tool's arguments, advertised to the model. */
  parameters: Record<string, unknown>;
  /**
   * Validates the model's raw arguments. Runs before permission is requested and before `run`.
   * A rejection is an `invalid_input` failure for this call; `run` is not called.
   */
  parseInput: (raw: unknown) => Promise<unknown>;
  /**
   * Performs the tool's effect with the parsed input. The signal aborts on cancellation or when the
   * configuration's tool deadline (`toolTimeoutMs`) expires. A tool that ignores it may still
   * change the outside world, but its late result is discarded. Throwing or rejecting fails this
   * call. `context` is absent when the tool is called directly, outside the host.
   */
  run: (
    input: unknown,
    signal: AbortSignal,
    context?: ToolRunContext,
  ) => unknown | Promise<unknown>;
}>;

/**
 * Builds a {@link Tool} from a Zod input schema.
 * `parameters` is the schema's JSON Schema (input side), `parseInput` validates with the schema,
 * and `run` and `locations` receive its parsed output type. `kind` defaults to `"other"`.
 *
 * @throws When `kind` is not a {@link ToolKind}.
 */
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

/**
 * An agent in a session's registry: its default model, instructions, the tools it may call and
 * the agents it may hand off to.
 */
export const AgentDefinitionSchema = z
  .strictObject({
    /** Model name used when the configuration selects none. */
    model: z.string().min(1),
    /**
     * Agents this agent may hand off to. Omitted means every registered agent, including itself;
     * `[]` disables handoff.
     */
    successors: z.array(AgentIdSchema).readonly().optional(),
    /**
     * Instructions for this agent, placed as a `system` role message ahead of the projected prompt
     * (not a system notice).
     */
    systemPrompt: z.string().optional(),
    /** Names of registered tools this agent may call. */
    tools: z.array(ToolNameSchema).default([]).readonly(),
  })
  .readonly();

/** Input shape of {@link AgentDefinitionSchema}; `tools` may be omitted. */
export type AgentDefinition = z.input<typeof AgentDefinitionSchema>;

/**
 * What a {@link CompletionPort} returns for one step. The host validates it as untrusted input
 * before the turn can use it.
 */
export type CompletionPortResponse = Readonly<{
  /**
   * The model's answer, tool calls or handoff. Tool names, handoff targets and call IDs are checked
   * against the agent.
   */
  completion: z.input<typeof CompletionSchema>;
  /**
   * Provider continuation data (for example thinking signatures) to replay with this assistant
   * message in later requests to the same provider. Must be JSON, at most 64 KiB. It is stored
   * before the step succeeds; a storage failure fails the step.
   */
  continuationPayload?: unknown;
  /**
   * Accounting reported by the provider for this response; not cumulative, not current context
   * size.
   */
  usage?: CompletionUsage;
}>;

/**
 * Performs one step: sends a prepared completion request to a model and returns its response.
 * Should return a {@link CompletionPortResponse}; a bare completion without the wrapper is also
 * accepted. The host validates the result before admitting it, and a throw or rejection fails the
 * step. A result that arrives after `signal` aborts is discarded.
 *
 * @param blobs - Resolver for attachments and continuations, scoped to this operation. Do not
 *   retain it.
 * @param onDelta - Display-only stream sink. Partial output never counts as the response.
 * @param correlation - Identifies the operation for transport capture. `generation` is the turn's
 *   operation counter, not a step number.
 */
export type CompletionPort = (
  request: PreparedModel,
  signal: AbortSignal,
  blobs?: BlobResolver,
  onDelta?: StreamDeltaSink,
  correlation?: Readonly<{
    sessionId?: string;
    turnId?: string;
    childId?: string;
    generation?: number;
  }>,
) => unknown | Promise<unknown>;

/**
 * The answer a {@link PermissionPort} must return: one of the offered option IDs, or `cancelled`.
 * Anything else fails closed.
 */
export const PermissionResponseSchema = z.strictObject({
  outcome: z.discriminatedUnion("outcome", [
    z.strictObject({
      outcome: z.literal("selected"),
      optionId: z.enum(["allow-once", "allow-session", "reject-once"]),
    }),
    z.strictObject({ outcome: z.literal("cancelled") }),
  ]),
});

/**
 * One approval question: may this tool call run? The host asks once per call, in call order, after
 * the call's input has validated.
 */
export type PermissionRequest = Readonly<{
  sessionId?: string;
  turnId: string;
  /** `${permissionOperationId}/${callId}`; unique per question. */
  requestId: string;
  /**
   * Display data for the call. `toolCallId` matches {@link ToolRunContext.toolCallId} and tool
   * notifications.
   */
  toolCall: Readonly<{
    toolCallId: string;
    title: string;
    name: string;
    kind: ToolKind;
    status: "pending";
    rawInput: unknown;
    locations?: readonly ToolLocation[];
  }>;
  /**
   * Always the three choices `allow-once`, `allow-session` (this tool, any arguments, until the
   * host closes or its remembered grants are reset) and `reject-once`.
   */
  options: readonly Readonly<{
    optionId: "allow-once" | "allow-session" | "reject-once";
    name: string;
    kind: "allow_once" | "allow_always" | "reject_once";
  }>[];
}>;
/**
 * Asks the user whether a tool call may run. Used only when the configuration's permissions are
 * `ask`; tools with a remembered `allow-session` grant are not asked again.
 * Authoritative response, unlike display sinks. Exceptions and malformed responses fail closed.
 * Every call with valid input must be allowed before the tool batch runs; asking stops at the first
 * call that is not allowed. `signal` aborts when the turn cancels, and a late answer cannot start a
 * tool.
 */
export type PermissionPort = (
  request: PermissionRequest,
  signal: AbortSignal,
) => unknown | Promise<unknown>;

/** The external resources a host executes with. Kept out of snapshots and the journal. */
export type ExecutionBindings = Readonly<{
  /** Agent registry, keyed by agent ID. */
  agents: ReadonlyMap<string, AgentDefinition>;
  /** Tool registry, keyed by tool name. */
  tools?: ReadonlyMap<string, Tool>;
  complete: CompletionPort;
  /** Required when permissions are `ask`; without it every permission request fails. */
  requestPermission?: PermissionPort;
}>;
/**
 * A {@link CompletionPort} that posts OpenAI chat-completions requests to `baseUrl`.
 * Connection settings remain in the transport closure, never in the session journal.
 * It ignores `blobs` and `onDelta` and returns a bare completion, without continuation or usage.
 * Prefer a versioned provider profile binding for new environments.
 *
 * @throws When `baseUrl` is not an http(s) URL.
 */
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

/**
 * Validates and copies the agent and tool registries of `bindings`. Tool parameter schemas are
 * cloned and frozen, and a missing tool `kind` becomes `"other"`.
 *
 * @throws When an agent ID, tool name or agent definition is invalid, or an agent names an
 *   unregistered successor or tool.
 */
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
