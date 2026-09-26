import { copyResolvers, initialPolicy as resolveInitialPolicy } from "../../policy/policy.ts";
import { bindProviders } from "../../providers/transport.ts";
import type { SessionOptions } from "../session-runtime.ts";

/** Validates the bindings of `options` and flattens them with the configuration into one object. */
export function bindOptions(options: SessionOptions, restoring = false) {
  const { configuration, bindings } = options;
  const capabilities = {
    agents: [...configuration.agents].map(
      ([name, agent]) => [name, { ...agent, tools: agent.tools ?? [] }] as const,
    ),
  };
  if (Boolean(bindings.complete) === Boolean(bindings.providers))
    throw new Error("Bind exactly one completion port or provider registry");
  const providers = bindings.providers ? bindProviders(bindings.providers) : undefined;
  const resolvers = copyResolvers({
    ...copyResolvers(bindings.policies),
    providerCapabilities: providers?.capabilities,
    validateSelection: providers?.validateSelection,
    providerStreams: providers?.streams,
    permissionRequests: !!bindings.requestPermission,
    providerIds: providers ? new Set(providers.ids) : undefined,
  });
  const initialPolicy = restoring
    ? undefined
    : resolveInitialPolicy(capabilities, configuration.steps, configuration.policy, resolvers);
  if (!restoring && providers && !initialPolicy?.provider)
    throw new Error("Provider-bound sessions require an explicit provider policy");
  const completePort = providers?.complete ?? bindings.complete!;
  const normalized = {
    ...configuration,
    steps: initialPolicy?.steps ?? configuration.steps,
    persistence: options.persistence,
    sessionId: options.sessionId,
    ...bindings,
  };
  return {
    options: normalized,
    resolvers,
    initialPolicy,
    observe: bindings.observe,
    completePort,
    providerMedia: providers?.mediaFor,
    describeModel: providers?.describe,
  };
}

/** Bindings, resolvers and initial policy derived from {@link SessionOptions}. */
export type BoundOptions = ReturnType<typeof bindOptions>;
