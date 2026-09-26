import type { z } from "zod";

import type { AgentId } from "../../agent/types.ts";
import {
  bindingPolicyFields,
  PolicySchema,
  resolverPolicyFields,
  unresolvedPolicyFields,
  validatePolicy,
  type Policy,
  type PolicyPatch,
  type PolicyResolvers,
} from "../../policy/policy.ts";
import type { JournalState } from "../session-log.ts";
import type { Configuration, ConfigurationSchema, JournalBody } from "../types.ts";

/**
 * Name a tool-parameter schema change by its top-level `properties` and `required` delta, without
 * copying schema bodies. Other keyword changes are summarized as "other schema keywords".
 */
function schemaDelta(
  previous: Readonly<Record<string, unknown>>,
  current: Readonly<Record<string, unknown>>,
) {
  const properties = (schema: Readonly<Record<string, unknown>>) =>
    new Map(
      schema.properties !== null && typeof schema.properties === "object"
        ? Object.entries(schema.properties)
        : [],
    );
  const required = (schema: Readonly<Record<string, unknown>>) =>
    new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  const [before, after] = [properties(previous), properties(current)];
  const [wasRequired, isRequired] = [required(previous), required(current)];
  const added = [...after.keys()].filter((name) => !before.has(name));
  const removed = [...before.keys()].filter((name) => !after.has(name));
  const changed = [...after.keys()].filter(
    (name) =>
      before.has(name) && JSON.stringify(before.get(name)) !== JSON.stringify(after.get(name)),
  );
  const requiredAdded = [...isRequired].filter((name) => !wasRequired.has(name));
  const requiredRemoved = [...wasRequired].filter((name) => !isRequired.has(name));
  const { properties: _before, required: _wasRequired, ...otherBefore } = previous;
  const { properties: _after, required: _isRequired, ...otherAfter } = current;
  const parts = [
    ...(added.length ? [`added properties ${added.join(", ")}`] : []),
    ...(removed.length ? [`removed properties ${removed.join(", ")}`] : []),
    ...(requiredAdded.length ? [`required added ${requiredAdded.join(", ")}`] : []),
    ...(requiredRemoved.length ? [`required removed ${requiredRemoved.join(", ")}`] : []),
    ...(changed.length
      ? [`changed ${changed.length > 1 ? "properties" : "property"} ${changed.join(", ")}`]
      : []),
  ];
  const other = JSON.stringify(otherBefore) !== JSON.stringify(otherAfter);
  if (!parts.length) return other ? " (other schema keywords)" : " (serialization order)";
  return `: ${parts.join("; ")}${other ? "; other schema keywords" : ""}`;
}

/** Describe binding drift without copying system prompts or JSON-schema bodies into errors. */
export function registryDifferences(
  expected: z.infer<typeof ConfigurationSchema>,
  actual: z.infer<typeof ConfigurationSchema>,
): string[] {
  const differences: string[] = [];
  for (const group of ["agents", "tools"] as const) {
    const before = new Map<string, unknown>(expected[group]);
    const after = new Map<string, unknown>(actual[group]);
    const names = [...new Set([...before.keys(), ...after.keys()])].sort();
    for (const name of names) {
      const path = `${group}.${name}`;
      if (!after.has(name)) differences.push(`missing ${path}`);
      else if (!before.has(name)) differences.push(`added ${path}`);
      else if (JSON.stringify(before.get(name)) !== JSON.stringify(after.get(name))) {
        if (group === "tools")
          differences.push(
            `changed ${path}.parameters${schemaDelta(
              before.get(name) as Readonly<Record<string, unknown>>,
              after.get(name) as Readonly<Record<string, unknown>>,
            )}`,
          );
        else {
          const previous = before.get(name) as Record<string, unknown>;
          const current = after.get(name) as Record<string, unknown>;
          const fields = [...new Set([...Object.keys(previous), ...Object.keys(current)])].sort();
          const changed = fields.filter(
            (field) => JSON.stringify(previous[field]) !== JSON.stringify(current[field]),
          );
          for (const field of changed) differences.push(`changed ${path}.${field}`);
          if (!changed.length) differences.push(`changed ${path} serialization order`);
        }
      }
    }
    if (
      JSON.stringify([...before.keys()]) !== JSON.stringify([...after.keys()]) &&
      names.every((name) => before.has(name) && after.has(name))
    )
      differences.push(`changed ${group} registry order`);
  }
  return differences;
}

type Reconciliation = Readonly<{
  level: "info" | "warning";
  fields: Readonly<Record<string, unknown>>;
}>;

/** A pending journaled adoption of the live registry, policy and agent. */
export type Adoption = Readonly<{
  differences: readonly string[];
  body: Extract<JournalBody, { kind: "configuration" }>;
  reconciliations: readonly Reconciliation[];
}>;

type AdoptionContext = Readonly<{
  live: Configuration;
  defaultAgent: AgentId;
  patchTools: PolicyPatch["tools"];
  resolvers: PolicyResolvers;
  /** The policy a new session would start with; computed only when a selection is unavailable. */
  livePolicy: () => Policy;
}>;

/**
 * Replace the fewest binding-dependent fields with live defaults so the policy validates against
 * today's bindings. The saved provider/model is kept whenever some setting combination allows it.
 */
function reconcileSelection(
  policy: Policy,
  defaults: Policy,
  live: Configuration,
  resolvers: PolicyResolvers,
): Policy {
  const withDefaults = (
    base: Readonly<Record<string, unknown>>,
    fields: readonly (keyof Policy)[],
  ) => {
    const next: Record<string, unknown> = { ...base };
    for (const field of fields)
      if (defaults[field] === undefined) delete next[field];
      else next[field] = defaults[field];
    return next;
  };
  const settings = bindingPolicyFields.filter((field) => field !== "provider" && field !== "model");
  const subsets = Array.from({ length: 2 ** settings.length }, (_, mask) =>
    settings.filter((_, index) => mask & (1 << index)),
  ).sort((a, b) => a.length - b.length);
  let first: unknown;
  for (const base of [policy, withDefaults(policy, ["provider", "model"])])
    for (const fields of subsets)
      try {
        return validatePolicy(withDefaults(base, fields), live, resolvers);
      } catch (error) {
        first ??= error;
      }
  throw new Error(
    `No live provider selection can replace the saved one: ${first instanceof Error ? first.message : String(first)}`,
  );
}

/**
 * Plan the journaled adoption of the live registry and bindings at an idle boundary. Only the
 * registry, per-agent tool permissions, resolver IDs the live environment lacks, binding-dependent
 * policy fields and an unregistered current agent change; committed history is kept verbatim.
 * Returns undefined when nothing differs.
 */
export function planAdoption(state: JournalState, context: AdoptionContext): Adoption | undefined {
  const { live, resolvers } = context;
  const reconciliations: Reconciliation[] = [];
  const persistedTools = new Map(state.configuration.tools);
  const liveTools = new Map(live.tools);
  const removedTools = [...persistedTools.keys()].filter((name) => !liveTools.has(name));
  const addedTools = [...liveTools.keys()].filter((name) => !persistedTools.has(name));
  const changedTools = [...liveTools].flatMap(([name, parameters]) =>
    persistedTools.has(name) &&
    JSON.stringify(persistedTools.get(name)) !== JSON.stringify(parameters)
      ? [name]
      : [],
  );
  if (removedTools.length || addedTools.length || changedTools.length)
    reconciliations.push({
      level: "info",
      fields: {
        reconciliation: "tool_registry",
        removedTools,
        addedTools,
        changedTools,
        consequence: "next prompt advertises only live tools; earlier tool calls stay in history",
      },
    });
  const c = state.conversation;
  const current = c.turn.status === "idle" ? c.turn.agent : c.turn.turn.agent;
  const liveAgents = new Map(live.agents);
  const agent = liveAgents.has(current) ? undefined : context.defaultAgent;
  if (agent)
    reconciliations.push({
      level: "warning",
      fields: {
        reconciliation: "agent_switched",
        previousAgent: current,
        nextAgent: agent,
        consequence: `conversation continues with agent ${agent}`,
      },
    });
  const differences = registryDifferences(state.configuration, live);
  let policy: Policy | undefined;
  if (state.policy) {
    // Keep committed permissions for surviving agents; derive new agents as creation does.
    const previous = state.policy.tools;
    const tools = Object.fromEntries(
      live.agents.map(([id, definition]) => [
        id,
        (previous[id] ?? context.patchTools?.[id] ?? definition.tools).filter((name) =>
          definition.tools.some((tool) => tool === name),
        ),
      ]),
    );
    const toolsChanged =
      Object.keys(tools).length !== Object.keys(previous).length ||
      Object.entries(tools).some(
        ([id, allowed]) => JSON.stringify(allowed) !== JSON.stringify(previous[id]),
      );
    let candidate = toolsChanged ? PolicySchema.parse({ ...state.policy, tools }) : state.policy;
    // A saved pack, projection or handoff the live resolvers lack takes the new-session default.
    const unresolved = unresolvedPolicyFields(candidate, resolvers);
    if (unresolved.length) {
      const defaults = context.livePolicy();
      candidate = PolicySchema.parse({
        ...candidate,
        ...Object.fromEntries(unresolved.map((field) => [field, defaults[field]])),
      });
    }
    let unavailable: string | undefined;
    try {
      validatePolicy(candidate, live, resolvers);
    } catch (error) {
      unavailable = error instanceof Error ? error.message : String(error);
      candidate = reconcileSelection(candidate, context.livePolicy(), live, resolvers);
    }
    if (candidate !== state.policy) {
      policy = validatePolicy({ ...candidate, version: state.policy.version + 1 }, live, resolvers);
      for (const id of new Set([...Object.keys(previous), ...liveAgents.keys()])) {
        const before = previous[id];
        const after = policy.tools[id];
        if (!after)
          reconciliations.push({
            level: "info",
            fields: { reconciliation: "policy_agent_removed", agentId: id, removedTools: before },
          });
        else if (!before)
          reconciliations.push({
            level: "info",
            fields: { reconciliation: "policy_agent_added", agentId: id, allowedTools: after },
          });
        else if (before.some((name) => !after.includes(name)))
          reconciliations.push({
            level: "info",
            fields: {
              reconciliation: "policy_tools_removed",
              agentId: id,
              removedTools: before.filter((name) => !after.includes(name)),
              policyVersion: policy.version,
            },
          });
      }
      const saved = state.policy;
      const next = policy;
      const resolved = resolverPolicyFields.filter((field) => saved[field] !== next[field]);
      if (resolved.length) {
        differences.push(...resolved.map((field) => `changed policy.${field}`));
        const consequences = {
          id: `later policy changes start from pack ${next.id}`,
          project: `next turn projects history with ${next.project}`,
          handoff: `handoffs project with ${next.handoff}`,
        };
        reconciliations.push({
          // A new pack ID changes nothing the model sees; a new projection or handoff does.
          level: resolved.some((field) => field !== "id") ? "warning" : "info",
          fields: {
            reconciliation: "policy",
            policyVersion: next.version,
            changedFields: resolved,
            previous: Object.fromEntries(resolved.map((field) => [field, saved[field]])),
            next: Object.fromEntries(resolved.map((field) => [field, next[field]])),
            reason: `saved policy names resolvers the live environment does not supply: ${resolved
              .map((field) => `${field} ${saved[field]}`)
              .join(", ")}`,
            consequence: resolved.map((field) => consequences[field]).join("; "),
          },
        });
      }
      const changed = bindingPolicyFields.filter(
        (field) => JSON.stringify(saved[field]) !== JSON.stringify(next[field]),
      );
      if (changed.length) {
        differences.push(...changed.map((field) => `changed policy.${field}`));
        const model = next.model ?? liveAgents.get(agent ?? current)?.model;
        reconciliations.push({
          level: "warning",
          fields: {
            reconciliation: "policy",
            policyVersion: next.version,
            changedFields: changed,
            previous: Object.fromEntries(changed.map((field) => [field, saved[field] ?? null])),
            next: Object.fromEntries(changed.map((field) => [field, next[field] ?? null])),
            reason: `saved selection is not available in the live bindings: ${unavailable}`,
            consequence: `next turn uses ${next.provider ?? "the bound completion port"}/${model}`,
          },
        });
      }
    }
  }
  if (!differences.length && !policy && !agent) return undefined;
  return {
    differences,
    reconciliations,
    body: {
      kind: "configuration",
      configuration: live,
      ...(policy ? { policy } : {}),
      ...(agent ? { agent } : {}),
    },
  };
}
