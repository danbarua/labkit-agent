import {
  agent,
  RequestError,
  type AgentConnection,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type SessionInfoUpdate,
  type Stream,
} from "@agentclientprotocol/sdk";
import type { SessionOptions } from "@labkit-agent/core";
import type { Tool } from "@labkit-agent/core/host";
import { diagnostic, diagnosticError } from "@labkit-agent/core/logging";

import type { AcpAuth } from "./auth.ts";
import type { ClientElicitation } from "./client-elicitation.ts";
import type { ClientFiles } from "./client-files.ts";
import type { ClientTerminal } from "./client-terminal.ts";
import { expandCommand, type AcpCommand } from "./commands.ts";
import { acpMcpBridge, McpMessageSchema } from "./mcp-acp.ts";
import type { PlanSink } from "./plan.ts";
import {
  promptInput,
  requireAdvertisedContent,
  type AcpPromptCapabilities,
} from "./prompt-input.ts";
import { configProjection, registerConfiguration } from "./rpc/config.ts";
import { connectionGate, registerConnection, registerUnadvertised } from "./rpc/connection.ts";
import { adapterCore } from "./rpc/core.ts";
import { awaitConfigurationQuiet } from "./rpc/session.ts";
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

/** Self-contained JSON-RPC message for a failed turn; the structured failure travels as `data`. */
function turnFailureMessage(error: {
  message: string;
  classification?: string;
  operation?: { kind: string; toolName?: string; callId?: string };
}) {
  const operation = error.operation;
  const call = operation?.callId ? ` (call ${operation.callId})` : "";
  const target = operation?.toolName
    ? ` in ${operation.kind === "permission" ? "the permission request for " : ""}tool ${operation.toolName}${call}`
    : operation
      ? ` in ${operation.kind}`
      : "";
  const reason = /[.!?]$/.test(error.message) ? error.message : `${error.message}.`;
  const next =
    operation?.kind === "tool" || operation?.kind === "permission"
      ? " The session stays open; send another prompt to continue."
      : "";
  return `Agent turn failed${target}${error.classification ? ` [${error.classification}]` : ""}: ${reason}${next}`;
}

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
  app
    .onRequest("mcp/message", McpMessageSchema, ({ params, signal }) => {
      gate.requireInitialized();
      return mcpBridge.request(params, signal);
    })
    .onNotification("mcp/message", McpMessageSchema, ({ params }) => mcpBridge.notify(params));
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
  registerConfiguration(app, {
    core,
    gate,
    lookup: registry.lookup,
    isCurrent: registry.isCurrent,
    updates,
  });
  app
    .onRequest("session/prompt", async ({ params, client, signal }) => {
      const started = performance.now();
      const trace = {
        connectionId,
        rpcRequestId: String(client.requestId),
        sessionId: params.sessionId,
        method: "session/prompt",
      };
      diagnostic("acp", "info", "acp.prompt.received", { ...trace, count: params.prompt.length });
      const entry = registry.lookup(params.sessionId);
      requireAdvertisedContent(params.prompt, gate.promptCapabilities(), trace);
      if (entry.busy) throw new RequestError(-32000, "Session already has an active prompt");
      await awaitConfigurationQuiet(entry, AbortSignal.any([signal, connection.signal]));
      if (!registry.isCurrent(params.sessionId, entry) || !entry.acceptingUpdates)
        throw new RequestError(-32000, "Session closed");
      if (entry.busy) throw new RequestError(-32000, "Session already has an active prompt");
      entry.busy = true;
      let finishPrompt!: () => void;
      entry.promptDone = new Promise((resolve) => {
        finishPrompt = resolve;
      });
      const controller = new AbortController();
      entry.promptController = controller;
      entry.promptRpcRequestId = String(client.requestId);
      const promptSignal = AbortSignal.any([signal, controller.signal, connection.signal]);
      let admitted = false;
      let aborted = false;
      const abort = () => {
        aborted = true;
        if (admitted) void entry.runtime.fire({ type: "abort" });
      };
      promptSignal.addEventListener("abort", abort, { once: true });
      try {
        const input = await promptInput(
          expandCommand(params.prompt, entry.commands),
          entry.cwd,
          entry.persistence,
          entry.runtime.snapshot.durable.conversation.sessionId,
          promptSignal,
          entry.runtime.model?.capabilities.media ?? [],
          entry.additionalDirectories,
        );
        promptSignal.throwIfAborted();
        const turn = entry.runtime.input(input);
        admitted = true;
        if (promptSignal.aborted) abort();
        const receipt = await turn.accepted;
        if (receipt.kind === "failed")
          throw new RequestError(-32000, receipt.error.message, receipt.error);
        if (receipt.kind !== "accepted")
          throw new RequestError(-32000, `Prompt admission ${receipt.kind}`, receipt);
        diagnostic("acp", "info", "acp.prompt.admitted", {
          ...trace,
          revision: entry.runtime.snapshot.durable.revision,
          provider: entry.runtime.snapshot.durable.policy?.provider,
        });
        const result = await turn.settled;
        diagnostic(
          "acp",
          result.kind === "terminal" && result.record.outcome.kind === "failed"
            ? "warning"
            : "info",
          "acp.prompt.settled",
          {
            ...trace,
            ...(result.kind === "terminal"
              ? { turnId: result.turnId, outcome: result.record.outcome.kind }
              : { outcome: result.kind }),
            durationMs: performance.now() - started,
          },
        );
        updates.observe(entry, client, entry.runtime.snapshot);
        updates.refreshInfo(entry, client);
        await core.flushed();
        if (aborted || result.kind === "closed") return { stopReason: "cancelled" };
        if (result.kind !== "terminal")
          throw new RequestError(-32000, result.error.message, result.error);
        const outcome = result.record.outcome;
        if (outcome.kind === "failed") {
          if (outcome.error.providerStop?.category === "token_limit")
            return { stopReason: "max_tokens", _meta: { "labkit.dev/failure": outcome.error } };
          if (
            outcome.error.classification === "permission_refused" ||
            outcome.error.providerStop?.category === "refusal"
          )
            return { stopReason: "refusal", _meta: { "labkit.dev/failure": outcome.error } };
          throw new RequestError(-32000, turnFailureMessage(outcome.error), outcome.error);
        }
        return {
          stopReason:
            outcome.kind === "aborted"
              ? "cancelled"
              : outcome.kind === "exhausted"
                ? "max_turn_requests"
                : "end_turn",
        };
      } catch (error) {
        diagnostic(
          "acp",
          promptSignal.aborted ? "info" : "error",
          promptSignal.aborted ? "acp.prompt.cancelled" : "acp.prompt.failed",
          {
            ...trace,
            outcome: promptSignal.aborted ? "cancelled" : "failed",
            durationMs: performance.now() - started,
            error: diagnosticError(error),
          },
        );
        if (promptSignal.aborted) return { stopReason: "cancelled" };
        throw error;
      } finally {
        promptSignal.removeEventListener("abort", abort);
        controller.abort(); // Release pending elicitation UI after this prompt settles.
        entry.promptController = undefined;
        entry.promptRpcRequestId = undefined;
        entry.busy = false;
        finishPrompt();
        updates.resetTurn(entry);
      }
    })
    .onNotification("session/cancel", async ({ params }) => {
      diagnostic("acp", "info", "acp.prompt.cancel.requested", {
        connectionId,
        sessionId: params.sessionId,
      });
      const entry = registry.lookup(params.sessionId, true);
      entry.promptController?.abort();
    });
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
