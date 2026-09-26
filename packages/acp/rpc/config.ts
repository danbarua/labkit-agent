import { RequestError, type AgentApp, type AgentContext } from "@agentclientprotocol/sdk";
import type { SessionRuntime } from "@labkit-agent/core";
import { diagnostic, diagnosticError } from "@labkit-agent/core/logging";
import type { Policy } from "@labkit-agent/core/policy";

import {
  configPatch,
  configState,
  unlistedValues,
  type AcpConfigBinding,
  type ConfigState,
} from "../session-config.ts";
import type { ConnectionGate } from "./connection.ts";
import type { AdapterCore } from "./core.ts";
import type { Session } from "./session.ts";
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
  async function setConfig(
    method: "session/set_config_option" | "session/set_mode",
    id: string,
    configId: string,
    value: unknown,
    client: AgentContext,
    type?: string,
  ) {
    const started = performance.now();
    const trace = {
      connectionId,
      sessionId: id,
      rpcRequestId: String(client.requestId),
      method,
      configId,
      value: typeof value === "boolean" || typeof value === "string" ? value : undefined,
    };
    try {
      const entry = lookup(id);
      const binding = entry.config.find((binding) => binding.id === configId);
      if (!binding) throw RequestError.invalidParams(undefined, "Unknown config option or value");
      if (core.isClosing() || !isCurrent(id, entry) || !entry.acceptingUpdates)
        throw new RequestError(-32000, "Session closed");
      gate.requireAccess();
      // Choices can depend on the selected configuration (for example the model).
      const selected = entry.runtime.selectedPolicy;
      if (!selected) throw new RequestError(-32000, "Session has no journaled policy");
      const patch = configPatch(binding, value, selected, type);
      // An unlisted saved value is offered as a choice; re-selecting it changes nothing.
      const unchanged =
        (patch !== undefined || binding.type !== "boolean") && binding.current(selected) === value;
      let outcome: "unchanged" | "accepted" | "selected" | "ignored" = "unchanged";
      let correlation: { selectionId?: string; appendId?: string } = {};
      if (!unchanged) {
        if (!patch) throw RequestError.invalidParams(undefined, "Unknown config option or value");
        const receipt = await entry.runtime.updatePolicy(structuredClone(patch));
        if (receipt.kind === "closed") throw new RequestError(-32000, "Session closed");
        if (receipt.kind === "failed") throw new RequestError(-32000, receipt.message, receipt);
        if (receipt.kind === "busy")
          throw new RequestError(-32000, "Configuration change was not selected", receipt);
        outcome = receipt.kind;
        if (receipt.kind === "selected") correlation = { selectionId: receipt.id };
        if (receipt.kind === "accepted") correlation = { appendId: receipt.receipt.appendId };
      }
      diagnostic("acp", "info", "acp.config.selected", {
        ...trace,
        outcome,
        ...correlation,
        revision: entry.runtime.snapshot.durable.revision,
        durationMs: performance.now() - started,
      });
      const state = configState(entry.config, entry.runtime.selectedPolicy);
      updates.observe(entry, client, entry.runtime.snapshot);
      updates.refreshInfo(entry, client);
      await core.flushed();
      return { configOptions: state.configOptions ?? [] };
    } catch (error) {
      diagnostic("acp", "warning", "acp.config.failed", {
        ...trace,
        outcome: "failed",
        durationMs: performance.now() - started,
        error: diagnosticError(error),
      });
      throw error;
    }
  }

  app
    .onRequest("session/set_config_option", ({ params, client }) =>
      setConfig(
        "session/set_config_option",
        params.sessionId,
        params.configId,
        params.value,
        client,
        "type" in params ? params.type : undefined,
      ),
    )
    .onRequest("session/set_mode", async ({ params, client }) => {
      const entry = lookup(params.sessionId);
      const mode = entry.config.find(
        (binding) => binding.category === "mode" && binding.type !== "boolean",
      );
      if (!mode) throw RequestError.methodNotFound("session/set_mode");
      await setConfig("session/set_mode", params.sessionId, mode.id, params.modeId, client);
      return {};
    });
  return ["session/set_config_option", "session/set_mode"];
}
