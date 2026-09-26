import { RequestError } from "@agentclientprotocol/sdk";
import type { AgentContext } from "@agentclientprotocol/sdk";
import type { SessionRuntime } from "@labkit-agent/core";
import { diagnostic } from "@labkit-agent/core/logging";
import type { Policy } from "@labkit-agent/core/policy";

import { configState, unlistedValues, type AcpConfigBinding } from "../session-config.ts";
import type { AdapterCore } from "./core.ts";
import type { Session } from "./session.ts";

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

export type ConfigState = ReturnType<typeof configState>;

export function configProjection(core: Pick<AdapterCore, "connectionId" | "send">): Readonly<{
  project(
    entry: Omit<Session, "runtime"> & { runtime?: SessionRuntime },
    client: AgentContext,
    id: string,
    policy: Policy | undefined,
    revision: number,
  ): void;
  prime(
    entry: Omit<Session, "runtime"> & { runtime?: SessionRuntime },
    configuration: ConfigState,
  ): void;
}> {
  return {
    project(
      entry: Omit<Session, "runtime"> & { runtime?: SessionRuntime },
      client: AgentContext,
      id: string,
      policy: Policy | undefined,
      revision: number,
    ): void {
      if (!entry.acceptingUpdates) return;
      const configuration = configState(entry.config, policy);
      const signature = JSON.stringify(configuration);
      if (signature !== entry.configSignature) {
        entry.configSignature = signature;
        logUnlisted(entry.config, policy, {
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
    prime(
      entry: Omit<Session, "runtime"> & { runtime?: SessionRuntime },
      configuration: ConfigState,
    ): void {
      entry.configSignature = JSON.stringify(configuration);
      entry.modeId = configuration.modes?.currentModeId;
    },
  };
}

interface ConfigOptionRequest {
  sessionId: string;
  configId: string;
  value: unknown;
  type?: string;
}

interface SetModeRequest {
  sessionId: string;
  modeId: string;
}

interface ConfigOptionResponse {
  configOptions: unknown[];
}

export function registerConfiguration(
  app: unknown,
  deps: {
    lookup: (id: string) => Session;
    setConfig: (
      id: string,
      configId: string,
      value: unknown,
      client: AgentContext,
      signal: AbortSignal,
      type?: string,
    ) => Promise<ConfigOptionResponse>;
  },
): readonly string[] {
  const builder = app as { onRequest(method: string, handler: (arg: unknown) => unknown): unknown };
  builder
    .onRequest("session/set_config_option", (arg: unknown) => {
      const { params, client, signal } = arg as {
        params: ConfigOptionRequest;
        client: AgentContext;
        signal: AbortSignal;
      };
      return deps.setConfig(
        params.sessionId,
        params.configId,
        params.value,
        client,
        signal,
        params.type,
      );
    })
    .onRequest("session/set_mode", async (arg: unknown) => {
      const { params, client, signal } = arg as {
        params: SetModeRequest;
        client: AgentContext;
        signal: AbortSignal;
      };
      const entry = deps.lookup(params.sessionId);
      const mode = entry.config.find(
        (binding) => binding.category === "mode" && binding.type !== "boolean",
      );
      if (!mode) throw RequestError.methodNotFound("session/set_mode");
      await deps.setConfig(params.sessionId, mode.id, params.modeId, client, signal);
      return {};
    });

  return ["session/set_config_option", "session/set_mode"];
}
