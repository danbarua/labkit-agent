import {
  agent,
  type AgentConnection,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type SessionInfoUpdate,
  type Stream,
} from "@agentclientprotocol/sdk";
import type { SessionOptions } from "@labkit-agent/core";
import type { Tool } from "@labkit-agent/core/host";
import { diagnostic } from "@labkit-agent/core/logging";

import type { AcpAuth } from "./auth.ts";
import type { ClientElicitation } from "./client-elicitation.ts";
import type { ClientFiles } from "./client-files.ts";
import type { ClientTerminal } from "./client-terminal.ts";
import type { AcpCommand } from "./commands.ts";
import { acpMcpBridge } from "./mcp-acp.ts";
import type { PlanSink } from "./plan.ts";
import type { AcpPromptCapabilities } from "./prompt-input.ts";
import { configProjection, registerConfiguration } from "./rpc/config.ts";
import { connectionGate, registerConnection, registerUnadvertised } from "./rpc/connection.ts";
import { adapterCore } from "./rpc/core.ts";
import { registerMcpBridge } from "./rpc/mcp.ts";
import { registerPrompt } from "./rpc/prompt.ts";
import { registerSessionLifecycle, sessionRegistry } from "./rpc/sessions.ts";
import { sessionUpdates } from "./rpc/updates.ts";
import type { AcpConfigBinding } from "./session-config.ts";
import type { AcpUsageBinding } from "./session-usage.ts";
import type { AcpToolContent } from "./tool-content.ts";

export type SessionOptionsContext = Readonly<{
  cwd: string;
  additionalDirectories?: readonly string[];
  sessionId?: string;
  mcpTools?: ReadonlyMap<string, Tool>;
  clientFiles?: ClientFiles;
  elicitation?: ClientElicitation;
  terminal?: ClientTerminal;
  publishPlan?: PlanSink;
  /** Replace this session’s command catalog; admitted prompts retain their expanded text. */
  publishCommands?: (commands: readonly AcpCommand[]) => void;
  signal: AbortSignal;
}>;

export type AcpSessionOptions = SessionOptions & {
  config?: readonly AcpConfigBinding[];
  commands?: readonly AcpCommand[];
  usage?: AcpUsageBinding;
  toolContent?: ReadonlyMap<string, AcpToolContent>;
  /** Persist host metadata after runtime initialization, before visible lifecycle publication. */
  onReady?: (sessionId: string, signal: AbortSignal) => void | Promise<void>;
};

export type AcpOptions = Readonly<{
  auth?: AcpAuth;
  /** Bind tools to cwd without changing process.cwd(). On load, validate cwd against saved ownership. */
  sessionOptions: (
    context: SessionOptionsContext,
  ) => AcpSessionOptions | Promise<AcpSessionOptions>;
  /** Enable only when sessionOptions can resolve compatible persistence/configuration for saved IDs. */
  loadSession?: boolean;
  /** Experimental session/fork; requires loadSession and compatible child persistence lookup. */
  forkSession?: boolean;
  additionalDirectories?: boolean;
  /** End persisted lifetime; return only after deletion commits. cwd is supplied for live sessions. */
  deleteSession?: (
    params: { sessionId: string; cwd?: string },
    signal: AbortSignal,
  ) => void | Promise<void>;
  /** Discovery only: do not restore sessions or read blob bytes. */
  listSessions?: (
    params: ListSessionsRequest,
    signal: AbortSignal,
  ) => ListSessionsResponse | Promise<ListSessionsResponse>;
  /** Read persisted display metadata. Errors and pending replies never block session execution. */
  sessionInfo?: (
    params: { sessionId: string; cwd: string },
    signal: AbortSignal,
  ) => SessionInfoUpdate | undefined | Promise<SessionInfoUpdate | undefined>;
  agentInfo?: { name: string; version: string; title?: string };
  /**
   * Prompt content the bound models accept, resolved once per initialize. Omitted flags are not
   * advertised, and prompts carrying unadvertised content are refused before admission.
   */
  promptCapabilities?:
    AcpPromptCapabilities | (() => AcpPromptCapabilities | Promise<AcpPromptCapabilities>);
}>;

/** One connection owns its runtimes; persistence and credentials remain caller-owned. */
export function connectAcp(stream: Stream, options: AcpOptions) {
  const connectionId = crypto.randomUUID();
  let closing = false;
  const gate = connectionGate(options.auth, () => closing);
  const loadSession = options.loadSession === true;
  const forkSession = options.forkSession === true;
  if (forkSession && !loadSession) throw new Error("ACP forking requires loadSession");
  const agentInfo = { ...(options.agentInfo ?? { name: "labkit-agent", version: "0.1.0" }) };
  let connection: AgentConnection;
  const core = adapterCore({
    connectionId,
    signal: () => connection.signal,
    isClosing: () => closing,
    close: (e) => connection.close(e),
  });
  const mcpBridge = acpMcpBridge(core.signal);
  const registry = sessionRegistry(core, gate);
  const config = configProjection(core);
  const updates = sessionUpdates(core, registry.current, options.sessionInfo, config.project);
  const app = agent();
  const advertised = {
    loadSession,
    forkSession,
    deleteSession: !!options.deleteSession,
    listSessions: !!options.listSessions,
    additionalDirectories: !!options.additionalDirectories,
  };
  registerUnadvertised(app, core, advertised, gate.logoutSupported);
  registerConnection(app, {
    core,
    gate,
    agentInfo,
    advertised,
    promptCapabilities: options.promptCapabilities,
    revokeSessions: registry.revokeAll,
  });
  registerMcpBridge(app, { gate, bridge: mcpBridge });
  registerSessionLifecycle(app, {
    core,
    gate,
    registry,
    updates,
    config,
    mcpBridge,
    sessionOptions: options.sessionOptions,
    additionalDirectories: advertised.additionalDirectories,
    deleteSession: options.deleteSession,
    listSessions: options.listSessions,
  });
  registerConfiguration(app, { core, gate, registry, updates });
  registerPrompt(app, { core, gate, registry, updates });
  connection = app.connect(stream);
  diagnostic("acp", "info", "acp.connection.opened", { connectionId });
  const closed = connection.closed.then(async () => {
    diagnostic("acp", "info", "acp.connection.closing", { connectionId, count: registry.size() });
    closing = true;
    await registry.shutdown();
  });
  return {
    connection,
    closed,
    async close() {
      connection.close();
      await closed;
    },
  };
}
