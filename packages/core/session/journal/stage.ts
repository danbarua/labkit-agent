import type { ConversationCommand } from "../../agent/agent-conversation.ts";
import { ActorIdSchema } from "../../agent/types.ts";
import { freeze } from "../../fsm/fsm.ts";
import {
  builtinResolvers,
  patchPolicy,
  PolicyPatchSchema,
  type PolicyResolvers,
} from "../../policy/policy.ts";
import { RevisionSchema, type AppendId } from "../persistence.ts";
import { JournalRecordSchema, type JournalBody, type Seed, type SessionInput } from "../types.ts";
import { encodeRecord } from "./codec.ts";
import { reduce } from "./reduce.ts";
import { seedConversation } from "./seed.ts";
import type { Fold, JournalState } from "./state.ts";

/**
 * Stages new work: folds `input` into `state` under every commit-time rule, checked against the
 * live resolvers. Inputs are admitted if they apply to the state and pass all policy checks.
 *
 * If `input.kind === "created"`, `stageCreation` is called instead.
 *
 * The state that is returned is ready to commit. Its `records` array holds the batch's encoded
 * journal records in revision order, ready to append. The staged state is frozen and a proposal
 * until the batch commits, after which it becomes the result of {@link replay}. Conversely, load
 * is integrity-only: each stored record is taken as written, and never re-validated against live
 * policy or code.
 *
 * @param state The current state, from {@link replay} or a prior staging.
 * @param input The input to fold.
 * @param appendId The append ID that will be assigned to this batch's records.
 * @param resolvers Policy resolvers to use during rule checking; see {@link builtinResolvers}.
 * @param inputId The actor ID, defaulted to `appendId`.
 * @returns An object holding the frozen next `state`, the `records` array ready to append, and any
 *   `commands` that the model issued (e.g., a handoff tool call).
 * @throws Error or ZodError on any validation error or missing target.
 */
export function stage(
  state: JournalState,
  input: SessionInput,
  appendId: AppendId,
  resolvers: PolicyResolvers = builtinResolvers,
  inputId = ActorIdSchema.parse(appendId),
) {
  if (input.kind === "created") {
    if (
      state.revision !== 0 ||
      state.records.length ||
      input.seed.sessionId !== state.conversation.sessionId
    )
      throw new Error("Creation requires an absent stream");
    return stageCreation(input.seed, appendId, resolvers);
  }
  const fold: Fold = { mode: "stage", resolvers };
  let next = state;
  const bodies: JournalBody[] = [];
  const commands: ConversationCommand[] = [];
  const apply = (body: Exclude<JournalBody, { kind: "created" | "terminal" }>) => {
    const before = next;
    const decision = reduce(next, body, fold);
    next = decision.state;
    bodies.push(body);
    commands.push(...decision.commands);
    if (next.conversation.sequence !== before.conversation.sequence)
      bodies.push({
        kind: "terminal",
        turnId: before.conversation.turnId,
        record: next.conversation.log.at(-1)!,
      });
  };
  if (input.kind === "policy") {
    apply({
      kind: "policy",
      patch: PolicyPatchSchema.parse(input.patch),
      policy: patchPolicy(next.policy!, input.patch, next.configuration, resolvers),
    });
  } else if (
    input.kind === "event" &&
    input.event.type === "user" &&
    next.policy &&
    next.conversation.turn.status !== "idle" &&
    (next.policy.admission === "queue-user" ||
      (next.policy.admission === "abort-tools-on-user" &&
        ["awaiting_permission", "executing_tools", "cancelling_tools"].includes(
          next.conversation.turn.status,
        )))
  ) {
    apply({
      kind: "queued",
      inputId,
      text: input.event.text,
      ...(input.event.attachments ? { attachments: input.event.attachments } : {}),
      policyVersion: next.policy.version,
    });
    if (
      next.policy!.admission === "abort-tools-on-user" &&
      ["awaiting_permission", "executing_tools"].includes(next.conversation.turn.status)
    )
      apply({
        kind: "event",
        event: { type: "abort" },
        systemVersion: next.systemVersion,
        policyVersion: next.policy!.version,
      });
  } else {
    apply(
      input.kind === "event" && next.policy
        ? { ...input, policyVersion: next.policy.version }
        : input,
    );
  }
  if (input.kind === "recovery")
    for (const pending of next.pendingInputs ?? [])
      apply({ kind: "input_cancelled", inputId: pending.inputId, reason: input.reason });
  return packageRecords(state, next, bodies, appendId, commands);
}

function packageRecords(
  previous: JournalState,
  next: JournalState,
  bodies: readonly JournalBody[],
  appendId: AppendId,
  commands: readonly ConversationCommand[] = [],
) {
  const records = bodies.map((body, index) => {
    return JournalRecordSchema.parse({
      version: 1,
      sessionId: previous.conversation.sessionId,
      revision: previous.revision + index + 1,
      entryId: `${appendId}/${index}`,
      appendId,
      body,
    });
  });
  const revision = RevisionSchema.parse(previous.revision + records.length);
  return freeze({
    state: { ...next, revision, records: [...previous.records, ...records] },
    records: records.map(encodeRecord),
    commands,
  });
}

/**
 * Stages the `created` record of a new session: {@link seedConversation} under the commit-time
 * rules, as a one-record append at revision 1. Load folds the committed seed without these rules.
 *
 * @throws Error or ZodError, as {@link seedConversation} does.
 */
export function stageCreation(
  seed: Seed,
  appendId: AppendId,
  resolvers: PolicyResolvers = builtinResolvers,
) {
  const state = seedConversation(seed, resolvers);
  return packageRecords(state, state, [{ kind: "created", seed }], appendId);
}
