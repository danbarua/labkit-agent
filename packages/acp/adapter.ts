import { isAbsolute, resolve } from "node:path";

import {
  agent,
  PROTOCOL_VERSION,
  RequestError,
  type AgentConnection,
  type AgentContext,
  type ClientCapabilities,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type NewSessionRequest,
  type SessionInfoUpdate,
  type Stream,
} from "@agentclientprotocol/sdk";
import { createSession, restoreSession, SessionNotFoundError } from "@labkit-agent/core";
import type { Tool } from "@labkit-agent/core/host";
import { diagnostic, diagnosticError } from "@labkit-agent/core/logging";
import type { Policy } from "@labkit-agent/core/policy";

import { bindAuth, type AcpAuth } from "./auth.ts";
import {
  clientElicitation,
  requestElicitation,
  type ClientElicitation,
} from "./client-elicitation.ts";
import { clientFiles, type ClientFiles } from "./client-files.ts";
import { clientTerminal, type ClientTerminal } from "./client-terminal.ts";
import { availableCommands, bindCommands, expandCommand, type AcpCommand } from "./commands.ts";
import { acpMcpBridge, McpMessageSchema } from "./mcp-acp.ts";
import { mcpConnections, McpOpenError } from "./mcp.ts";
import { PlanEntriesSchema, type PlanSink } from "./plan.ts";
import {
  advertisedPromptCapabilities,
  promptInput,
  requireAdvertisedContent,
  type AcpPromptCapabilities,
  type AdvertisedPromptCapabilities,
} from "./prompt-input.ts";
import { adapterCore } from "./rpc/core.ts";
import { afterPrompt, awaitConfigurationQuiet, type Session } from "./rpc/session.ts";
import { locatedTitle, sessionUpdates, toolEvidence } from "./rpc/updates.ts";
import {
  bindConfig,
  configPatch,
  configState,
  unlistedValues,
  waitForBoundary,
  type AcpConfigBinding,
} from "./session-config.ts";
import { usageReporter, type AcpUsageBinding } from "./session-usage.ts";
import { mcpToolContent, type AcpToolContent } from "./tool-content.ts";

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

/** Why a client permission answer cannot be honored, or undefined when it names an offered choice. */
function permissionAnswerProblem(response: unknown, offered: readonly { optionId: string }[]) {
  const outcome: unknown =
    typeof response === "object" && response !== null && "outcome" in response
      ? response.outcome
      : undefined;
  if (typeof outcome !== "object" || outcome === null || !("outcome" in outcome))
    return "the result has no outcome object";
  if (outcome.outcome === "cancelled") return undefined;
  if (outcome.outcome !== "selected")
    return `outcome ${JSON.stringify(outcome.outcome)?.slice(0, 80)} is neither "selected" nor "cancelled"`;
  const optionId = "optionId" in outcome ? outcome.optionId : undefined;
  if (typeof optionId !== "string") return "a selected outcome must name an optionId";
  if (!offered.some((option) => option.optionId === optionId))
    return `optionId ${JSON.stringify(optionId.slice(0, 80))} was not offered`;
  return undefined;
}
/** Raw journal tool outcomes retain failures even when policy projects them as tool text. */
/** One connection owns its runtimes; persistence and credentials remain caller-owned. */
export function connectAcp(stream: Stream, options: AcpOptions) {
  const connectionId = crypto.randomUUID();
  const sessions = new Map<string, Session>();
  const auth = bindAuth(options.auth);
  let authLifetime = new AbortController();
  const opening = new Set<string>();
  const sessionOptions = options.sessionOptions;
  const loadSession = options.loadSession === true;
  const forkSession = options.forkSession === true;
  if (forkSession && !loadSession) throw new Error("ACP forking requires loadSession");
  const agentInfo = { ...(options.agentInfo ?? { name: "labkit-agent", version: "0.1.0" }) };
  const resources = new Set<() => Promise<void>>();
  const borrowedParents = new Set<string>();
  const deleting = new Set<string>();
  let initialized = false;
  let initializing = false;
  let promptCapabilities: AdvertisedPromptCapabilities = {
    image: false,
    audio: false,
    embeddedContext: false,
  };
  let clientCapabilities: ClientCapabilities = {};
  let closing = false;
  let connection: AgentConnection;
  const mcpBridge = acpMcpBridge(() => connection.signal);
  const core = adapterCore({
    connectionId,
    signal: () => connection.signal,
    isClosing: () => closing,
    close: (e) => connection.close(e),
  });
  const requireInitialized = () => {
    if (!initialized) throw new RequestError(-32002, "Initialize the connection first");
    if (closing) throw new RequestError(-32000, "Connection closed");
  };
  const updates = sessionUpdates(
    core,
    () => connection.signal,
    () => closing,
    (id) => sessions.get(id),
    options.sessionInfo,
  );
  const requireAccess = () => {
    requireInitialized();
    auth.requireAccess();
  };
  const lookup = (id: string, cleanup = false) => {
    requireInitialized();
    if (!cleanup) auth.requireAccess();
    if (deleting.has(id)) throw RequestError.invalidParams(undefined, "Session is being deleted");
    if (borrowedParents.has(id))
      throw RequestError.invalidParams(undefined, "Session is being forked privately");
    const session = sessions.get(id);
    if (!session) {
      diagnostic("acp", "warning", "acp.session.not_open", { connectionId, sessionId: id });
      throw RequestError.invalidParams(
        { sessionId: id },
        `Session ${id} is not open on this connection (never opened, closed or deleted); open it with session/load or session/resume before using it`,
      );
    }
    return session;
  };
  /** Additional roots are opt-in; refuse them rather than silently dropping workspace roots. */
  const requireRootsAdvertised = (
    requested: readonly string[] | null | undefined,
    trace: Record<string, unknown>,
  ) => {
    if (!requested?.length || options.additionalDirectories) return;
    diagnostic("acp", "warning", "acp.session.additional_directories.refused", {
      ...trace,
      count: requested.length,
      reason: "sessionCapabilities.additionalDirectories is not advertised",
    });
    throw RequestError.invalidParams(
      { capability: "sessionCapabilities.additionalDirectories" },
      "additionalDirectories was refused because this agent does not advertise sessionCapabilities.additionalDirectories; resend without additionalDirectories to use cwd as the only workspace root",
    );
  };
  const logUnlisted = (
    config: readonly AcpConfigBinding[],
    policy: Policy | undefined,
    fields: Record<string, unknown>,
  ) => {
    for (const { configId, value } of unlistedValues(config, policy))
      diagnostic("acp", "info", "acp.session.config.unlisted_value", {
        ...fields,
        configId,
        value,
        consequence:
          "selector shows the value as an extra saved choice; choosing another value patches policy",
      });
  };
  async function open(
    params: NewSessionRequest & { sessionId?: string },
    client: AgentContext,
    signal: AbortSignal,
    replay = true,
    visible = true,
  ) {
    const started = performance.now();
    const trace = {
      connectionId,
      rpcRequestId: String(client.requestId),
      method: params.sessionId ? (replay ? "session/load" : "session/resume") : "session/new",
      sessionId: params.sessionId,
      cwd: params.cwd,
      replay,
    };
    diagnostic("acp", "info", "acp.session.open.started", trace);
    requireAccess();
    if (!isAbsolute(params.cwd))
      throw RequestError.invalidParams(undefined, "cwd must be absolute");
    requireRootsAdvertised(params.additionalDirectories, trace);
    const additionalDirectories = Object.freeze([...new Set(params.additionalDirectories ?? [])]);
    if (
      (params.additionalDirectories?.length ?? 0) > 32 ||
      additionalDirectories.some((path) => !isAbsolute(path) || path.includes("\0"))
    )
      throw RequestError.invalidParams(
        undefined,
        "Additional directories must be absolute (at most 32)",
      );
    if (
      params.sessionId &&
      (sessions.has(params.sessionId) ||
        opening.has(params.sessionId) ||
        deleting.has(params.sessionId))
    )
      throw RequestError.invalidParams(undefined, "Session is already loaded");
    const id = params.sessionId;
    if (id) opening.add(id);
    signal = AbortSignal.any([signal, connection.signal, authLifetime.signal]);
    let dispose: (() => Promise<void>) | undefined;
    let published = false;
    let initializedId: string | undefined;
    let cancelOpening: (() => void) | undefined;
    let boundSessionId: string | undefined;
    let commandEntry: Session | undefined;
    let commandPublisherActive = true;
    let pendingCommands: readonly AcpCommand[] | undefined;
    const sessionIdentity = () => {
      if (!boundSessionId || !sessions.has(boundSessionId)) throw new Error("Session is not open");
      return boundSessionId;
    };
    const elicitation = clientElicitation(
      client,
      clientCapabilities,
      sessionIdentity,
      connection.signal,
      () => sessions.get(sessionIdentity())?.promptController?.signal ?? AbortSignal.abort(),
    );
    // session/new learns its ID only after MCP opens; call diagnostics read it from here later.
    const mcpContext: { sessionId?: string } = { sessionId: id };
    try {
      let mcp: ReturnType<typeof mcpConnections>;
      try {
        mcp = mcpConnections(
          params.mcpServers,
          params.cwd,
          additionalDirectories,
          (serverId) => mcpBridge.transport(serverId, client),
          elicitation.port,
          mcpContext,
        );
      } catch (error) {
        throw RequestError.invalidParams(
          undefined,
          error instanceof Error ? error.message : "Invalid MCP servers",
        );
      }
      const cleanup = async () => {
        commandPublisherActive = false;
        commandEntry?.usage?.close();
        elicitation.close();
        try {
          await mcp.close();
        } finally {
          resources.delete(cleanup);
        }
      };
      dispose = cleanup;
      resources.add(cleanup);
      cancelOpening = () => {
        void cleanup();
      };
      signal.addEventListener("abort", cancelOpening, { once: true });
      let mcpTools: ReadonlyMap<string, Tool>;
      try {
        mcpTools = await mcp.open(signal);
      } catch (error) {
        throw RequestError.invalidParams(
          error instanceof McpOpenError
            ? { serverName: error.serverName, stage: error.stage }
            : undefined,
          error instanceof Error ? error.message : "MCP connection failed",
        );
      }
      const filesystem = clientFiles(
        client,
        clientCapabilities,
        sessionIdentity,
        connection.signal,
      );
      const terminal =
        clientCapabilities.terminal === true
          ? clientTerminal(
              client,
              sessionIdentity,
              params.cwd,
              connection.signal,
              updates.terminalAttached(client, sessions, sessionIdentity),
            )
          : undefined;
      const original = await sessionOptions({
        cwd: params.cwd,
        additionalDirectories,
        ...(id ? { sessionId: id } : {}),
        mcpTools,
        clientFiles: filesystem,
        elicitation: elicitation.port,
        publishCommands: (commands) => {
          try {
            if (!commandPublisherActive || signal.aborted || connection.signal.aborted || closing)
              throw new Error("Cannot update commands for a closed ACP session");
            const next = bindCommands(commands);
            if (!commandEntry) {
              pendingCommands = next;
              return;
            }
            const sessionId = commandEntry.runtime.snapshot.durable.conversation.sessionId;
            if (sessions.get(sessionId) !== commandEntry || !commandEntry.acceptingUpdates)
              throw new Error("Cannot update commands for an unpublished ACP session");
            commandEntry.commands = next;
            core.send(client, sessionId, {
              sessionUpdate: "available_commands_update",
              availableCommands: availableCommands(next),
            });
            diagnostic("acp", "info", "acp.commands.updated", {
              connectionId,
              sessionId,
              count: next.length,
              names: next.map((command) => command.name),
            });
          } catch (error) {
            diagnostic("acp", "warning", "acp.commands.rejected", {
              connectionId,
              sessionId: boundSessionId ?? id,
              reason: "Command catalog unchanged; update was invalid or session is no longer open",
              error: diagnosticError(error),
            });
            throw error;
          }
        },
        publishPlan: (entries, operationSignal) => {
          if (operationSignal.aborted || connection.signal.aborted) return;
          const sessionId = sessionIdentity();
          if (!sessions.get(sessionId)?.acceptingUpdates) return;
          core.send(client, sessionId, {
            sessionUpdate: "plan",
            entries: PlanEntriesSchema.parse(entries),
          });
        },
        ...(terminal ? { terminal } : {}),
        signal,
      });
      const tools = new Map(original.bindings.tools);
      for (const [name, tool] of mcpTools) {
        if (tools.has(name) && tools.get(name) !== tool)
          throw new Error("MCP tool collides with a bound tool");
        tools.set(name, tool);
      }
      const renderers = new Map(original.toolContent);
      for (const name of mcpTools.keys())
        if (!renderers.has(name)) renderers.set(name, mcpToolContent);
      for (const [name, render] of renderers)
        if (!tools.has(name) || typeof render !== "function")
          throw new Error(`Tool content renderer requires a bound tool and a function: ${name}`);
      const subscribers = { ...original.bindings };
      requireAccess();
      signal.throwIfAborted();
      if (closing) throw new Error("Connection closed");
      const entry = {
        promptRpcRequestId: undefined as string | undefined,
        cwd: params.cwd,
        additionalDirectories,
        mcpServers: structuredClone(params.mcpServers),
        dispose: cleanup,
        persistence: original.persistence,
        busy: false,
        promptDone: Promise.resolve(),
        configurationTail: Promise.resolve(),
        config: bindConfig(
          original.config,
          clientCapabilities.session?.configOptions?.boolean != null,
        ),
        commands: bindCommands(original.commands),
        configSignature: "",
        infoSignature: "",
        infoEpoch: 0,
        modeId: undefined as string | undefined,
        acceptingUpdates: false,
        revision: 0,
        streamed: new Map(),
        terminals: new Map<string, string[]>(),
        toolCards: new Map(),
      };
      const bound: SessionOptions = {
        ...original,
        configuration: {
          ...original.configuration,
          agents: new Map(
            [...original.configuration.agents].map(([name, agent]) => [
              name,
              { ...agent, tools: [...new Set([...(agent.tools ?? []), ...mcpTools.keys()])] },
            ]),
          ),
          policy: {
            ...original.configuration.policy,
            permissions: original.configuration.policy?.permissions ?? "ask",
          },
        },
        bindings: {
          ...original.bindings,
          tools,
          ...updates.bindings(entry, client, renderers, subscribers, boundSessionId),
          requestPermission: async (request, permissionSignal) => {
            await core.flushed();
            if (permissionSignal.aborted || closing) return { outcome: { outcome: "cancelled" } };
            const started = performance.now();
            const trace = {
              connectionId,
              rpcRequestId: entry.promptRpcRequestId,
              sessionId: request.sessionId,
              toolCallId: request.toolCall.toolCallId,
              toolName: request.toolCall.title,
              paths: request.toolCall.locations?.map((location) => location.path),
              optionIds: request.options.map((option) => option.optionId),
            };
            diagnostic("acp", "info", "acp.permission.waiting", {
              ...trace,
              reason: "client_decision",
            });
            return new Promise((resolve, reject) => {
              const abort = () => {
                diagnostic("acp", "info", "acp.permission.cancelled", {
                  ...trace,
                  durationMs: performance.now() - started,
                });
                resolve({ outcome: { outcome: "cancelled" } });
              };
              permissionSignal.addEventListener("abort", abort, { once: true });
              const { locations, ...toolCall } = request.toolCall;
              void client
                .request(
                  "session/request_permission",
                  {
                    sessionId: request.sessionId!,
                    toolCall: {
                      ...toolCall,
                      // Some clients show only the title in their approval picker.
                      // Use validated locations, never arbitrary tool argument contents.
                      title: locatedTitle(toolCall.title, locations),
                      ...(locations ? { locations: [...locations] } : {}),
                    },
                    options: [...request.options],
                  },
                  { cancellationSignal: permissionSignal },
                )
                .then(
                  (response) => {
                    const problem = permissionAnswerProblem(response, request.options);
                    if (problem) {
                      const reason = `The client answered session/request_permission for ${request.toolCall.title} with an invalid result: ${problem}`;
                      diagnostic("acp", "warning", "acp.permission.invalid_response", {
                        ...trace,
                        reason,
                        consequence: "Tool does not run; the turn fails",
                        durationMs: performance.now() - started,
                      });
                      reject(
                        new Error(
                          `${reason}. The tool did not run. Answer {"outcome":"cancelled"} or {"outcome":"selected","optionId":…} with one of: ${request.options.map((option) => option.optionId).join(", ")}.`,
                        ),
                      );
                      return;
                    }
                    diagnostic("acp", "info", "acp.permission.resolved", {
                      ...trace,
                      response: response,
                      durationMs: performance.now() - started,
                    });
                    resolve(response);
                  },
                  (error) => {
                    diagnostic(
                      "acp",
                      permissionSignal.aborted ? "debug" : "error",
                      "acp.permission.failed",
                      {
                        ...trace,
                        durationMs: performance.now() - started,
                        error: diagnosticError(error),
                      },
                    );
                    reject(
                      new Error(
                        `The client failed session/request_permission for ${request.toolCall.title}: ${diagnosticError(error).message ?? "unknown client error"}. The tool did not run.`,
                        { cause: error },
                      ),
                    );
                  },
                )
                .finally(() => permissionSignal.removeEventListener("abort", abort));
            });
          },
        },
      };
      const runtime = id ? await restoreSession(bound, id) : await createSession(bound);
      if (closing || signal.aborted) {
        await runtime.close();
        throw new Error("Session opening cancelled");
      }
      const sessionId = runtime.snapshot.durable.conversation.sessionId;
      if (sessions.has(sessionId) || (!id && opening.has(sessionId)) || deleting.has(sessionId)) {
        await runtime.close();
        throw new Error("Duplicate session identity");
      }
      initializedId = sessionId;
      mcpContext.sessionId = sessionId;
      opening.add(sessionId);
      let configuration: ReturnType<typeof configState>;
      try {
        configuration = configState(entry.config, runtime.policy);
        if (visible && original.onReady)
          await waitForBoundary(Promise.resolve(original.onReady(sessionId, signal)), signal);
        signal.throwIfAborted();
        requireAccess();
      } catch (error) {
        await runtime.close();
        throw error;
      }
      entry.commands = pendingCommands ?? entry.commands;
      entry.configSignature = JSON.stringify(configuration);
      entry.modeId = configuration.modes?.currentModeId;
      logUnlisted(entry.config, runtime.policy, {
        ...trace,
        sessionId,
        revision: runtime.snapshot.durable.revision,
      });
      commandEntry = Object.assign(entry, { runtime });
      sessions.set(sessionId, commandEntry);
      entry.revision = runtime.snapshot.durable.revision;
      if (id && replay) {
        const durable = runtime.snapshot.durable;
        const state = durable.conversation;
        const evidence = toolEvidence(durable);
        updates.replay(client, id, state.context, `${id}/context`, evidence, renderers);
        state.log.forEach((record, index) => {
          updates.replay(
            client,
            id,
            record.messages,
            `${id}/history/${index}`,
            evidence,
            renderers,
          );
        });
      }
      const registry = runtime.registry;
      if (registry.kind === "pending_adoption")
        diagnostic("acp", "info", "acp.session.registry_pending", {
          ...trace,
          sessionId,
          revision: entry.revision,
          differences: registry.differences,
          consequence: "core journals the live registry before the next new work",
        });
      boundSessionId = sessionId;
      entry.acceptingUpdates = visible;
      published = true;
      if (visible && original.usage) {
        commandEntry.usage = usageReporter(
          original.usage,
          () => ({
            sessionId,
            cwd: params.cwd,
            snapshot: runtime.snapshot,
            model: runtime.model,
          }),
          (update) => {
            if (sessions.get(sessionId) === commandEntry && commandEntry?.acceptingUpdates)
              core.send(client, sessionId, update);
          },
          connectionId,
        );
      }
      if (visible) updates.refreshInfo(sessions.get(sessionId)!, client);
      if (visible && entry.commands.length)
        core.send(client, sessionId, {
          sessionUpdate: "available_commands_update",
          availableCommands: availableCommands(entry.commands),
        });
      await core.flushed();
      diagnostic("acp", "info", "acp.session.open.completed", {
        ...trace,
        sessionId,
        revision: entry.revision,
        registry: registry.kind,
        provider: runtime.policy?.provider,
        durationMs: performance.now() - started,
      });
      return { sessionId, ...configuration };
    } catch (error) {
      diagnostic(
        "acp",
        signal.aborted ? "info" : "error",
        signal.aborted ? "acp.session.open.cancelled" : "acp.session.open.failed",
        {
          ...trace,
          outcome: signal.aborted ? "cancelled" : "failed",
          durationMs: performance.now() - started,
          error: diagnosticError(error),
        },
      );
      if (error instanceof SessionNotFoundError)
        throw new RequestError(
          -32002,
          `Session ${error.sessionId} has no saved history in this workspace (never saved, or deleted); choose a session from session/list or start one with session/new`,
          { sessionId: error.sessionId },
        );
      throw error;
    } finally {
      if (cancelOpening) signal.removeEventListener("abort", cancelOpening);
      if (!published) {
        elicitation.close();
        await dispose?.();
      }
      if (id) opening.delete(id);
      if (initializedId) opening.delete(initializedId);
    }
  }
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
    const cancellation = AbortSignal.any([signal, connection.signal]);
    return afterPrompt(entry, cancellation, async () => {
      if (closing || sessions.get(id) !== entry || !entry.acceptingUpdates)
        throw new RequestError(-32000, "Session closed");
      requireAccess();
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
    }).catch((error) => {
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
  const closeForAuth = async () => {
    authLifetime.abort();
    authLifetime = new AbortController();
    const active = [...sessions.entries()];
    for (const [, entry] of active) {
      entry.usage?.close();
      entry.acceptingUpdates = false;
      entry.promptController?.abort();
    }
    await Promise.allSettled(
      active.map(async ([id, entry]) => {
        try {
          await entry.runtime.close();
        } finally {
          await entry.dispose();
          if (sessions.get(id) === entry) sessions.delete(id);
        }
      }),
    );
  };
  // A conditional method that initialize does not advertise is claimed by this earlier handler,
  // which answers -32601 before params, initialization, auth or session state are checked.
  const conditional = [
    ["session/load", "agentCapabilities.loadSession", loadSession],
    ["session/resume", "agentCapabilities.sessionCapabilities.resume", loadSession],
    ["session/fork", "agentCapabilities.sessionCapabilities.fork", forkSession],
    ["session/delete", "agentCapabilities.sessionCapabilities.delete", !!options.deleteSession],
    ["session/list", "agentCapabilities.sessionCapabilities.list", !!options.listSessions],
    ["logout", "agentCapabilities.auth.logout", auth.logoutSupported],
  ] as const;
  const app = agent();
  for (const [method, capability, advertised] of conditional)
    if (!advertised)
      app.onRequest(
        method,
        (params: unknown) => params,
        ({ client }) => {
          diagnostic("acp", "warning", "acp.method.not_advertised", {
            connectionId,
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
  app
    .onRequest("initialize", async ({ params, client }) => {
      if (initialized || initializing)
        throw RequestError.invalidRequest(undefined, "Connection already initialized");
      initializing = true;
      try {
        promptCapabilities = await advertisedPromptCapabilities(options.promptCapabilities);
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
        initializing = false;
      }
      initialized = true;
      clientCapabilities = structuredClone(params.clientCapabilities ?? {});
      diagnostic("acp", "debug", "acp.capabilities.prompt", {
        connectionId,
        rpcRequestId: String(client.requestId),
        method: "initialize",
        promptCapabilities,
      });
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentInfo,
        authMethods: auth.methods(clientCapabilities),
        agentCapabilities: {
          loadSession,
          ...(auth.logoutSupported ? { auth: { logout: {} } } : {}),
          promptCapabilities: { ...promptCapabilities },
          mcpCapabilities: { http: true, sse: true, acp: true },
          sessionCapabilities: {
            close: {},
            ...(loadSession ? { resume: {} } : {}),
            ...(forkSession ? { fork: {} } : {}),
            ...(options.deleteSession ? { delete: {} } : {}),
            ...(options.additionalDirectories ? { additionalDirectories: {} } : {}),
            ...(options.listSessions ? { list: {} } : {}),
          },
        },
      };
    })
    .onRequest("authenticate", async ({ params, signal, client }) => {
      requireInitialized();
      const cancellation = AbortSignal.any([signal, connection.signal]);
      const interaction = requestElicitation(
        client,
        clientCapabilities,
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
      requireInitialized();
      await auth.logout(AbortSignal.any([signal, connection.signal]), closeForAuth);
      return {};
    })
    .onRequest("mcp/message", McpMessageSchema, ({ params, signal }) => {
      requireInitialized();
      return mcpBridge.request(params, signal);
    })
    .onNotification("mcp/message", McpMessageSchema, ({ params }) => mcpBridge.notify(params))
    .onRequest("session/new", ({ params, client, signal }) => open(params, client, signal))
    .onRequest("session/load", async ({ params, client, signal }) => {
      const { sessionId: _, ...configuration } = await open(params, client, signal);
      return configuration;
    })
    .onRequest("session/resume", async ({ params, client, signal }) => {
      const { sessionId: _, ...configuration } = await open(
        { ...params, mcpServers: params.mcpServers ?? [] },
        client,
        signal,
        false,
      );
      return configuration;
    })
    .onRequest("session/fork", async ({ params, client, signal }) => {
      requireAccess();
      if (deleting.has(params.sessionId))
        throw RequestError.invalidParams(undefined, "Session is being deleted");
      if (borrowedParents.has(params.sessionId))
        throw RequestError.invalidParams(undefined, "Session is already being forked privately");
      if (!isAbsolute(params.cwd))
        throw RequestError.invalidParams(undefined, "cwd must be absolute");
      requireRootsAdvertised(params.additionalDirectories, {
        connectionId,
        rpcRequestId: String(client.requestId),
        method: "session/fork",
        sessionId: params.sessionId,
      });
      if (
        (params.additionalDirectories?.length ?? 0) > 32 ||
        params.additionalDirectories?.some((path) => !isAbsolute(path) || path.includes("\0"))
      )
        throw RequestError.invalidParams(
          undefined,
          "Additional directories must be absolute (at most 32)",
        );
      const cancellation = AbortSignal.any([signal, connection.signal]);
      const borrowed = !sessions.has(params.sessionId);
      let entry: Session | undefined;
      if (borrowed) borrowedParents.add(params.sessionId);
      try {
        if (borrowed)
          await waitForBoundary(
            open(
              { ...params, mcpServers: params.mcpServers ?? [] },
              client,
              cancellation,
              false,
              false,
            ),
            cancellation,
          );
        entry = sessions.get(params.sessionId);
        if (!entry) throw RequestError.invalidParams(undefined, "Unknown parent session");
        const parent = entry;
        if (resolve(params.cwd) !== resolve(parent.cwd))
          throw RequestError.invalidParams(undefined, "Fork cwd must match the parent workspace");
        const mcpServers = params.mcpServers ?? [...parent.mcpServers];
        if (JSON.stringify(mcpServers) !== JSON.stringify(parent.mcpServers))
          throw RequestError.invalidParams(
            undefined,
            "Fork must retain the parent's MCP server bindings",
          );
        return await afterPrompt(parent, cancellation, async () => {
          if (sessions.get(params.sessionId) !== parent || (!borrowed && !parent.acceptingUpdates))
            throw new RequestError(-32000, "Parent session closed");
          const child = await parent.runtime.fork();
          const childId = child.snapshot.durable.conversation.sessionId;
          diagnostic("acp", "info", "acp.fork.committed", {
            connectionId,
            rpcRequestId: String(client.requestId),
            parentSessionId: params.sessionId,
            sessionId: childId,
            revision: child.snapshot.durable.revision,
          });
          // Fork inherits core bindings. Rebind ACP resources before allowing any child input.
          await child.close();
          updates.refreshInfo(parent, client);
          try {
            cancellation.throwIfAborted();
            return await open(
              {
                cwd: parent.cwd,
                sessionId: childId,
                mcpServers,
                additionalDirectories: params.additionalDirectories ?? [],
              },
              client,
              cancellation,
              false,
            );
          } catch (error) {
            diagnostic("acp", "error", "acp.fork.rebind.failed", {
              connectionId,
              rpcRequestId: String(client.requestId),
              parentSessionId: params.sessionId,
              sessionId: childId,
              error: diagnosticError(error),
            });
            throw new RequestError(-32000, "Fork was committed but could not be opened", {
              sessionId: childId,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        });
      } finally {
        if (borrowed) {
          try {
            if (entry) {
              entry.usage?.close();
              entry.acceptingUpdates = false;
              try {
                await entry.runtime.close();
              } finally {
                await entry.dispose();
              }
              if (sessions.get(params.sessionId) === entry) sessions.delete(params.sessionId);
            }
          } finally {
            borrowedParents.delete(params.sessionId);
          }
        }
      }
    })
    .onRequest("session/delete", async ({ params, signal, client }) => {
      const started = performance.now();
      const trace = {
        connectionId,
        rpcRequestId: String(client.requestId),
        sessionId: params.sessionId,
        method: "session/delete",
      };
      diagnostic("acp", "info", "acp.session.delete.started", trace);
      requireAccess();
      if (
        opening.has(params.sessionId) ||
        borrowedParents.has(params.sessionId) ||
        deleting.has(params.sessionId)
      )
        throw RequestError.invalidParams(
          undefined,
          "Session lifecycle operation is already pending",
        );
      const cancellation = AbortSignal.any([signal, connection.signal]);
      cancellation.throwIfAborted();
      const entry = sessions.get(params.sessionId);
      deleting.add(params.sessionId);
      const remove = options.deleteSession!; // Unadvertised delete never reaches this handler.
      const operation = (async () => {
        if (entry) {
          entry.usage?.close();
          entry.acceptingUpdates = false;
          entry.promptController?.abort();
          try {
            await entry.runtime.close();
          } finally {
            await entry.dispose();
            sessions.delete(params.sessionId);
          }
        }
        cancellation.throwIfAborted();
        await remove(
          { sessionId: params.sessionId, ...(entry ? { cwd: entry.cwd } : {}) },
          cancellation,
        );
        return {};
      })()
        .then(
          (result) => {
            diagnostic("acp", "info", "acp.session.delete.completed", {
              ...trace,
              durationMs: performance.now() - started,
            });
            return result;
          },
          (error) => {
            diagnostic("acp", "error", "acp.session.delete.failed", {
              ...trace,
              durationMs: performance.now() - started,
              error: diagnosticError(error),
            });
            throw error;
          },
        )
        .finally(() => deleting.delete(params.sessionId));
      return waitForBoundary(operation, cancellation);
    })
    .onRequest("session/list", async ({ params, signal, client }) => {
      requireAccess();
      if (params.cwd != null && !isAbsolute(params.cwd))
        throw RequestError.invalidParams(undefined, "cwd must be absolute");
      const started = performance.now();
      const trace = {
        connectionId,
        rpcRequestId: String(client.requestId),
        method: "session/list",
        cwd: params.cwd,
      };
      try {
        // Unadvertised list never reaches this handler.
        const result = await options.listSessions!(params, signal);
        diagnostic("acp", "debug", "acp.session.list.completed", {
          ...trace,
          count: result.sessions.length,
          durationMs: performance.now() - started,
        });
        return result;
      } catch (error) {
        diagnostic("acp", "error", "acp.session.list.failed", {
          ...trace,
          durationMs: performance.now() - started,
          error: diagnosticError(error),
        });
        throw error;
      }
    })
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
    })
    .onRequest("session/prompt", async ({ params, client, signal }) => {
      const started = performance.now();
      const trace = {
        connectionId,
        rpcRequestId: String(client.requestId),
        sessionId: params.sessionId,
        method: "session/prompt",
      };
      diagnostic("acp", "info", "acp.prompt.received", { ...trace, count: params.prompt.length });
      const entry = lookup(params.sessionId);
      requireAdvertisedContent(params.prompt, promptCapabilities, trace);
      if (entry.busy) throw new RequestError(-32000, "Session already has an active prompt");
      await awaitConfigurationQuiet(entry, AbortSignal.any([signal, connection.signal]));
      if (sessions.get(params.sessionId) !== entry || !entry.acceptingUpdates)
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
      const entry = lookup(params.sessionId, true);
      entry.promptController?.abort();
    })
    .onRequest("session/close", async ({ params }) => {
      const entry = lookup(params.sessionId, true);
      // Close is terminal for this runtime, even if the client never answers permission requests.
      entry.usage?.close();
      entry.acceptingUpdates = false;
      entry.promptController?.abort();
      try {
        await entry.runtime.close();
      } finally {
        await entry.dispose();
      }
      sessions.delete(params.sessionId);
      await core.flushed();
      return {};
    });
  connection = app.connect(stream);
  diagnostic("acp", "info", "acp.connection.opened", { connectionId });
  const closed = connection.closed.then(async () => {
    diagnostic("acp", "info", "acp.connection.closing", { connectionId, count: sessions.size });
    closing = true;
    for (const entry of sessions.values()) {
      entry.usage?.close();
      entry.acceptingUpdates = false;
    }
    await Promise.allSettled([...sessions.values()].map((entry) => entry.runtime.close()));
    await Promise.allSettled([...resources].map((dispose) => dispose()));
    sessions.clear();
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
