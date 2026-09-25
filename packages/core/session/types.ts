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
import { CompletionUsageSchema } from "../providers/usage.ts";
import { AppendIdSchema, RevisionSchema } from "./persistence.ts";

/**
 * Standing session instructions (`systemInputs`), in order. Each step's prompt carries them as
 * `system` messages after the agent's `systemPrompt`. "System" here is not a system notice.
 */
export const SystemInputsSchema = z.array(z.string()).readonly();

/** Version of the standing session instructions; each `system` record raises it by one. */
export const SystemVersionSchema = z.number().int().nonnegative().brand<"SystemVersion">();

/** One agent in the registry ({@link Configuration}). */
export const AgentDefinitionSchema = z
  .strictObject({
    /** Model name the agent uses when the policy names no `model`; the policy's value wins. */
    model: z.string().min(1),
    /**
     * Agents this agent may hand off to. Omitted means every registered agent, itself included;
     * `[]` offers no handoff.
     */
    successors: z.array(AgentIdSchema).readonly().optional(),
    /** The agent's own system prompt: the first message of each step's prompt. */
    systemPrompt: z.string().optional(),
    /**
     * Registered tools the agent may be offered. The policy's `tools` entry for the agent picks
     * the subset each step advertises.
     */
    tools: z.array(ToolNameSchema).default([]).readonly(),
  })
  .readonly();

/** Schema of {@link Configuration}. */
export const ConfigurationSchema = z
  .strictObject({
    /** Registered agents by ID. Successors and tools must name registered agents and tools. */
    agents: z.array(z.tuple([AgentIdSchema, AgentDefinitionSchema])).readonly(),
    /** Registered tools by name with their parameters' JSON Schema. Tool code is not journaled. */
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

/**
 * The registry: the tool and agent definitions a session runs with. The creation record holds the
 * initial registry and a `configuration` record adopts a live one on reopen. Not the glossary's
 * configuration (the user-selectable settings), which is the policy ({@link PolicySchema}).
 */
export type Configuration = z.infer<typeof ConfigurationSchema>;

/** Schema of {@link Seed}. */
export const SeedSchema = z
  .strictObject({
    /** Session this seed creates; every record of its journal carries it. */
    sessionId: SessionIdSchema,
    /**
     * How the session came to exist. `root` is a new session. `fork` and `compaction` are child
     * sessions (not child operations) of `parent`, branched when the parent's next turn number
     * was `sequence`.
     */
    origin: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("root") }),
      z.strictObject({
        kind: z.enum(["fork", "compaction"]),
        parent: SessionIdSchema,
        sequence: z.number().int().positive(),
      }),
    ]),
    /**
     * Messages placed before the turn log in the history: the parent's context for a fork, the
     * caller's replacement context for a compaction.
     */
    context: MessagesSchema.transform(parseSessionContext),
    /** Committed turn records inherited from the parent. Empty for root and compaction sessions. */
    log: z.array(TurnRecordSchema).readonly(),
    /** Agent the session's next turn starts with. */
    agent: AgentIdSchema,
    /** Steps each turn may use (the policy's `steps`). Staging requires the two to match. */
    allowance: StepsSchema,
    /**
     * Number of the next turn, `log.length + 1`; its turn ID is `<sessionId>/turn/<sequence>`. A
     * fork keeps its parent's sequence; root and compaction sessions start at 1.
     */
    sequence: z.number().int().positive(),
    /** Standing session instructions in force at creation. */
    systemInputs: SystemInputsSchema,
    /** Version of `systemInputs` at creation. */
    systemVersion: SystemVersionSchema,
    /** Registry the session starts with. */
    configuration: ConfigurationSchema,
    /** Configuration (user-selectable settings) the session starts with. */
    policy: PolicySchema,
    /**
     * Provider continuation payloads (such as thinking signatures) a fork inherits for assistant
     * messages in its context or log. Only a fork carries them; compaction drops them.
     */
    continuations: z.array(ContinuationSchema).readonly().optional(),
  })
  .readonly();

/**
 * Initial state of a session, committed as the `created` record: the first record of every
 * journal, and the only one of its kind. Staging a seed (`stageCreation`) checks the
 * commit-time rules; load takes the committed seed as written.
 */
export type Seed = z.infer<typeof SeedSchema>;

/**
 * The captured prompt of one step: the completion request prompt projection produced, committed
 * in the `prepared` child event before the completion is dispatched. Staging requires it to equal
 * today's projection of the folded session; load takes it as written.
 */
export const PromptViewSchema = z
  .strictObject({
    ...ProviderSettingsSchema.unwrap().partial().shape,
    /** Agents the step may hand off to; present when the policy names a provider. */
    successors: z.array(AgentIdSchema).readonly().optional(),
    /** Application model name, not the provider's wire model ID. */
    model: z.string().min(1),
    messages: z.array(ChatMessageSchema).readonly(),
    /** Provider continuation payloads sent with the step. */
    continuations: z.array(ContinuationSchema).readonly().optional(),
    /** Tools advertised to the model: the policy's tools for the active agent, in its order. */
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

/**
 * Raw outcome of one tool call, as a `tool` record stores it: `succeeded` with the result text,
 * `failed` with a structured failure, or `cancelled`. The policy's `toolFailure` decides at use
 * whether a failure reaches the model as an error message; the stored result stays raw.
 */
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

/** Schema of {@link WireEvent}. */
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
        usage: CompletionUsageSchema.optional(),
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

/**
 * The journaled form of a conversation event, stored in `event` records. It holds no connection
 * settings or credentials.
 *
 * - `user`: a prompt. It starts a turn when the session is idle; during a turn it is a barge-in,
 *   where the policy and turn phase allow one.
 * - `abort`: cancel the active turn.
 * - `request`: branch into child session `sessionId` (a fork or compaction, not a child
 *   operation). The branch is taken at the next idle boundary.
 * - `child`: a child operation of turn `turnId` (not a child session) settled. `prepared`: prompt
 *   projection captured the step's prompt ({@link PromptViewSchema}). `model_settled`: a settled
 *   step, whose model output is now committed. `handoff_prepared`: the messages for the successor
 *   agent. `permission_settled`: permission decisions for the tool batch. `batch_settled`: the
 *   tool batch's outcome. `failed`: the operation failed without its normal result, for example
 *   because it could not be dispatched.
 */
export type WireEvent = z.infer<typeof WireEventSchema>;

/** Schema of {@link JournalBody}. */
export const BodySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("created"), seed: SeedSchema }),
  z.strictObject({ kind: z.literal("policy"), patch: PolicyPatchSchema, policy: PolicySchema }),
  z.strictObject({
    kind: z.literal("configuration"),
    /** Live registry adopted from this record on. */
    configuration: ConfigurationSchema,
    /** Policy reconciled to the live registry and bindings (version + 1); absent when unchanged. */
    policy: PolicySchema.optional(),
    /** Agent the idle conversation switches to, when its current agent is no longer registered. */
    agent: AgentIdSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("queued"),
    attachments: z.array(BlobRefSchema).min(1).readonly().optional(),
    /** Queued-input ID; the `dequeued` or `input_cancelled` record names it. */
    inputId: ActorIdSchema,
    text: z.string(),
    /** Policy version in force when the input was queued. */
    policyVersion: PolicyVersionSchema,
  }),
  z.strictObject({
    kind: z.literal("dequeued"),
    /** Queued-input ID of the queued input that starts this turn. */
    inputId: ActorIdSchema,
    /** Policy version the turn starts under. */
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
    /** Version of `systemInputs` the event was staged against. */
    systemVersion: SystemVersionSchema,
    /** Policy version the event was staged against; `stage` fills it in. */
    policyVersion: PolicyVersionSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("system"),
    /** The complete replacement list of standing session instructions. */
    inputs: SystemInputsSchema,
    /** New `systemInputs` version: the previous one plus one. */
    version: SystemVersionSchema,
  }),
  z.strictObject({
    kind: z.literal("tool"),
    turnId: ActorIdSchema,
    /** The tool batch the call belongs to (a tool batch, not a journal append). */
    batchId: ActorIdSchema,
    callId: ToolCallIdSchema,
    /** Raw outcome; see {@link StringResultSchema}. */
    result: StringResultSchema,
  }),
  z.strictObject({ kind: z.literal("terminal"), turnId: ActorIdSchema, record: TurnRecordSchema }),
  z.strictObject({ kind: z.literal("recovery"), turnId: ActorIdSchema, reason: z.string().min(1) }),
]);

/**
 * The content of one journal record, discriminated by `kind`:
 *
 * - `created`: the session's {@link Seed}; the first record, and only there.
 * - `policy`: a configuration change (the user-selectable settings): the caller's `patch` and the
 *   resulting `policy`. Staged only at an idle boundary with no queued inputs; applies from the
 *   next turn.
 * - `configuration`: registry adoption on reopen, committed before the first new work.
 * - `queued`: a queued input, held until the current turn ends (policy `queue-user`, or
 *   `abort-tools-on-user` during tools or permission waiting).
 * - `dequeued`: the first queued input starts a turn at an idle boundary.
 * - `input_cancelled`: a queued input dropped without starting a turn; recovery cancels them all.
 * - `event`: a conversation event ({@link WireEvent}).
 * - `system`: a replacement of the standing session instructions (not a system notice).
 * - `tool`: one tool call's raw result, committed before its tool batch settles.
 * - `terminal`: a turn's log entry, committed in the same append as the record that ended the
 *   turn. Staging derives it; callers never submit it.
 * - `recovery`: closes a turn that process exit interrupted, with an `interrupted` failure, when
 *   the session is reopened. External effects are not repeated.
 *
 * Staging checks the commit-time rules for each kind; load takes every record as written and
 * checks only journal integrity (`JournalIntegrityRule` in session-log.ts).
 */
export type JournalBody = z.infer<typeof BodySchema>;

/** Schema of {@link JournalRecord}. */
export const JournalRecordSchema = z
  .strictObject({
    /** Record format. This build reads and writes only version 1. */
    version: z.literal(1),
    sessionId: SessionIdSchema,
    /** Position in the session's journal: 1 for the creation record, then one more per record. */
    revision: RevisionSchema,
    /** `<appendId>/<index in its append>`. */
    entryId: z.string().min(1),
    /** Stable ID of the journal append (not a tool batch) that committed the record. */
    appendId: AppendIdSchema,
    body: BodySchema,
  })
  .readonly();

/**
 * One committed journal record: an envelope naming its session, revision and append around a
 * {@link JournalBody}.
 */
export type JournalRecord = z.infer<typeof JournalRecordSchema>;

/**
 * What `stage` in session-log.ts accepts: any journal body except `terminal`, which staging
 * derives. A `policy` change carries only the patch; staging computes the resulting policy.
 */
export type SessionInput =
  | Exclude<JournalBody, { kind: "terminal" | "policy" }>
  | Readonly<{ kind: "policy"; patch: z.input<typeof PolicyPatchSchema> }>;
