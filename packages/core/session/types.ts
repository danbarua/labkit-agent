import { z } from "zod";

import { ChatMessageSchema, ChatToolSchema } from "../agent/agent.ts";
import { BlobRefSchema } from "../agent/content.ts";
import { PermissionDecisionsSchema } from "../agent/permissions.ts";
import { parseSessionContext } from "../agent/prompt.ts";
import { ToolResultSchema } from "../agent/tool-batch.ts";
import {
  ActorIdSchema,
  AgentIdSchema,
  CompletionSchema,
  FailureSchema,
  MessagesSchema,
  SessionIdSchema,
  StepsSchema,
  ToolCallIdSchema,
  ToolNameSchema,
  TurnRecordSchema,
} from "../agent/types.ts";
import { PolicyPatchSchema, PolicySchema, PolicyVersionSchema } from "../policy/policy.ts";
import { ContinuationSchema, ProviderSettingsSchema } from "../providers/types.ts";
import { AppendIdSchema, RevisionSchema } from "./persistence.ts";

export const SystemInputsSchema = z.array(z.string()).readonly();

export const SystemVersionSchema = z.number().int().nonnegative().brand<"SystemVersion">();

export const AgentDefinitionSchema = z
  .strictObject({
    model: z.string().min(1),
    successors: z.array(AgentIdSchema).readonly().optional(),
    systemPrompt: z.string().optional(),
    tools: z.array(ToolNameSchema).default([]).readonly(),
  })
  .readonly();

export const ConfigurationSchema = z
  .strictObject({
    agents: z.array(z.tuple([AgentIdSchema, AgentDefinitionSchema])).readonly(),
    tools: z.array(z.tuple([ToolNameSchema, z.record(z.string(), z.json())])).readonly(),
  })
  .refine((configuration) => {
    const agents = new Set(configuration.agents.map(([id]) => id));
    const tools = new Set(configuration.tools.map(([name]) => name));
    return (
      agents.size === configuration.agents.length &&
      tools.size === configuration.tools.length &&
      configuration.agents.every(
        ([, agent]) =>
          new Set(agent.tools).size === agent.tools.length &&
          (agent.successors ?? []).every((id) => agents.has(id)) &&
          agent.tools.every((name) => tools.has(name)),
      )
    );
  }, "Configuration identities must be unique and tool references must exist")
  .readonly();

export type Configuration = z.infer<typeof ConfigurationSchema>;

export const SeedSchema = z
  .strictObject({
    sessionId: SessionIdSchema,
    origin: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("root") }),
      z.strictObject({
        kind: z.enum(["fork", "compaction"]),
        parent: SessionIdSchema,
        sequence: z.number().int().positive(),
      }),
    ]),
    context: MessagesSchema.transform(parseSessionContext),
    log: z.array(TurnRecordSchema).readonly(),
    agent: AgentIdSchema,
    allowance: StepsSchema,
    sequence: z.number().int().positive(),
    systemInputs: SystemInputsSchema,
    systemVersion: SystemVersionSchema,
    configuration: ConfigurationSchema,
    policy: PolicySchema,
    continuations: z.array(ContinuationSchema).readonly().optional(),
  })
  .readonly();

export type Seed = z.infer<typeof SeedSchema>;

export const PromptViewSchema = z
  .strictObject({
    ...ProviderSettingsSchema.unwrap().partial().shape,
    successors: z.array(AgentIdSchema).readonly().optional(),
    model: z.string().min(1),
    messages: z.array(ChatMessageSchema).readonly(),
    continuations: z.array(ContinuationSchema).readonly().optional(),
    tools: z.array(ChatToolSchema).readonly().optional(),
    temperature: z.number().finite().optional(),
  })
  .readonly();

const child = <K extends string>(kind: K) =>
  z.strictObject({ kind: z.literal(kind), id: ActorIdSchema }).readonly();

const result = <T extends z.ZodType>(value: T) =>
  z
    .discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("succeeded"), value }),
      z.strictObject({ kind: z.literal("failed"), error: FailureSchema }),
      z.strictObject({ kind: z.literal("cancelled") }),
    ])
    .readonly();

export const StringResultSchema = result(z.string());

const BatchOutcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("succeeded"), results: z.array(ToolResultSchema).readonly() }),
  z.strictObject({
    kind: z.literal("failed"),
    results: z.array(ToolResultSchema).readonly(),
    error: FailureSchema,
  }),
  z.strictObject({ kind: z.literal("cancelled"), results: z.array(ToolResultSchema).readonly() }),
]);

export const WireEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("user"),
    text: z.string(),
    attachments: z.array(BlobRefSchema).min(1).readonly().optional(),
  }),
  z.strictObject({ type: z.literal("abort") }),
  z.strictObject({
    type: z.literal("request"),
    request: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("fork"), id: ActorIdSchema, sessionId: SessionIdSchema }),
      z.strictObject({
        kind: z.literal("compact"),
        id: ActorIdSchema,
        sessionId: SessionIdSchema,
        context: MessagesSchema.transform(parseSessionContext),
      }),
    ]),
  }),
  z.strictObject({
    type: z.literal("child"),
    turnId: ActorIdSchema,
    event: z.discriminatedUnion("type", [
      z.strictObject({
        type: z.literal("prepared"),
        child: child("prepare"),
        result: result(PromptViewSchema),
      }),
      z.strictObject({
        type: z.literal("model_settled"),
        continuation: ContinuationSchema.optional(),
        permissionRequired: z.literal(true).optional(),
        child: child("completion"),
        result: result(CompletionSchema.brand<"AdmittedCompletion">()),
      }),
      z.strictObject({
        type: z.literal("handoff_prepared"),
        child: child("handoff"),
        result: result(MessagesSchema),
      }),
      z.strictObject({
        type: z.literal("permission_settled"),
        child: child("permission"),
        result: result(PermissionDecisionsSchema),
      }),
      z.strictObject({
        type: z.literal("batch_settled"),
        child: child("batch"),
        outcome: BatchOutcomeSchema,
      }),
      z.strictObject({
        type: z.literal("failed"),
        child: z.discriminatedUnion("kind", [
          child("prepare"),
          child("completion"),
          child("handoff"),
          child("batch"),
          child("tool"),
          child("permission"),
        ]),
        error: FailureSchema,
      }),
    ]),
  }),
]);

export type WireEvent = z.infer<typeof WireEventSchema>;

export const BodySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("created"), seed: SeedSchema }),
  z.strictObject({ kind: z.literal("policy"), patch: PolicyPatchSchema, policy: PolicySchema }),
  z.strictObject({
    kind: z.literal("queued"),
    attachments: z.array(BlobRefSchema).min(1).readonly().optional(),
    inputId: ActorIdSchema,
    text: z.string(),
    policyVersion: PolicyVersionSchema,
  }),
  z.strictObject({
    kind: z.literal("dequeued"),
    inputId: ActorIdSchema,
    policyVersion: PolicyVersionSchema,
  }),
  z.strictObject({
    kind: z.literal("input_cancelled"),
    inputId: ActorIdSchema,
    reason: z.string(),
  }),
  z.strictObject({
    kind: z.literal("event"),
    event: WireEventSchema,
    systemVersion: SystemVersionSchema,
    policyVersion: PolicyVersionSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("system"),
    inputs: SystemInputsSchema,
    version: SystemVersionSchema,
  }),
  z.strictObject({
    kind: z.literal("tool"),
    turnId: ActorIdSchema,
    batchId: ActorIdSchema,
    callId: ToolCallIdSchema,
    result: StringResultSchema,
  }),
  z.strictObject({ kind: z.literal("terminal"), turnId: ActorIdSchema, record: TurnRecordSchema }),
  z.strictObject({ kind: z.literal("recovery"), turnId: ActorIdSchema, reason: z.string().min(1) }),
]);

export type JournalBody = z.infer<typeof BodySchema>;

export const JournalRecordSchema = z
  .strictObject({
    version: z.literal(1),
    sessionId: SessionIdSchema,
    revision: RevisionSchema,
    entryId: z.string().min(1),
    appendId: AppendIdSchema,
    body: BodySchema,
  })
  .readonly();

export type JournalRecord = z.infer<typeof JournalRecordSchema>;

export type SessionInput =
  | Exclude<JournalBody, { kind: "terminal" | "policy" }>
  | Readonly<{ kind: "policy"; patch: z.input<typeof PolicyPatchSchema> }>;
