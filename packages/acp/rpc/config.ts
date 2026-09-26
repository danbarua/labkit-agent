import { RequestError, type AgentApp, type AgentContext } from "@agentclientprotocol/sdk";
import type { SessionRuntime } from "@labkit-agent/core";
import { diagnostic, diagnosticError } from "@labkit-agent/core/logging";
import type { Policy } from "@labkit-agent/core/policy";

import {
  configPatch,
  configState,
  unlistedValues,
  waitForBoundary,
  type AcpConfigBinding,
  type ConfigState,
} from "../session-config.ts";
import type { ConnectionGate } from "./connection.ts";
import type { AdapterCore } from "./core.ts";
import { afterPrompt, type Session } from "./session.ts";
import type { SessionRegistry } from "./sessions.ts";
import type { SessionUpdates } from "./updates.ts";

/** Log each saved config value that the selector no longer lists. */
export function logUnlisted(
  config: readonly AcpConfigBinding[],
  policy: Policy | undefined,
  fields: Record<string, unknown>,
): void {
  for (const { configId, value } of unlistedValues(config, policy))
    diagnostic("acp", "info", "acp.session.config.unlisted_value", {
      ...fields,
      configId,
      value,
      consequence:
        "selector shows the value as an extra saved choice; choosing another value patches policy",
    });
}

/** Sole writer of a session's projected config signature and mode. */
export type ConfigProjection = Readonly<{
  /** Send config and mode updates when the projected state changed. */
  project(
    entry: Omit<Session, "runtime"> & { runtime?: SessionRuntime },
    client: AgentContext,
    id: string,
    policy: Policy | undefined,
    revision: number,
  ): void;
  /** Record the state an open response already reported. */
  prime(entry: Omit<Session, "runtime">, configuration: ConfigState): void;
}>;

/** Builds the config projection for one connection. */
export function configProjection(
  core: Pick<AdapterCore, "connectionId" | "send">,
): ConfigProjection {
  return {
    project(entry, client, id, policy, revision) {
      const configuration = configState(entry.config, policy);
      const signature = JSON.stringify(configuration);
      if (signature !== entry.configSignature) {
        entry.configSignature = signature;
        logUnlisted(entry.config, policy, {
          connectionId: core.connectionId,
          sessionId: id,
          revision,
        });
        if (configuration.configOptions)
          core.send(client, id, {
            sessionUpdate: "config_option_update",
            configOptions: configuration.configOptions,
          });
        if (configuration.modes && configuration.modes.currentModeId !== entry.modeId) {
          entry.modeId = configuration.modes.currentModeId;
          core.send(client, id, {
            sessionUpdate: "current_mode_update",
            currentModeId: entry.modeId,
          });
        }
      }
    },
    prime(entry, configuration) {
      entry.configSignature = JSON.stringify(configuration);
      entry.modeId = configuration.modes?.currentModeId;
    },
  };
}

/** Registers session/set_config_option and session/set_mode. */
export function registerConfiguration(
  app: AgentApp,
  deps: Readonly<{
    core: AdapterCore;
    gate: Pick<ConnectionGate, "requireAccess">;
    registry: Pick<SessionRegistry, "lookup" | "isCurrent">;
    updates: Pick<SessionUpdates, "observe" | "refreshInfo">;
  }>,
): readonly string[] {
  const { core, gate, updates } = deps;
  const { connectionId } = core;
  const { lookup, isCurrent } = deps.registry;
  function setConfig(
    id: string,
    configId: string,
    value: unknown,
    client: AgentContext,
    signal: AbortSignal,
    type?: string,
  ) {
    const started = performance.now();
    const trace = {
      connectionId,
      sessionId: id,
      rpcRequestId: String(client.requestId),
      method: "session/set_config_option",
      configId,
    };
    const entry = lookup(id);
    diagnostic("acp", "info", "acp.config.queued", {
      ...trace,
      reason: entry.busy ? "active_prompt" : "configuration_boundary",
    });
    const binding = entry.config.find((binding) => binding.id === configId);
    const effective = entry.runtime.policy;
    const offered = binding && effective && configPatch(binding, value, effective, type);
    // An unlisted saved value is offered as a choice; re-selecting it changes nothing.
    const keepsSaved =
      binding?.type !== "boolean" && effective && binding?.current(effective) === value;
    if (!binding || (!offered && !keepsSaved))
      throw RequestError.invalidParams(undefined, "Unknown config option or value");
    const cancellation = AbortSignal.any([signal, core.signal()]);
    const operation = afterPrompt(entry, cancellation, async () => {
      if (core.isClosing() || !isCurrent(id, entry) || !entry.acceptingUpdates)
        throw new RequestError(-32000, "Session closed");
      gate.requireAccess();
      const policy = entry.runtime.policy;
      if (!policy) throw new RequestError(-32000, "Session has no journaled policy");
      if (binding.current(policy) !== value) {
        // Choices can depend on policy (for example the model); resolve against the policy in effect now.
        const patch = configPatch(binding, value, policy, type);
        if (!patch) throw RequestError.invalidParams(undefined, "Unknown config option or value");
        const receipt = await entry.runtime.updatePolicy(structuredClone(patch));
        if (receipt.kind !== "accepted")
          throw new RequestError(-32000, "Configuration change was not committed", receipt);
      }
      diagnostic("acp", "info", "acp.config.committed", {
        ...trace,
        configValue: typeof value === "boolean" || typeof value === "string" ? value : undefined,
        revision: entry.runtime.snapshot.durable.revision,
        durationMs: performance.now() - started,
      });
      const state = configState(entry.config, entry.runtime.policy);
      updates.observe(entry, client, entry.runtime.snapshot);
      updates.refreshInfo(entry, client);
      await core.flushed();
      return { configOptions: state.configOptions ?? [] };
    });
    return waitForBoundary(operation, cancellation)
      .then(() => operation)
      .catch((error) => {
        diagnostic(
          "acp",
          cancellation.aborted ? "info" : "warning",
          cancellation.aborted ? "acp.config.cancelled" : "acp.config.failed",
          {
            ...trace,
            outcome: cancellation.aborted ? "cancelled" : "failed",
            durationMs: performance.now() - started,
            error: diagnosticError(error),
          },
        );
        throw error;
      });
  }

  app
    .onRequest("session/set_config_option", ({ params, client, signal }) =>
      setConfig(
        params.sessionId,
        params.configId,
        params.value,
        client,
        signal,
        "type" in params ? params.type : undefined,
      ),
    )
    .onRequest("session/set_mode", async ({ params, client, signal }) => {
      const entry = lookup(params.sessionId);
      const mode = entry.config.find(
        (binding) => binding.category === "mode" && binding.type !== "boolean",
      );
      if (!mode) throw RequestError.methodNotFound("session/set_mode");
      await setConfig(params.sessionId, mode.id, params.modeId, client, signal);
      return {};
    });
  return ["session/set_config_option", "session/set_mode"];
}
