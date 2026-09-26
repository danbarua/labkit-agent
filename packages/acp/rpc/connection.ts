import {
  RequestError,
  type ClientCapabilities,
  type InitializeResponse,
} from "@agentclientprotocol/sdk";
import type { AuthMethod } from "@agentclientprotocol/sdk";
import { diagnostic, diagnosticError } from "@labkit-agent/core/logging";

import type { ClientElicitation } from "../client-elicitation.ts";
import {
  advertisedPromptCapabilities,
  type AcpPromptCapabilities,
  type AdvertisedPromptCapabilities,
} from "../prompt-input.ts";

// Type for the return value of bindAuth
type BoundAuth = Readonly<{
  logoutSupported: boolean;
  methods(capabilities: ClientCapabilities): readonly AuthMethod[];
  requireAccess(): void;
  authenticate(
    methodId: string,
    signal: AbortSignal,
    before: () => Promise<void>,
    context?: { elicitation: ClientElicitation },
  ): Promise<void>;
  logout(signal: AbortSignal, before: () => Promise<void>): Promise<void>;
}>;

export type ConnectionGate = Readonly<{
  requireInitialized(): void;
  requireAccess(): void;
  clientCapabilities(): ClientCapabilities;
  promptCapabilities(): AdvertisedPromptCapabilities;
  logoutSupported: boolean;
  /** @internal */
  _setInitialized(value: boolean): void;
  /** @internal */
  _setInitializing(value: boolean): void;
  /** @internal */
  _setPromptCapabilities(value: AdvertisedPromptCapabilities): void;
  /** @internal */
  _setClientCapabilities(value: ClientCapabilities): void;
  /** @internal */
  _isInitializing(): boolean;
  /** @internal */
  _isInitialized(): boolean;
}>;

export function connectionGate(
  auth: BoundAuth | undefined,
  isClosing: () => boolean,
): ConnectionGate {
  let initialized = false;
  let initializing = false;
  let capturedPromptCapabilities: AdvertisedPromptCapabilities = {
    image: false,
    audio: false,
    embeddedContext: false,
  };
  let capturedClientCapabilities: ClientCapabilities = {};

  return {
    requireInitialized() {
      if (!initialized) throw new RequestError(-32002, "Initialize the connection first");
      if (isClosing()) throw new RequestError(-32000, "Connection closed");
    },
    requireAccess() {
      if (!initialized) throw new RequestError(-32002, "Initialize the connection first");
      if (isClosing()) throw new RequestError(-32000, "Connection closed");
      if (auth) auth.requireAccess();
    },
    clientCapabilities() {
      return capturedClientCapabilities;
    },
    promptCapabilities() {
      return capturedPromptCapabilities;
    },
    logoutSupported: !!auth?.logoutSupported,
    _setInitializing(value) {
      initializing = value;
    },
    _isInitializing() {
      return initializing;
    },
    _setInitialized(value) {
      initialized = value;
    },
    _isInitialized() {
      return initialized;
    },
    _setPromptCapabilities(value) {
      capturedPromptCapabilities = value;
    },
    _setClientCapabilities(value) {
      capturedClientCapabilities = value;
    },
  };
}

export function registerUnadvertised(
  app: unknown,
  core: { connectionId: string },
  advertised: {
    loadSession: boolean;
    forkSession: boolean;
    deleteSession: boolean;
    listSessions: boolean;
    logout: boolean;
  },
): readonly string[] {
  const appTyped = app as {
    onRequest(
      method: string,
      schema: (p: unknown) => unknown,
      handler: (p: unknown) => unknown,
    ): unknown;
  };
  const conditional = [
    ["session/load", "agentCapabilities.loadSession", advertised.loadSession] as const,
    [
      "session/resume",
      "agentCapabilities.sessionCapabilities.resume",
      advertised.loadSession,
    ] as const,
    ["session/fork", "agentCapabilities.sessionCapabilities.fork", advertised.forkSession] as const,
    [
      "session/delete",
      "agentCapabilities.sessionCapabilities.delete",
      advertised.deleteSession,
    ] as const,
    [
      "session/list",
      "agentCapabilities.sessionCapabilities.list",
      advertised.listSessions,
    ] as const,
    ["logout", "agentCapabilities.auth.logout", advertised.logout] as const,
  ];

  const registered: string[] = [];
  for (const [method, capability, isAdvertised] of conditional) {
    if (!isAdvertised) {
      appTyped.onRequest(method, (params: unknown) => params, ((p: unknown) => {
        const { client } = p as { client: { requestId: unknown } };
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
      }) as (p: unknown) => unknown);
      registered.push(method);
    }
  }
  return registered;
}

export interface RegisterConnectionDeps {
  core: { connectionId: string };
  gate: ConnectionGate;
  agentInfo: Record<string, string>;
  buildInitializeResponse(
    clientCapabilities: ClientCapabilities,
    promptCapabilities: AdvertisedPromptCapabilities,
  ): InitializeResponse;
  promptCapabilities:
    | AcpPromptCapabilities
    | (() => AcpPromptCapabilities | Promise<AcpPromptCapabilities>)
    | undefined;
  revokeSessions(): Promise<void>;
  connectionId: string;
  clientElicitation(
    client: { requestId: unknown },
    capabilities: ClientCapabilities,
    signal: AbortSignal,
    connectionSignal: AbortSignal,
  ): { port: ClientElicitation; close(): void };
  getConnection(): { signal: AbortSignal; close(error?: Error): void };
  auth: BoundAuth | undefined;
  resetAuthLifetime(): void;
}

export function registerConnection(app: unknown, deps: RegisterConnectionDeps): readonly string[] {
  const appTyped = app as {
    onRequest(
      method: string,
      schema: (p: unknown) => unknown,
      handler: (p: unknown) => unknown,
    ): unknown;
  };
  const {
    gate,
    buildInitializeResponse,
    promptCapabilities,
    revokeSessions,
    connectionId,
    clientElicitation,
    getConnection,
    auth,
    resetAuthLifetime,
  } = deps;

  const registered: string[] = [];

  appTyped.onRequest("initialize", (params: unknown) => params, (async (
    p: unknown,
  ): Promise<InitializeResponse> => {
    const { params, client } = p as {
      params: { clientCapabilities?: ClientCapabilities };
      client: { requestId: unknown };
    };
    if (gate._isInitialized() || gate._isInitializing()) {
      throw RequestError.invalidRequest(undefined, "Connection already initialized");
    }
    gate._setInitializing(true);
    try {
      const caps = await advertisedPromptCapabilities(promptCapabilities);
      gate._setPromptCapabilities(caps);
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
      gate._setInitializing(false);
    }
    gate._setInitialized(true);
    const capturedClientCapabilities = structuredClone(params.clientCapabilities ?? {});
    gate._setClientCapabilities(capturedClientCapabilities);
    diagnostic("acp", "debug", "acp.capabilities.prompt", {
      connectionId,
      rpcRequestId: String(client.requestId),
      method: "initialize",
      promptCapabilities: gate.promptCapabilities(),
    });
    return buildInitializeResponse(capturedClientCapabilities, gate.promptCapabilities());
  }) as (p: unknown) => unknown);
  registered.push("initialize");

  appTyped.onRequest("authenticate", (params: unknown) => params, (async (
    p: unknown,
  ): Promise<Record<string, unknown>> => {
    const { params, signal, client } = p as {
      params: { methodId: string };
      signal: AbortSignal;
      client: { requestId: unknown };
    };
    gate.requireInitialized();
    const connection = getConnection();
    const cancellation = AbortSignal.any([signal, connection.signal]);
    const interaction = clientElicitation(
      client,
      gate.clientCapabilities(),
      cancellation,
      connection.signal,
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
      if (!auth) throw RequestError.methodNotFound("authenticate");
      const closeForAuth = async () => {
        await revokeSessions();
        resetAuthLifetime();
      };
      await auth.authenticate(params.methodId, cancellation, closeForAuth, {
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
      if (cancellation.aborted || (error instanceof RequestError && error.code !== -32000))
        throw error;
      throw new RequestError(
        -32000,
        `Authentication with ${params.methodId} failed: ${String(cause.message)}`,
        {
          methodId: params.methodId,
          cause,
        },
      );
    } finally {
      interaction.close();
    }
  }) as (p: unknown) => unknown);
  registered.push("authenticate");

  if (gate.logoutSupported) {
    appTyped.onRequest("logout", (params: unknown) => params, (async (
      p: unknown,
    ): Promise<Record<string, unknown>> => {
      const { signal } = p as { signal: AbortSignal };
      gate.requireInitialized();
      const connection = getConnection();
      if (!auth) throw RequestError.methodNotFound("logout");
      const closeForAuth = async () => {
        await revokeSessions();
        resetAuthLifetime();
      };
      await auth.logout(AbortSignal.any([signal, connection.signal]), closeForAuth);
      return {};
    }) as (p: unknown) => unknown);
    registered.push("logout");
  }

  return registered;
}
