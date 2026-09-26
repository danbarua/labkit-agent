import {
  bindingPolicyFields,
  patchPolicy,
  resolverPolicyFields,
  validatePolicy,
  type Policy,
} from "../../policy/policy.ts";
import type { Fold, JournalState, ReducibleBody, Reduction } from "./state.ts";

/**
 * Reduces a policy record: validates the new policy against the configuration and
 * resolvers, updates the conversation's allowance to match, and preserves the idle
 * turn's step limit.
 */
function reducePolicy(
  state: JournalState,
  input: Extract<ReducibleBody, { kind: "policy" }>,
  fold: Fold,
): Reduction {
  const c = state.conversation;
  // Load: the stored policy is the policy, whatever today's patch rules would derive.
  let policy = input.policy;
  if (fold.mode === "stage") {
    if (c.turn.status !== "idle" || state.pendingInputs?.length)
      throw new Error("Policy changes require an idle boundary");
    policy = validatePolicy(input.policy, state.configuration, fold.resolvers);
    if (
      !state.policy ||
      JSON.stringify(policy) !==
        JSON.stringify(patchPolicy(state.policy, input.patch, state.configuration, fold.resolvers))
    )
      throw new Error("Invalid policy patch/version");
  }
  return {
    state: {
      ...state,
      policy,
      pendingInputs: state.pendingInputs ?? [],
      // A running turn keeps the allowance it started with.
      conversation: {
        ...c,
        allowance: policy.steps,
        turn: c.turn.status === "idle" ? { ...c.turn, steps: policy.steps } : c.turn,
      },
    },
    commands: [],
  };
}

/**
 * Reduces a configuration record: updates the agents registry, policy, and idle
 * agent binding. Validates that the current agent is in the new registry and reconciles
 * only tool permissions, resolvers, and binding selections.
 */
function reduceConfiguration(
  state: JournalState,
  input: Extract<ReducibleBody, { kind: "configuration" }>,
  fold: Fold,
): Reduction {
  const c = state.conversation;
  if (fold.mode === "stage" && (c.turn.status !== "idle" || state.pendingInputs?.length))
    throw new Error("Configuration changes require an idle boundary");
  // The switch replaces the idle conversation's agent; a running turn has none to replace.
  if (input.agent !== undefined && c.turn.status !== "idle")
    throw new Error("Configuration agent switch during a running turn");
  const current = c.turn.status === "idle" ? c.turn.agent : c.turn.turn.agent;
  const agent = input.agent ?? current;
  // Load: the stored configuration, policy and agent replace the folded ones as written.
  let policy = input.policy ?? state.policy;
  if (fold.mode === "stage") {
    const registered = new Set<string>(input.configuration.agents.map(([id]) => id));
    // An agent switch is recorded only when the idle conversation's agent was unregistered.
    if (input.agent !== undefined && registered.has(current))
      throw new Error("Configuration agent switch requires an unregistered current agent");
    if (!registered.has(agent)) throw new Error(`Configuration omits the current agent: ${agent}`);
    if (input.policy) {
      // Reconciliation may rewrite only tool permissions, resolver IDs and binding selections.
      const previous = state.policy;
      const keys = new Set<string>([...Object.keys(previous ?? {}), ...Object.keys(input.policy)]);
      for (const key of ["tools", "version", ...resolverPolicyFields, ...bindingPolicyFields])
        keys.delete(key);
      if (
        !previous ||
        input.policy.version !== previous.version + 1 ||
        [...keys].some(
          (key) =>
            JSON.stringify(previous[key as keyof Policy]) !==
            JSON.stringify(input.policy![key as keyof Policy]),
        )
      )
        throw new Error(
          "Configuration policy may only reconcile tools, resolvers and binding selections",
        );
      policy = validatePolicy(input.policy, input.configuration, fold.resolvers);
    } else if (state.policy) validatePolicy(state.policy, input.configuration, fold.resolvers);
  }
  return {
    state: {
      ...state,
      configuration: input.configuration,
      policy,
      pendingInputs: state.pendingInputs ?? [],
      conversation:
        c.turn.status === "idle" && agent !== c.turn.agent
          ? { ...c, turn: { ...c.turn, agent } }
          : c,
    },
    commands: [],
  };
}

/**
 * Reduces a system record: updates standing session instructions and version.
 * Load requires version to continue; stage requires version to increment by one.
 */
function reduceSystem(
  state: JournalState,
  input: Extract<ReducibleBody, { kind: "system" }>,
  fold: Fold,
): Reduction {
  if (fold.mode === "stage") {
    if (state.conversation.turn.status !== "idle")
      throw new Error("System inputs require idle boundary");
    if (input.version !== state.systemVersion + 1) throw new Error("Invalid system version");
  }
  return {
    state: { ...state, systemInputs: input.inputs, systemVersion: input.version },
    commands: [],
  };
}

export { reducePolicy, reduceConfiguration, reduceSystem };
