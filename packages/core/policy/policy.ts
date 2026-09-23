import { z } from "zod";

import { ChatMessageSchema, type ChatMessage } from "../agent/agent.ts";
import {
  parseSessionContext,
  projectConversationPrompt,
  type PromptInput,
} from "../agent/prompt.ts";
import { StepsSchema, ToolNameSchema, type AgentMessage, type Result } from "../agent/types.ts";
import { freeze } from "../fsm/fsm.ts";
import { ProviderSettingsSchema } from "../providers/types.ts";

export const PolicyVersionSchema = z.number().int().nonnegative().brand<"PolicyVersion">();
const PolicyObjectSchema = z.strictObject({
  id: z.string().regex(/^.+@\d+$/),
  version: PolicyVersionSchema,
  ...ProviderSettingsSchema.unwrap().partial().shape,
  model: z.string().min(1).optional(),
  steps: StepsSchema,
  admission: z.enum(["reject-during-tools", "abort-tools-on-user", "queue-user"]),
  bargeIn: z.boolean(),
  toolFailure: z.enum(["fail-turn", "return-error-and-continue"]),
  project: z.string().regex(/^.+@\d+$/),
  handoff: z.string().regex(/^.+@\d+$/),
  tools: z.record(z.string().min(1), z.array(ToolNameSchema).readonly()).readonly(),
});
export const PolicySchema = PolicyObjectSchema.refine(
  (policy) => policy.admission !== "queue-user" || !policy.bargeIn,
  "queue-user requires bargeIn=false",
).readonly();
export type Policy = z.infer<typeof PolicySchema>;
export const PolicyPatchSchema = PolicyObjectSchema.omit({ version: true })
  .partial()
  .strict()
  .refine(
    (patch) => Object.values(patch).every((value) => value !== undefined),
    "Omit undefined policy fields",
  );
export type PolicyPatch = z.input<typeof PolicyPatchSchema>;
export type Capabilities = Readonly<{
  agents: readonly (readonly [string, Readonly<{ tools: readonly string[] }>])[];
}>;
export type Projection = (input: PromptInput) => readonly ChatMessage[];
export type HandoffProjection = (
  input: PromptInput & { from: string; to: string },
) => readonly AgentMessage[];
export type PolicyPack = Readonly<
  Pick<Policy, "admission" | "bargeIn" | "toolFailure" | "project" | "handoff">
>;
export type PolicyResolvers = Readonly<{
  providerIds?: ReadonlySet<string>;
  packs?: ReadonlyMap<string, PolicyPack>;
  projections: ReadonlyMap<string, Projection>;
  handoffs: ReadonlyMap<string, HandoffProjection>;
}>;
const history: Projection = (input) =>
  projectConversationPrompt({ ...input, agent: { ...input.agent, systemPrompt: undefined } });
const defaultPack: PolicyPack = {
  admission: "reject-during-tools",
  bargeIn: true,
  toolFailure: "fail-turn",
  project: "history@1",
  handoff: "handoff-slim@1",
};
const packs = new Map<string, PolicyPack>([
  ["default@1", defaultPack],
  ["queued@1", { ...defaultPack, admission: "queue-user", bargeIn: false }],
  ["strict@1", { ...defaultPack, bargeIn: false }],
  ["tolerant@1", { ...defaultPack, toolFailure: "return-error-and-continue" }],
]);
export const builtinResolvers: PolicyResolvers = {
  packs,
  projections: new Map([
    ["history@1", history],
    [
      "context-only@1",
      (input) => history({ ...input, log: [], turn: { ...input.turn, view: { kind: "history" } } }),
    ],
  ]),
  handoffs: new Map([
    [
      "handoff-slim@1",
      (input) =>
        [
          input.turn.messages.findLast((message) => message.role === "user"),
          input.turn.messages.at(-1),
        ].filter((message): message is AgentMessage => message !== undefined),
    ],
    [
      "handoff-history@1",
      (input) => [
        ...(input.context ?? []),
        ...input.log.flatMap((record) => record.messages),
        ...input.turn.messages,
      ],
    ],
  ]),
};
export function copyResolvers(resolvers: PolicyResolvers = builtinResolvers): PolicyResolvers {
  return {
    providerIds: resolvers.providerIds ? new Set(resolvers.providerIds) : undefined,
    projections: new Map(resolvers.projections),
    handoffs: new Map(resolvers.handoffs),
    packs: new Map(
      [...(resolvers.packs ?? packs)].map(([id, pack]) => [id, freeze(structuredClone(pack))]),
    ),
  };
}
export function defaultPolicy(capabilities: Capabilities, steps: number): Policy {
  return PolicySchema.parse({
    id: "default@1",
    version: 0,
    steps,
    admission: "reject-during-tools",
    bargeIn: true,
    toolFailure: "fail-turn",
    project: "history@1",
    handoff: "handoff-slim@1",
    tools: Object.fromEntries(capabilities.agents.map(([id, agent]) => [id, agent.tools])),
  });
}
export function validatePolicy(
  raw: unknown,
  capabilities: Capabilities,
  resolvers: PolicyResolvers = builtinResolvers,
): Policy {
  const policy = PolicySchema.parse(raw);
  if (policy.provider && !resolvers.providerIds?.has(policy.provider))
    throw new Error("Missing versioned provider binding");
  if (
    !policy.provider &&
    [policy.model, policy.thinking, policy.stream, policy.maxOutputTokens].some(
      (value) => value !== undefined,
    )
  )
    throw new Error("Provider settings require a provider id");
  if (
    policy.provider &&
    capabilities.agents.some(([, agent]) => agent.tools.includes("handoff_to"))
  )
    throw new Error("Reserved handoff tool name");
  const agents = new Map(capabilities.agents);
  if (
    Object.keys(policy.tools).length !== agents.size ||
    Object.entries(policy.tools).some(
      ([id, tools]) =>
        !agents.has(id) ||
        new Set(tools).size !== tools.length ||
        tools.some((name) => !agents.get(id)!.tools.includes(name)),
    )
  )
    throw new Error("Policy tool permissions exceed host capabilities");
  if (!(resolvers.packs ?? packs).has(policy.id)) throw new Error("Missing versioned policy pack");
  if (!resolvers.projections.has(policy.project) || !resolvers.handoffs.has(policy.handoff))
    throw new Error("Missing versioned policy resolver");
  return freeze(policy);
}
export function patchPolicy(
  current: Policy,
  raw: PolicyPatch,
  capabilities: Capabilities,
  resolvers: PolicyResolvers = builtinResolvers,
): Policy {
  const patch = PolicyPatchSchema.parse(raw);
  const pack =
    patch.id && patch.id !== current.id ? (resolvers.packs ?? packs).get(patch.id) : undefined;
  return validatePolicy(
    {
      ...current,
      ...pack,
      ...patch,
      tools: { ...current.tools, ...patch.tools },
      version: current.version + 1,
    },
    capabilities,
    resolvers,
  );
}
export function projectPolicy(
  input: PromptInput,
  systemInputs: readonly string[],
  policy: Policy,
  resolvers: PolicyResolvers = builtinResolvers,
) {
  const project = resolvers.projections.get(policy.project);
  if (!project) throw new Error("Missing versioned projection");
  const messages = z
    .array(ChatMessageSchema)
    .parse([
      ...(input.agent.systemPrompt ? [{ role: "system", content: input.agent.systemPrompt }] : []),
      ...systemInputs.map((content) => ({ role: "system", content })),
      ...project(input),
    ]);
  parseSessionContext(
    messages.map((message) => {
      if (message.role === "tool")
        return { role: "tool", text: message.content, callId: message.tool_call_id };
      if (message.role === "assistant" && message.tool_calls)
        return {
          role: "assistant",
          text: message.content,
          calls: message.tool_calls.map((call) => {
            let args: unknown;
            try {
              args = JSON.parse(call.function.arguments);
            } catch {
              throw new Error(`Invalid JSON arguments for projected tool call ${call.id}`);
            }
            return { id: call.id, name: call.function.name, args };
          }),
        };
      return { role: message.role, text: message.content };
    }),
  );
  return freeze(messages);
}
/** Deterministic domain conversion. The raw failed result remains in the journal. */
export function effectiveToolResult(
  result: Result<string>,
  policy?: Pick<Policy, "toolFailure">,
): Result<string> {
  return result.kind === "failed" && policy?.toolFailure === "return-error-and-continue"
    ? { kind: "succeeded", value: JSON.stringify({ error: result.error.message }) }
    : result;
}

export function initialPolicy(
  capabilities: Capabilities,
  steps: number,
  patch: PolicyPatch = {},
  resolvers: PolicyResolvers = builtinResolvers,
): Policy {
  return validatePolicy(
    {
      ...patchPolicy(defaultPolicy(capabilities, steps), patch, capabilities, resolvers),
      version: 0,
    },
    capabilities,
    resolvers,
  );
}
