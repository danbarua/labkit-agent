import {
  PROTOCOL_VERSION,
  RequestError,
  type AgentApp,
  type ClientCapabilities,
} from "@agentclientprotocol/sdk";
import { diagnostic, diagnosticError } from "@labkit-agent/core/logging";

import { bindAuth, type AcpAuth, type BoundAuth } from "../auth.ts";
import { requestElicitation } from "../client-elicitation.ts";
import {
  advertisedPromptCapabilities,
  type AcpPromptCapabilities,
  type AdvertisedPromptCapabilities,
} from "../prompt-input.ts";
import type { AdapterCore } from "./core.ts";

/** Initialize and auth checks every session handler runs, plus what initialize captured. */
export type ConnectionGate = Readonly<{
  requireInitialized(): void;
  requireAccess(): void;
  clientCapabilities(): ClientCapabilities;
  promptCapabilities(): AdvertisedPromptCapabilities;
  logoutSupported: boolean;
}>;

/** Connection state written only by the initialize handler in this module. */
export type GateState = {
  readonly auth: BoundAuth;
  initialized: boolean;
  initializing: boolean;
  clientCapabilities: ClientCapabilities;
  promptCapabilities: AdvertisedPromptCapabilities;
};

/** Optional methods and capabilities; initialize and the -32601 gate read the same flags. */
export type Advertised = Readonly<{
  loadSession: boolean;
  forkSession: boolean;
  deleteSession: boolean;
  listSessions: boolean;
  additionalDirectories: boolean;
}>;

/** Binds auth and returns the gate other modules check, with the state initialize writes. */
export function connectionGate(
  binding: AcpAuth | undefined,
  isClosing: () => boolean,
): ConnectionGate & Readonly<{ state: GateState }> {
  const state: GateState = {
    auth: bindAuth(binding),
    initialized: false,
    initializing: false,
    clientCapabilities: {},
    promptCapabilities: { image: false, audio: false, embeddedContext: false },
  };
  const requireInitialized = () => {
    if (!state.initialized)
      throw new RequestError(
        -32600,
        "Invalid request: the connection is not initialized; send initialize and wait for its response before any other request",
        { reason: "not_initialized" },
      );
    if (isClosing()) throw new RequestError(-32000, "Connection closed");
  };
  return {
    state,
    requireInitialized,
    requireAccess() {
      requireInitialized();
      state.auth.requireAccess();
    },
    clientCapabilities: () => state.clientCapabilities,
    promptCapabilities: () => state.promptCapabilities,
    logoutSupported: state.auth.logoutSupported,
  };
}

/**
 * Registers the handlers that claim unadvertised conditional methods. It must run before any
 * typed registration so it answers -32601 before params, initialization, auth or session state.
 */
export function registerUnadvertised(
  app: AgentApp,
  core: Pick<AdapterCore, "connectionId">,
  advertised: Advertised,
  logoutSupported: boolean,
): readonly string[] {
  // A conditional method that initialize does not advertise is claimed by this earlier handler,
  // which answers -32601 before params, initialization, auth or session state are checked.
  const conditional = [
    ["session/load", "agentCapabilities.loadSession", advertised.loadSession],
    ["session/resume", "agentCapabilities.sessionCapabilities.resume", advertised.loadSession],
    ["session/fork", "agentCapabilities.sessionCapabilities.fork", advertised.forkSession],
    ["session/delete", "agentCapabilities.sessionCapabilities.delete", advertised.deleteSession],
    ["session/list", "agentCapabilities.sessionCapabilities.list", advertised.listSessions],
    ["logout", "agentCapabilities.auth.logout", logoutSupported],
  ] as const;
  const registered: string[] = [];
  for (const [method, capability, isAdvertised] of conditional)
    if (!isAdvertised) {
      app.onRequest(
        method,
        (params: unknown) => params,
        ({ client }) => {
          diagnostic("acp", "warning", "acp.method.not_advertised", {
            connectionId: core.connectionId,
            rpcRequestId: String(client.requestId),
            method,
            capability,
          });
          throw new RequestError(
            -32601,
            `Method not found: ${method} is unavailable because this agent's initialize response does not advertise ${capability}; check agentCapabilities before calling it`,
            { method, capability },
          );
        },
      );
      registered.push(method);
    }
  return registered;
}

/** Registers initialize, authenticate and logout. */
export function registerConnection(
  app: AgentApp,
  deps: Readonly<{
    core: Pick<AdapterCore, "connectionId" | "signal">;
    gate: ConnectionGate & Readonly<{ state: GateState }>;
    agentInfo: { name: string; version: string; title?: string };
    advertised: Advertised;
    promptCapabilities:
      | AcpPromptCapabilities
      | (() => AcpPromptCapabilities | Promise<AcpPromptCapabilities>)
      | undefined;
    /** Ends every session opened under the previous credentials. */
    revokeSessions: () => Promise<void>;
  }>,
): readonly string[] {
  const { core, gate, advertised } = deps;
  const { connectionId } = core;
  const { state } = gate;
  const { auth } = state;
  app
    .onRequest("initialize", async ({ params, client }) => {
      if (state.initialized || state.initializing)
        throw RequestError.invalidRequest(undefined, "Connection already initialized");
      state.initializing = true;
      try {
        state.promptCapabilities = await advertisedPromptCapabilities(deps.promptCapabilities);
      } catch (error) {
        diagnostic("acp", "error", "acp.capabilities.failed", {
          connectionId,
          rpcRequestId: String(client.requestId),
          method: "initialize",
          error: diagnosticError(error),
          reason:
            "The host could not declare which prompt content its models accept; initialize refused so nothing is advertised falsely",
        });
        throw RequestError.internalError(
          undefined,
          `Cannot determine which prompt content this agent accepts: ${error instanceof Error ? error.message : String(error)}. Fix the agent's model configuration, then initialize again.`,
        );
      } finally {
        state.initializing = false;
      }
      state.initialized = true;
      state.clientCapabilities = structuredClone(params.clientCapabilities ?? {});
      diagnostic("acp", "debug", "acp.capabilities.prompt", {
        connectionId,
        rpcRequestId: String(client.requestId),
        method: "initialize",
        promptCapabilities: state.promptCapabilities,
      });
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: deps.agentInfo,
        authMethods: auth.methods(state.clientCapabilities),
        agentCapabilities: {
          loadSession: advertised.loadSession,
          ...(auth.logoutSupported ? { auth: { logout: {} } } : {}),
          promptCapabilities: { ...state.promptCapabilities },
          mcpCapabilities: { http: true, sse: true, acp: true },
          sessionCapabilities: {
            close: {},
            ...(advertised.loadSession ? { resume: {} } : {}),
            ...(advertised.forkSession ? { fork: {} } : {}),
            ...(advertised.deleteSession ? { delete: {} } : {}),
            ...(advertised.additionalDirectories ? { additionalDirectories: {} } : {}),
            ...(advertised.listSessions ? { list: {} } : {}),
          },
        },
      };
    })
    .onRequest("authenticate", async ({ params, signal, client }) => {
      gate.requireInitialized();
      const cancellation = AbortSignal.any([signal, core.signal()]);
      const interaction = requestElicitation(
        client,
        state.clientCapabilities,
        cancellation,
        core.signal(),
      );
      const started = performance.now();
      const trace = {
        connectionId,
        rpcRequestId: String(client.requestId),
        method: "authenticate",
        authMethodId: params.methodId,
      };
      diagnostic("acp", "info", "acp.auth.started", trace);
      try {
        await auth.authenticate(params.methodId, cancellation, deps.revokeSessions, {
          elicitation: interaction.port,
        });
        diagnostic("acp", "info", "acp.auth.completed", {
          ...trace,
          durationMs: performance.now() - started,
        });
        return {};
      } catch (error) {
        const cause = diagnosticError(error);
        diagnostic("acp", "warning", "acp.auth.failed", {
          ...trace,
          durationMs: performance.now() - started,
          error: cause,
        });
        // Cancellation, unknown method IDs and a missing binding keep their own codes.
        if (cancellation.aborted || (error instanceof RequestError && error.code !== -32000))
          throw error;
        throw new RequestError(
          -32000,
          `Authentication with ${params.methodId} failed: ${String(cause.message)}`,
          { methodId: params.methodId, cause },
        );
      } finally {
        interaction.close();
      }
    })
    .onRequest("logout", async ({ signal }) => {
      gate.requireInitialized();
      await auth.logout(AbortSignal.any([signal, core.signal()]), deps.revokeSessions);
      return {};
    });
  return ["initialize", "authenticate", "logout"];
}
