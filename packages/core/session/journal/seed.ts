import { initialConversation, type ConversationState } from "../../agent/agent-conversation.ts";
import { projectConversationPrompt } from "../../agent/prompt.ts";
import { ActorIdSchema } from "../../agent/types.ts";
import { freeze } from "../../fsm/fsm.ts";
import { builtinResolvers, validatePolicy, type PolicyResolvers } from "../../policy/policy.ts";
import { INITIAL_REVISION } from "../persistence.ts";
import { SeedSchema, type Seed } from "../types.ts";
import type { JournalState } from "./state.ts";

/**
 * Builds the initial state of a new session from its seed under every commit-time rule: the turn
 * sequence against origin and log, a registered starting agent, the policy against the registry and
 * live `resolvers`, inherited continuation owners and provider bindings, and a history that
 * projects into a prompt. Load folds a committed seed without these checks.
 *
 * @throws Error when the seed breaks a commit-time rule; ZodError when it does not parse.
 */
export function seedConversation(
  raw: Seed,
  resolvers: PolicyResolvers = builtinResolvers,
): JournalState {
  const seed = SeedSchema.parse(raw);
  if (
    seed.sequence !== seed.log.length + 1 ||
    (seed.origin.kind === "fork" && seed.sequence !== seed.origin.sequence)
  )
    throw new Error("Invalid inherited sequence");
  if (!seed.configuration.agents.some(([id]) => id === seed.agent))
    throw new Error("Unknown seed agent");
  if (seed.origin.kind === "root" && (seed.sequence !== 1 || seed.log.length))
    throw new Error("Invalid root boundary");
  if (seed.origin.kind === "compaction" && (seed.sequence !== 1 || seed.log.length))
    throw new Error("Invalid compaction boundary");
  if (
    seed.policy &&
    validatePolicy(seed.policy, seed.configuration, resolvers).steps !== seed.allowance
  )
    throw new Error("Policy allowance mismatch");
  if (seed.continuations) {
    const owners = new Set<string>();
    for (const entry of seed.continuations) {
      if (resolvers.providerIds && !resolvers.providerIds.has(entry.provider))
        throw new Error("Missing continuation provider binding");
      const key = JSON.stringify(entry.owner);
      if (
        seed.origin.kind !== "fork" ||
        owners.has(key) ||
        ![...seed.context, ...seed.log.flatMap((record) => record.messages)].some(
          (message) =>
            message.role === "assistant" &&
            message.owner?.turnId === entry.owner.turnId &&
            message.owner.generation === entry.owner.generation,
        )
      )
        throw new Error("Invalid inherited continuation owner");
      owners.add(key);
    }
  }
  const state = foldSeed(seed);
  // Validate inherited history as well as the replacement context.
  projectConversationPrompt({
    context: seed.context,
    log: seed.log,
    agent: { model: "validation", tools: [] },
    turn: {
      id: state.conversation.turnId,
      agent: seed.agent,
      generation: 0,
      steps: seed.allowance,
      messages: [],
      view: { kind: "history" },
    },
  });
  return state;
}

/** Loading a creation record: the committed seed is the initial state, as written. */
export function foldSeed(seed: Seed): JournalState {
  const initial = initialConversation(seed.agent, seed.allowance, seed.sessionId);
  const id = ActorIdSchema.parse(`${seed.sessionId}/turn/${seed.sequence}`);
  const conversation: ConversationState = {
    ...initial,
    context: seed.context,
    origin: seed.origin,
    log: seed.log,
    sequence: seed.sequence,
    turnId: id,
    turn: { ...initial.turn, status: "idle", id, agent: seed.agent, steps: seed.allowance },
  };
  return freeze({
    conversation,
    ...(seed.continuations?.length ? { continuations: seed.continuations } : {}),
    configuration: seed.configuration,
    policy: seed.policy,
    pendingInputs: [],
    systemInputs: seed.systemInputs,
    systemVersion: seed.systemVersion,
    partial: [],
    revision: INITIAL_REVISION,
    records: [],
  });
}
