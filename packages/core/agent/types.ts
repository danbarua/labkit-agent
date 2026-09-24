import { z } from "zod";

import { freeze } from "../fsm/fsm.ts";
import { diagnosticError } from "../logging/index.ts";
import { ContentPartsSchema, partsText } from "./content.ts";

export * from "./content.ts";

export const AgentIdSchema = z.string().min(1).brand<"AgentId">();

export const ToolNameSchema = z.string().min(1).brand<"ToolName">();

export const ToolCallIdSchema = z.string().min(1).brand<"ToolCallId">();

export const SessionIdSchema = z.string().uuid().brand<"SessionId">();

export type SessionId = z.infer<typeof SessionIdSchema>;

export const ActorIdSchema = z.string().min(1).brand<"ActorId">();

export const CompletionOwnerSchema = z
  .strictObject({
    turnId: ActorIdSchema,
    generation: z.number().int().nonnegative(),
  })
  .readonly();

export const StepsSchema = z.number().int().nonnegative().brand<"Steps">();

export const PositiveStepsSchema = StepsSchema.refine(
  (steps) => steps > 0,
  "A model preparation requires remaining steps",
).brand<"PositiveSteps">();

export type PositiveSteps = z.infer<typeof PositiveStepsSchema>;

export type AgentId = z.infer<typeof AgentIdSchema>;

export type ActorId = z.infer<typeof ActorIdSchema>;

export type Steps = z.infer<typeof StepsSchema>;

export type Json = z.infer<ReturnType<typeof z.json>>;

export const ToolCallSchema = z
  .strictObject({ id: ToolCallIdSchema, name: ToolNameSchema, args: z.json() })
  .readonly();

export const ToolCallsSchema = z
  .tuple([ToolCallSchema])
  .rest(ToolCallSchema)
  .refine(
    (calls) => new Set(calls.map((call) => call.id)).size === calls.length,
    "Tool call IDs must be unique",
  )
  .readonly()
  .brand<"ToolCalls">();

export type ToolCall = z.infer<typeof ToolCallSchema>;

export type ToolCalls = z.infer<typeof ToolCallsSchema>;

export const CompletionSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("answer"), text: z.string() }),
    z.strictObject({ kind: z.literal("tools"), text: z.string(), calls: ToolCallsSchema }),
    z.strictObject({ kind: z.literal("handoff"), text: z.string(), agent: AgentIdSchema }),
  ])
  .readonly();

export type Completion = z.infer<typeof CompletionSchema>;

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
      calls: ToolCallsSchema.optional(),
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

export type AgentMessage = z.infer<typeof MessageSchema>;

export const MessagesSchema = z
  .array(MessageSchema)
  .readonly()
  .transform((messages) => freeze(messages));

export const FailureSchema = z
  .strictObject({
    message: z.string().min(1),
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
    phase: z.string().optional(),
    details: z.json().optional(),
    timeoutMs: z.number().positive().optional(),
    cause: z.json().optional(),
  })
  .readonly();

export type Failure = z.infer<typeof FailureSchema>;

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
    cause: serializable,
  });
}

export const OutcomeSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("completed") }),
    z.strictObject({ kind: z.literal("aborted"), reason: FailureSchema.optional() }),
    z.strictObject({ kind: z.literal("exhausted") }),
    z.strictObject({ kind: z.literal("failed"), error: FailureSchema }),
  ])
  .readonly();

export type Outcome = z.infer<typeof OutcomeSchema>;

export const TurnRecordSchema = z
  .strictObject({ agent: AgentIdSchema, messages: MessagesSchema, outcome: OutcomeSchema })
  .readonly();

export type TurnRecord = z.infer<typeof TurnRecordSchema>;

export type OperationKind = "prepare" | "completion" | "handoff" | "permission" | "batch" | "tool";

export type Ref<K extends OperationKind> = Readonly<{ kind: K; id: ActorId }>;

export const ref = <K extends OperationKind>(kind: K, id: string): Ref<K> =>
  Object.freeze({ kind, id: ActorIdSchema.parse(id) });

export type ChildRef = { [K in OperationKind]: Ref<K> }[OperationKind];

export type Result<T> =
  | Readonly<{ kind: "succeeded"; value: T }>
  | Readonly<{ kind: "failed"; error: Failure }>
  | Readonly<{ kind: "cancelled" }>;

export type TurnData = Readonly<{
  id: ActorId;
  generation: number;
  agent: AgentId;
  messages: readonly AgentMessage[];
  view:
    | Readonly<{ kind: "history" }>
    | Readonly<{ kind: "handoff"; messages: readonly AgentMessage[] }>;
  steps: Steps;
}>;

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

export const UserEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("user"), text: z.string() }),
  z.strictObject({ type: z.literal("abort") }),
]);

export type UserEvent = z.infer<typeof UserEventSchema>;
