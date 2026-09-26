import type { z } from "zod";

import { AgentIdSchema, StepsSchema, type AgentId } from "../../agent/types.ts";
import type { StreamUpdateSink, ToolUpdateSink } from "../../host/host.ts";
import { copyRegistries, type CompletionPort, type PermissionPort } from "../../host/ports.ts";
import {
  initialPolicy as resolveInitialPolicy,
  type Policy,
  type PolicyResolvers,
} from "../../policy/policy.ts";
import type { SessionPersistence } from "../persistence.ts";
import type { SessionOptions } from "../session-runtime.ts";
import { ConfigurationSchema, type Configuration } from "../types.ts";
import { bindOptions, type BoundOptions } from "./bind-options.ts";

/**
 * Validated configuration and captured bindings of a session, shared by the session and every
 * child session it forks or compacts.
 */
export type ConfiguredSession = Readonly<{
  options: BoundOptions["options"];
  resolvers: PolicyResolvers;
  initialPolicy: Policy | undefined;
  observe: BoundOptions["observe"];
  completePort: CompletionPort;
  providerMedia: BoundOptions["providerMedia"];
  describeModel: BoundOptions["describeModel"];
  toolUpdate: ToolUpdateSink | undefined;
  streamUpdate: StreamUpdateSink | undefined;
  requestPermission: PermissionPort | undefined;
  agentId: AgentId;
  steps: z.infer<typeof StepsSchema>;
  agents: ReturnType<typeof copyRegistries>["agents"];
  tools: ReturnType<typeof copyRegistries>["tools"];
  configuration: Configuration;
  id: () => string;
  port: SessionPersistence;
  /** The policy a new session would start with under the live bindings. */
  livePolicy: () => Policy;
}>;

/** Validates `raw` and captures its bindings; `restoring` skips the new-session policy. */
export function configureSession(raw: SessionOptions, restoring = false): ConfiguredSession {
  const { options, resolvers, initialPolicy, observe, completePort, providerMedia, describeModel } =
    bindOptions(raw, restoring);
  const toolUpdate = options.toolUpdate;
  const streamUpdate = options.streamUpdate;
  const requestPermission = options.requestPermission;
  const agentId = AgentIdSchema.parse(options.agent);
  const steps = StepsSchema.parse(options.steps);
  const { agents, tools } = copyRegistries(options);
  if (!agents.has(agentId)) throw new Error(`Unknown agent: ${agentId}`);
  const configuration = ConfigurationSchema.parse({
    agents: [...agents],
    tools: [...tools].map(([name, tool]) => [name, tool.parameters]),
  });
  const id = options.id ?? (() => crypto.randomUUID());
  const port = options.persistence;
  if (!port) throw new Error("Session persistence is required");
  return {
    options,
    resolvers,
    initialPolicy,
    observe,
    completePort,
    providerMedia,
    describeModel,
    toolUpdate,
    streamUpdate,
    requestPermission,
    agentId,
    steps,
    agents,
    tools,
    configuration,
    id,
    port,
    livePolicy: () => resolveInitialPolicy(configuration, steps, options.policy, resolvers),
  };
}
