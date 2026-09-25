import { z } from "zod";

import { freeze } from "../fsm/fsm.ts";
import { diagnosticError } from "../logging/index.ts";
import { ContentPartsSchema, partsText } from "./content.ts";

export * from "./content.ts";

/** Name of a registered agent. Handoff targets and turn records name agents by this id. */
export const AgentIdSchema = z.string().min(1).brand<"AgentId">();

/** Name of a registered tool, as the model uses it in a tool call. */
export const ToolNameSchema = z.string().min(1).brand<"ToolName">();

/**
 * Id of one tool call, as the model's step assigned it. A tool result message names its call by
 * this id; it is unique within one step's calls.
 */
export const ToolCallIdSchema = z.string().min(1).brand<"ToolCallId">();

/** Identity of a session: a UUID. */
export const SessionIdSchema = z.string().uuid().brand<"SessionId">();

/** Identity of a session: a UUID. */
export type SessionId = z.infer<typeof SessionIdSchema>;

/**
 * Identity of a turn or of an operation the runtime spawned. Turn ids have the form
 * `<sessionId>/turn/<n>`; child operations of a turn use `<turnId>/<generation>`, and a tool
 * call's operation uses `<batchId>/<callId>`.
 */
export const ActorIdSchema = z.string().min(1).brand<"ActorId">();

/**
 * The step that produced an assistant message: its turn id and the `generation` of that step's
 * completion operation. Provider continuations (thinking signatures and similar payloads, not
 * the next step) carry the same owner, so a later request can send each payload back with the
 * assistant message it belongs to.
 */
export const CompletionOwnerSchema = z
  .strictObject({
    turnId: ActorIdSchema,
    generation: z.number().int().nonnegative(),
  })
  .readonly();

/**
 * A number of steps (LLM calls): a policy's per-turn allowance, or what a turn has left of it.
 * Preparation failures use no step; see docs/core-runtime.md.
 */
export const StepsSchema = z.number().int().nonnegative().brand<"Steps">();

/**
 * A step allowance of at least one: the turn may still prepare a step.
 * Parsing zero fails with "A model preparation requires remaining steps".
 */
export const PositiveStepsSchema = StepsSchema.refine(
  (steps) => steps > 0,
  "A model preparation requires remaining steps",
).brand<"PositiveSteps">();

/** Step allowance of at least one. See {@link PositiveStepsSchema}. */
export type PositiveSteps = z.infer<typeof PositiveStepsSchema>;

/** Name of a registered agent. */
export type AgentId = z.infer<typeof AgentIdSchema>;

/** Identity of a turn or of a spawned operation. See {@link ActorIdSchema}. */
export type ActorId = z.infer<typeof ActorIdSchema>;

/** A number of steps (LLM calls): a per-turn allowance or what is left of it. */
export type Steps = z.infer<typeof StepsSchema>;

/** Any JSON value. */
export type Json = z.infer<ReturnType<typeof z.json>>;

/**
 * One tool invocation proposed by a step. `args` is the JSON the model sent; the tool validates
 * it before the call runs (and before permission is asked, when permission is required).
 */
export const ToolCallSchema = z
  .strictObject({ id: ToolCallIdSchema, name: ToolNameSchema, args: z.json() })
  .readonly();

/** The tool batch of one step: at least one call, with unique call ids, in the model's order. */
export const ToolCallsSchema = z
  .tuple([ToolCallSchema])
  .rest(ToolCallSchema)
  .refine(
    (calls) => new Set(calls.map((call) => call.id)).size === calls.length,
    "Tool call IDs must be unique",
  )
  .readonly()
  .brand<"ToolCalls">();

/** One tool invocation proposed by a step. See {@link ToolCallSchema}. */
export type ToolCall = z.infer<typeof ToolCallSchema>;

/** The tool batch of one step: non-empty, unique call ids. See {@link ToolCallsSchema}. */
export type ToolCalls = z.infer<typeof ToolCallsSchema>;

/**
 * Decoded model output of one step. `text` is the narrative the model emitted (possibly empty).
 *
 * - `answer`: no tool calls; the turn ends `completed`.
 * - `tools`: the step proposed a tool batch. The turn asks permission when required, runs the
 *   batch, and prepares the next step with the results.
 * - `handoff`: the step hands the turn to `agent`. The turn continues with that agent once its
 *   handoff packet is prepared.
 */
export const CompletionSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("answer"), text: z.string() }),
    z.strictObject({ kind: z.literal("tools"), text: z.string(), calls: ToolCallsSchema }),
    z.strictObject({ kind: z.literal("handoff"), text: z.string(), agent: AgentIdSchema }),
  ])
  .readonly();

/** Decoded model output of one step. See {@link CompletionSchema}. */
export type Completion = z.infer<typeof CompletionSchema>;

/**
 * One entry of history or of a model request, in the runtime's own shape.
 *
 * - `system`: a message with the `system` chat role (not a system notice).
 * - `user`: user input.
 * - `assistant`: a step's output: narrative text, plus `calls` when it proposed a tool batch.
 * - `tool`: the result of the call named by `callId`, as text.
 *
 * When `parts` is present, `text` must equal the concatenation of its text parts.
 */
export const MessageSchema = z
  .discriminatedUnion("role", [
    z.strictObject({
      role: z.literal("system"),
      text: z.string(),
      parts: ContentPartsSchema.optional(),
    }),
    z.strictObject({
      role: z.literal("user"),
      text: z.string(),
      parts: ContentPartsSchema.optional(),
    }),
    z.strictObject({
      role: z.literal("assistant"),
      text: z.string(),
      /** The tool batch this step proposed. */
      calls: ToolCallsSchema.optional(),
      /** The step that produced this message; set when that step left a provider continuation. */
      owner: CompletionOwnerSchema.optional(),
      parts: ContentPartsSchema.optional(),
    }),
    z.strictObject({ role: z.literal("tool"), text: z.string(), callId: ToolCallIdSchema }),
  ])
  .refine(
    (message) =>
      message.role === "tool" || !message.parts || message.text === partsText(message.parts),
    "Message text must equal its text parts",
  )
  .readonly();

/** One entry of history or of a model request. See {@link MessageSchema}. */
export type AgentMessage = z.infer<typeof MessageSchema>;

/** An ordered message list. Parsing returns a deeply frozen array. */
export const MessagesSchema = z
  .array(MessageSchema)
  .readonly()
  .transform((messages) => freeze(messages));

/**
 * The provider's own terminal stop that made a completion fail: an output `token_limit` or a
 * `refusal`. `reason` is the provider's stop value, verbatim. Partial output is not kept.
 */
export const ProviderStopSchema = z
  .strictObject({
    category: z.enum(["token_limit", "refusal"]),
    reason: z.string().min(1),
  })
  .readonly();

/**
 * Serializable description of why an operation, turn or storage request failed. Branch on
 * `classification`, `operation` and `providerStop`; `message` is for people, not for parsing.
 */
export const FailureSchema = z
  .strictObject({
    /** Human-readable summary. Do not parse it; use `classification`. */
    message: z.string().min(1),
    /**
     * What kind of failure this is:
     * - `execution`: the operation itself threw or rejected.
     * - `invalid_input` / `invalid_output`: a tool's arguments or output failed validation. An
     *   output failure can occur after the tool's external effect.
     * - `permission_refused`: the user rejected a tool call.
     * - `cancelled`: the user cancelled the turn, the tool batch or a permission request.
     * - `timeout`: the operation exceeded its policy deadline; see `timeoutMs`.
     * - `interrupted`: the work was cut off by process exit (closed during recovery) or by the
     *   session stopping.
     * - `persistence`: a journal append or load failed.
     * - `admission`: an input could not be staged as a journal record (input receipt).
     */
    classification: z
      .enum([
        "execution",
        "invalid_input",
        "invalid_output",
        "permission_refused",
        "cancelled",
        "timeout",
        "interrupted",
        "persistence",
        "admission",
      ])
      .optional(),
    /**
     * The operation that failed. `kind` is a turn's child operation (`prepare`, `completion`,
     * `handoff`, `permission`, `batch`, `tool`) or session work: `append` and `load` (journal
     * storage), `admission` (an input receipt) or `branch` (publishing a fork or compaction).
     */
    operation: z
      .strictObject({
        id: z.string(),
        kind: z.enum([
          "prepare",
          "completion",
          "handoff",
          "permission",
          "batch",
          "tool",
          "append",
          "load",
          "admission",
          "branch",
        ]),
        sessionId: z.string().optional(),
        turnId: z.string().optional(),
        toolName: z.string().optional(),
        callId: z.string().optional(),
      })
      .readonly()
      .optional(),
    providerStop: ProviderStopSchema.optional(),
    /** Free-form name of the stage that failed, such as `validate_input`, `append` or `stage`. */
    phase: z.string().optional(),
    /** Structured context added by the layer that reported the failure. */
    details: z.json().optional(),
    /** The deadline that expired, in ms. Present with classification `timeout`. */
    timeoutMs: z.number().positive().optional(),
    /** The original error in serialized diagnostic form, without stack traces. */
    cause: z.json().optional(),
  })
  .readonly();

/** Serializable description of a failure. See {@link FailureSchema}. */
export type Failure = z.infer<typeof FailureSchema>;

/**
 * Converts a thrown value into a {@link Failure}.
 *
 * A plain object that already parses as a Failure is kept as is; `context` only fills the fields
 * it lacks. Any other value, including every `Error`, becomes a Failure whose message is the
 * error's message ("Unknown failure" when it has none). `context` is applied over that, so a
 * `context.message` replaces it. A `providerStop` carried by the error is kept, and `cause` is
 * always the serialized error.
 *
 * @throws ZodError when the combined result is not a valid Failure.
 */
export function failure(error: unknown, context: Partial<Failure> = {}): Failure {
  const existing = FailureSchema.safeParse(error);
  if (!(error instanceof Error) && existing.success)
    return FailureSchema.parse({ ...context, ...existing.data });
  const detail = diagnosticError(error);
  // Stacks depend on scheduling and source layout; runtime diagnostics retain them separately.
  const serializable = JSON.parse(
    JSON.stringify(detail, (key, value) => (key === "stack" ? undefined : value)),
  );
  return FailureSchema.parse({
    message:
      typeof detail.message === "string" ? detail.message || "Unknown failure" : "Unknown failure",
    ...context,
    ...(detail.providerStop === undefined
      ? {}
      : { providerStop: ProviderStopSchema.parse(detail.providerStop) }),
    cause: serializable,
  });
}

/**
 * How a turn ended.
 *
 * - `completed`: the last step answered without tool calls.
 * - `aborted`: the user cancelled the turn, its tool batch or a permission request, or a child
 *   operation was cancelled. `reason` is absent when no failure was recorded.
 * - `exhausted`: the step allowance ran out before the next step.
 * - `failed`: a child operation failed (including work interrupted by process exit and closed
 *   during recovery), or the user refused permission; see `error`.
 */
export const OutcomeSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("completed") }),
    z.strictObject({ kind: z.literal("aborted"), reason: FailureSchema.optional() }),
    z.strictObject({ kind: z.literal("exhausted") }),
    z.strictObject({ kind: z.literal("failed"), error: FailureSchema }),
  ])
  .readonly();

/** How a turn ended. See {@link OutcomeSchema}. */
export type Outcome = z.infer<typeof OutcomeSchema>;

/**
 * A finished turn in history: the agent that held the turn when it ended (after any handoff),
 * every message the turn added, and its outcome.
 */
export const TurnRecordSchema = z
  .strictObject({ agent: AgentIdSchema, messages: MessagesSchema, outcome: OutcomeSchema })
  .readonly();

/** A finished turn in history. See {@link TurnRecordSchema}. */
export type TurnRecord = z.infer<typeof TurnRecordSchema>;

/**
 * Kinds of child operation a turn spawns (child: an operation, not a child session):
 * - `prepare`: prompt projection for the next step;
 * - `completion`: the LLM call of a step;
 * - `handoff`: preparing the handoff packet for the successor agent;
 * - `permission`: asking the user to approve a tool batch;
 * - `batch`: running a tool batch;
 * - `tool`: running one tool call inside a batch.
 */
export type OperationKind = "prepare" | "completion" | "handoff" | "permission" | "batch" | "tool";

/** Identity of one child operation of a turn. Outcomes are matched to the turn by this ref. */
export type Ref<K extends OperationKind> = Readonly<{ kind: K; id: ActorId }>;

/**
 * Creates a frozen {@link Ref}.
 * @throws ZodError when `id` is empty.
 */
export const ref = <K extends OperationKind>(kind: K, id: string): Ref<K> =>
  Object.freeze({ kind, id: ActorIdSchema.parse(id) });

/** A {@link Ref} of any {@link OperationKind}. */
export type ChildRef = { [K in OperationKind]: Ref<K> }[OperationKind];

/**
 * How a child operation settled: `succeeded` with its value, `failed` with a {@link Failure},
 * or `cancelled` before producing a value.
 */
export type Result<T> =
  | Readonly<{ kind: "succeeded"; value: T }>
  | Readonly<{ kind: "failed"; error: Failure }>
  | Readonly<{ kind: "cancelled" }>;

/** Data of the turn in progress, held by every active turn state and passed to child operations. */
export type TurnData = Readonly<{
  /** The turn's identity, `<sessionId>/turn/<n>`. */
  id: ActorId;
  /**
   * Count of child operations spawned so far in this turn (child: an operation, not a child
   * session). Not a step counter: it rises two or three times per step. Each child's id is
   * `<id>/<generation>` at the moment it was spawned.
   */
  generation: number;
  /** The agent currently holding the turn. A handoff replaces it with the successor. */
  agent: AgentId;
  /** Every message this turn has added so far, starting with the user prompt. */
  messages: readonly AgentMessage[];
  /**
   * What the default prompt projection sends to the model. `history`: session context, finished
   * turns and this turn's messages. `handoff`: only the handoff packet prepared for the successor
   * agent, plus the messages added after it.
   */
  view:
    | Readonly<{ kind: "history" }>
    | Readonly<{ kind: "handoff"; messages: readonly AgentMessage[] }>;
  /**
   * Steps the turn has left. One is used when a step's preparation succeeds, before its LLM
   * call; at zero the next step is not prepared and the turn ends `exhausted`.
   */
  steps: Steps;
}>;

/**
 * Returns `turn` with `message` added to its messages, and also to the handoff packet when the
 * turn's view is `handoff`, so the successor agent sees it in its next step.
 */
export function appendMessage(turn: TurnData, message: AgentMessage): TurnData {
  return {
    ...turn,
    messages: [...turn.messages, message],
    view:
      turn.view.kind === "handoff"
        ? { kind: "handoff", messages: [...turn.view.messages, message] }
        : turn.view,
  };
}

/**
 * Input to the in-memory `/agent` runtime.
 *
 * - `user`: user text. With no active turn it starts one. While a step is being prepared or
 *   awaited, or a handoff is being prepared, it barges in: the live child operation is cancelled
 *   and the step is prepared again with the text appended. While permission or tools are
 *   pending it is refused with an error.
 * - `abort`: ends the active turn as `aborted`. During a tool batch it cancels the batch and
 *   keeps the results that already arrived. With no active turn it records an empty aborted turn.
 */
export const UserEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("user"), text: z.string() }),
  z.strictObject({ type: z.literal("abort") }),
]);

/** Input to the in-memory `/agent` runtime. See {@link UserEventSchema}. */
export type UserEvent = z.infer<typeof UserEventSchema>;
