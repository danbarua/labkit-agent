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
  type McpServer,
  type NewSessionRequest,
  type SessionInfoUpdate,
  type SessionUpdate,
  type Stream,
  type ToolCallStatus,
} from "@agentclientprotocol/sdk";
import {
  createSession,
  restoreSession,
  type JournalState,
  type SessionOptions,
  type SessionPersistence,
  type SessionRuntime,
  type SessionState,
} from "@labkit-agent/core";
import type { HostToolNotification, Tool } from "@labkit-agent/core/host";
import { diagnostic, diagnosticError } from "@labkit-agent/core/logging";
import type { AgentMessage } from "@labkit-agent/core/types";

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
import { mcpConnections } from "./mcp.ts";
import { PlanEntriesSchema, type PlanSink } from "./plan.ts";
import { promptInput } from "./prompt-input.ts";
import {
  bindConfig,
  configPatch,
  configState,
  waitForBoundary,
  type AcpConfigBinding,
} from "./session-config.ts";
import { parseSessionInfo } from "./session-info.ts";

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
}>;

type Session = {
  runtime: SessionRuntime;
  dispose: () => Promise<void>;
  persistence: SessionPersistence;
  promptController?: AbortController;
  promptRpcRequestId?: string;
  cwd: string;
  additionalDirectories: readonly string[];
  mcpServers: readonly McpServer[];
  busy: boolean;
  promptDone: Promise<void>;
  configurationTail: Promise<void>;
  config: readonly AcpConfigBinding[];
  commands: readonly AcpCommand[];
  configSignature: string;
  infoSignature: string;
  infoEpoch: number;
  modeId?: string;
  acceptingUpdates: boolean;
  revision: number;
  streamed: Map<string, string>;
  terminals: Map<string, string[]>;
  toolCards: Map<string, { baseTitle: string; title: string; status: ToolCallStatus }>;
};

function locatedTitle(title: string, locations?: readonly { path: string; line?: number }[]) {
  return locations?.length
    ? `${title}: ${locations.map(({ path, line }) => `${JSON.stringify(path)}${line === undefined ? "" : `:${line}`}`).join(", ")}`
    : title;
}

function toolUpdate(event: HostToolNotification, terminals: readonly string[] = []): SessionUpdate {
  if (event.sessionUpdate === "tool_call")
    return {
      sessionUpdate: "tool_call",
      toolCallId: event.toolCallId,
      title: event.title,
      name: event.name,
      kind: event.kind,
      status: event.status,
      rawInput: event.rawInput,
    };
  return {
    sessionUpdate: "tool_call_update",
    toolCallId: event.toolCallId,
    ...(event.status ? { status: event.status } : {}),
    ...(event.locations ? { locations: [...event.locations] } : {}),
    ...(event.rawOutput !== undefined
      ? {
          rawOutput: event.rawOutput,
          content: [
            ...terminals.map((terminalId) => ({ type: "terminal" as const, terminalId })),
            {
              type: "content",
              content: {
                type: "text",
                text:
                  typeof event.rawOutput === "string"
                    ? event.rawOutput
                    : JSON.stringify(event.rawOutput),
              },
            },
          ],
        }
      : {}),
  };
}

function observeSafely<T>(
  callback: ((value: T) => unknown) | undefined,
  value: T,
  fields: Record<string, unknown>,
) {
  const failed = (error: unknown) =>
    diagnostic("acp", "warning", "acp.subscriber.failed", {
      ...fields,
      error: diagnosticError(error),
    });
  try {
    void Promise.resolve(callback?.(value)).catch(failed);
  } catch (error) {
    failed(error);
  }
}

/** Raw journal tool outcomes retain failures even when policy projects them as tool text. */
function toolEvidence(state: JournalState) {
  const evidence = new Map<string, "completed" | "failed">();
  const owners = new Map<string, string[]>();
  const created = state.records[0]?.body;
  let historyIndex = created?.kind === "created" ? created.seed.log.length : 0;
  let active: { owner: string; turnId: string } | undefined;
  for (const { body } of state.records) {
    if (body.kind === "event" && body.event.type === "child") {
      const event = body.event.event;
      if (event.type === "model_settled" && event.result.kind === "succeeded") {
        const previous = owners.get(body.event.turnId) ?? [];
        previous.push(event.child.id);
        owners.set(body.event.turnId, previous);
        if (event.result.value.kind === "tools")
          active = { owner: event.child.id, turnId: body.event.turnId };
      }
    }
    if (body.kind === "tool" && active?.turnId === body.turnId)
      evidence.set(
        `${active.owner}/${body.callId}`,
        body.result.kind === "succeeded" ? "completed" : "failed",
      );
    if (body.kind === "terminal") {
      const completed = owners.get(body.turnId) ?? [];
      let assistant = 0;
      body.record.messages.forEach((message, index) => {
        if (message.role !== "assistant") return;
        const owner = completed[assistant++];
        for (const call of message.calls ?? []) {
          const status = evidence.get(`${owner}/${call.id}`);
          if (status)
            evidence.set(
              `${state.conversation.sessionId}/history/${historyIndex}/${index}/${call.id}`,
              status,
            );
        }
      });
      historyIndex++;
    }
  }
  return evidence;
}

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
  let clientCapabilities: ClientCapabilities = {};
  let closing = false;
  let connection: AgentConnection;
  const mcpBridge = acpMcpBridge(() => connection.signal);
  let writes: Promise<void> = Promise.resolve();
  const send = (client: AgentContext, sessionId: string, update: SessionUpdate) => {
    if (closing) return;
    writes = writes
      .then(() => client.notify("session/update", { sessionId, update }))
      .catch((error) => {
        diagnostic("acp", "error", "acp.notification.failed", {
          connectionId,
          sessionId,
          method: "session/update",
          error: diagnosticError(error),
        });
        connection.close(error);
      });
  };
  const refreshInfo = (entry: Session, client: AgentContext) => {
    if (!options.sessionInfo || !entry.acceptingUpdates || closing) return;
    const sessionId = entry.runtime.snapshot.durable.conversation.sessionId;
    const revision = entry.runtime.snapshot.durable.revision;
    const epoch = ++entry.infoEpoch;
    try {
      const result = options.sessionInfo({ sessionId, cwd: entry.cwd }, connection.signal);
      void Promise.resolve(result)
        .then((value) => {
          if (
            closing ||
            sessions.get(sessionId) !== entry ||
            !entry.acceptingUpdates ||
            epoch !== entry.infoEpoch ||
            entry.runtime.snapshot.durable.revision !== revision
          )
            return;
          const info = parseSessionInfo(value);
          if (!info) return;
          const signature = JSON.stringify(info);
          if (signature === entry.infoSignature) return;
          entry.infoSignature = signature;
          send(client, sessionId, { sessionUpdate: "session_info_update", ...info });
        })
        .catch((error) =>
          diagnostic("acp", "warning", "acp.session.metadata.failed", {
            connectionId,
            sessionId,
            revision,
            error: diagnosticError(error),
          }),
        );
    } catch (error) {
      diagnostic("acp", "warning", "acp.session.metadata.failed", {
        connectionId,
        sessionId,
        revision,
        error: diagnosticError(error),
      });
    }
  };
  const requireInitialized = () => {
    if (!initialized) throw new RequestError(-32002, "Initialize the connection first");
    if (closing) throw new RequestError(-32000, "Connection closed");
  };
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
    if (!session) throw RequestError.invalidParams(undefined, "Unknown session");
    return session;
  };
  const text = (
    client: AgentContext,
    id: string,
    value: string,
    messageId: string,
    thought = false,
  ) => {
    if (value)
      send(client, id, {
        sessionUpdate: thought ? "agent_thought_chunk" : "agent_message_chunk",
        messageId,
        content: { type: "text", text: value },
      });
  };
  const observe = (
    entry: Omit<Session, "runtime">,
    client: AgentContext,
    snapshot: SessionState,
  ) => {
    if (!entry.acceptingUpdates) return;
    const id = snapshot.durable.conversation.sessionId;
    const configuration = configState(entry.config, snapshot.durable.policy);
    const signature = JSON.stringify(configuration);
    if (signature !== entry.configSignature) {
      entry.configSignature = signature;
      if (configuration.configOptions)
        send(client, id, {
          sessionUpdate: "config_option_update",
          configOptions: configuration.configOptions,
        });
      if (configuration.modes && configuration.modes.currentModeId !== entry.modeId) {
        entry.modeId = configuration.modes.currentModeId;
        send(client, id, { sessionUpdate: "current_mode_update", currentModeId: entry.modeId });
      }
    }
    for (const record of snapshot.durable.records.slice(entry.revision)) {
      entry.revision = record.revision;
      const body = record.body;
      if (body.kind !== "event" || body.event.type !== "child") continue;
      const event = body.event.event;
      if (event.type !== "model_settled" || event.result.kind !== "succeeded") continue;
      const finalText = event.result.value.text;
      const prefix = entry.streamed.get(event.child.id) ?? "";
      // A decoder may normalize text. Never duplicate already displayed stream output.
      if (finalText.startsWith(prefix))
        text(client, id, finalText.slice(prefix.length), event.child.id);
      entry.streamed.delete(event.child.id);
    }
  };
  const replayMessages = (
    client: AgentContext,
    id: string,
    messages: readonly AgentMessage[],
    prefix: string,
    evidence: Map<string, "completed" | "failed">,
  ) => {
    const calls = new Map<string, { toolCallId: string; status?: "completed" | "failed" }>();
    messages.forEach((message, index) => {
      const messageId =
        message.role === "assistant" && message.owner
          ? `${message.owner.turnId}/${message.owner.generation}`
          : `${prefix}/${index}`;
      if (message.role === "user" || message.role === "assistant") {
        if (message.text)
          send(client, id, {
            sessionUpdate: message.role === "user" ? "user_message_chunk" : "agent_message_chunk",
            messageId,
            content: { type: "text", text: message.text },
          });
        for (const part of message.parts ?? [])
          if (part.type === "blob")
            send(client, id, {
              sessionUpdate: message.role === "user" ? "user_message_chunk" : "agent_message_chunk",
              messageId,
              content: {
                type: "resource_link",
                uri: `labkit-blob:${part.ref.id}`,
                name: part.ref.name ?? part.ref.id,
                mimeType: part.ref.media,
                size: part.ref.bytes,
              },
            });
      }
      if (message.role === "assistant")
        for (const call of message.calls ?? []) {
          const toolCallId = `${messageId}/tool/${call.id}`;
          calls.set(call.id, { toolCallId, status: evidence.get(`${messageId}/${call.id}`) });
          send(client, id, {
            sessionUpdate: "tool_call",
            toolCallId,
            title: call.name,
            name: call.name,
            rawInput: call.args,
            kind: "other",
          });
        }
      if (message.role === "tool") {
        const call = calls.get(message.callId);
        if (call) {
          const { toolCallId, status } = call;
          send(client, id, {
            sessionUpdate: "tool_call_update",
            toolCallId,
            ...(status ? { status } : {}),
            rawOutput: message.text,
            content: [{ type: "content", content: { type: "text", text: message.text } }],
          });
          calls.delete(message.callId);
        }
      }
    });
    for (const { toolCallId } of calls.values())
      send(client, id, { sessionUpdate: "tool_call_update", toolCallId, status: "failed" });
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
    if (params.additionalDirectories?.length && !options.additionalDirectories)
      throw RequestError.invalidParams(undefined, "Additional directories are not supported");
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
    try {
      let mcp: ReturnType<typeof mcpConnections>;
      try {
        mcp = mcpConnections(
          params.mcpServers,
          params.cwd,
          additionalDirectories,
          (serverId) => mcpBridge.transport(serverId, client),
          elicitation.port,
          { sessionId: id },
        );
      } catch (error) {
        throw RequestError.invalidParams(
          undefined,
          error instanceof Error ? error.message : "Invalid MCP servers",
        );
      }
      const cleanup = async () => {
        commandPublisherActive = false;
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
          undefined,
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
              (toolCallId, terminalId) => {
                const sessionId = sessionIdentity();
                const active = sessions.get(sessionId);
                if (!active?.acceptingUpdates) return;
                const ids = active.terminals.get(toolCallId) ?? [];
                if (!ids.includes(terminalId)) ids.push(terminalId);
                active.terminals.set(toolCallId, ids);
                send(client, sessionId, {
                  sessionUpdate: "tool_call_update",
                  toolCallId,
                  content: ids.map((terminalId) => ({ type: "terminal", terminalId })),
                });
              },
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
            send(client, sessionId, {
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
          send(client, sessionId, {
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
          observe: (snapshot) => {
            if (!boundSessionId || snapshot.durable.conversation.sessionId === boundSessionId)
              observe(entry, client, snapshot);
            observeSafely(subscribers.observe, snapshot, {
              connectionId,
              sessionId: snapshot.durable.conversation.sessionId,
              operation: "observe",
            });
          },
          toolUpdate: (event) => {
            if (event.sessionUpdate === "tool_call")
              entry.toolCards.set(event.toolCallId, {
                baseTitle: event.title,
                title: event.title,
                status: event.status,
              });
            const card = entry.toolCards.get(event.toolCallId);
            if (card && event.sessionUpdate === "tool_call_update") {
              if (event.locations) card.title = locatedTitle(card.baseTitle, event.locations);
              if (event.status) card.status = event.status;
            }
            if (entry.acceptingUpdates && event.sessionId)
              send(client, event.sessionId, {
                ...toolUpdate(event, entry.terminals.get(event.toolCallId)),
                ...(card ? { title: card.title, status: card.status } : {}),
              });
            if (event.status === "completed" || event.status === "failed") {
              entry.terminals.delete(event.toolCallId);
              entry.toolCards.delete(event.toolCallId);
            }
            observeSafely(subscribers.toolUpdate, event, {
              connectionId,
              sessionId: event.sessionId,
              toolCallId: event.toolCallId,
              operation: "toolUpdate",
            });
          },
          streamUpdate: (event) => {
            if (entry.acceptingUpdates && event.sessionId) {
              if (event.text) {
                entry.streamed.set(
                  event.completionId,
                  (entry.streamed.get(event.completionId) ?? "") + event.text,
                );
                text(client, event.sessionId, event.text, event.completionId);
              }
              if (event.thinking)
                text(
                  client,
                  event.sessionId,
                  event.thinking,
                  `${event.completionId}/thought`,
                  true,
                );
              if (event.status === "failed") entry.streamed.delete(event.completionId);
            }
            observeSafely(subscribers.streamUpdate, event, {
              connectionId,
              sessionId: event.sessionId,
              childId: event.completionId,
              operation: "streamUpdate",
            });
          },
          requestPermission: async (request, permissionSignal) => {
            await writes;
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
                    reject(error);
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
      opening.add(sessionId);
      let configuration: ReturnType<typeof configState>;
      try {
        configuration = configState(entry.config, runtime.snapshot.durable.policy);
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
      commandEntry = Object.assign(entry, { runtime });
      sessions.set(sessionId, commandEntry);
      entry.revision = runtime.snapshot.durable.revision;
      if (id && replay) {
        const durable = runtime.snapshot.durable;
        const state = durable.conversation;
        const evidence = toolEvidence(durable);
        replayMessages(client, id, state.context, `${id}/context`, evidence);
        state.log.forEach((record, index) => {
          replayMessages(client, id, record.messages, `${id}/history/${index}`, evidence);
        });
      }
      boundSessionId = sessionId;
      entry.acceptingUpdates = visible;
      published = true;
      if (visible) refreshInfo(sessions.get(sessionId)!, client);
      if (visible && entry.commands.length)
        send(client, sessionId, {
          sessionUpdate: "available_commands_update",
          availableCommands: availableCommands(entry.commands),
        });
      await writes;
      diagnostic("acp", "info", "acp.session.open.completed", {
        ...trace,
        sessionId,
        revision: entry.revision,
        provider: runtime.snapshot.durable.policy?.provider,
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
    const patch = binding && configPatch(binding, value, type);
    if (!binding || !patch)
      throw RequestError.invalidParams(undefined, "Unknown config option or value");
    const cancellation = AbortSignal.any([signal, connection.signal]);
    const operation = entry.configurationTail.then(async () => {
      await waitForBoundary(entry.promptDone, cancellation);
      cancellation.throwIfAborted();
      if (closing || sessions.get(id) !== entry || !entry.acceptingUpdates)
        throw new RequestError(-32000, "Session closed");
      requireAccess();
      const policy = entry.runtime.snapshot.durable.policy;
      if (!policy) throw new RequestError(-32000, "Session has no journaled policy");
      if (binding.current(policy) !== value) {
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
      const state = configState(entry.config, entry.runtime.snapshot.durable.policy);
      observe(entry, client, entry.runtime.snapshot);
      refreshInfo(entry, client);
      await writes;
      return { configOptions: state.configOptions ?? [] };
    });
    entry.configurationTail = operation.then(
      () => {},
      () => {},
    );
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
  const closeForAuth = async () => {
    authLifetime.abort();
    authLifetime = new AbortController();
    const active = [...sessions.entries()];
    for (const [, entry] of active) {
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
  const app = agent()
    .onRequest("initialize", ({ params }) => {
      if (initialized)
        throw RequestError.invalidRequest(undefined, "Connection already initialized");
      initialized = true;
      clientCapabilities = structuredClone(params.clientCapabilities ?? {});
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentInfo,
        authMethods: auth.methods(clientCapabilities),
        agentCapabilities: {
          loadSession,
          ...(auth.logoutSupported ? { auth: { logout: {} } } : {}),
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
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
        diagnostic("acp", "warning", "acp.auth.failed", {
          ...trace,
          durationMs: performance.now() - started,
          error: diagnosticError(error),
        });
        throw error;
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
      if (!loadSession) throw RequestError.methodNotFound("session/load");
      const { sessionId: _, ...configuration } = await open(params, client, signal);
      return configuration;
    })
    .onRequest("session/resume", async ({ params, client, signal }) => {
      if (!loadSession) throw RequestError.methodNotFound("session/resume");
      const { sessionId: _, ...configuration } = await open(
        { ...params, mcpServers: params.mcpServers ?? [] },
        client,
        signal,
        false,
      );
      return configuration;
    })
    .onRequest("session/fork", async ({ params, client, signal }) => {
      if (!forkSession) throw RequestError.methodNotFound("session/fork");
      requireAccess();
      if (deleting.has(params.sessionId))
        throw RequestError.invalidParams(undefined, "Session is being deleted");
      if (borrowedParents.has(params.sessionId))
        throw RequestError.invalidParams(undefined, "Session is already being forked privately");
      if (!isAbsolute(params.cwd))
        throw RequestError.invalidParams(undefined, "cwd must be absolute");
      if (params.additionalDirectories?.length && !options.additionalDirectories)
        throw RequestError.invalidParams(undefined, "Additional directories are not supported");
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
        const operation = parent.configurationTail.then(async () => {
          await waitForBoundary(parent.promptDone, cancellation);
          cancellation.throwIfAborted();
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
          refreshInfo(parent, client);
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
        parent.configurationTail = operation.then(
          () => {},
          () => {},
        );
        return await waitForBoundary(operation, cancellation);
      } finally {
        if (borrowed) {
          try {
            if (entry) {
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
      if (!options.deleteSession) throw RequestError.methodNotFound("session/delete");
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
      const remove = options.deleteSession;
      const operation = (async () => {
        if (entry) {
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
      if (!options.listSessions) throw RequestError.methodNotFound("session/list");
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
        const result = await options.listSessions(params, signal);
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
      if (entry.busy) throw new RequestError(-32000, "Session already has an active prompt");
      let barrier: Promise<void>;
      do {
        barrier = entry.configurationTail;
        await waitForBoundary(barrier, AbortSignal.any([signal, connection.signal]));
      } while (barrier !== entry.configurationTail);
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
        observe(entry, client, entry.runtime.snapshot);
        refreshInfo(entry, client);
        await writes;
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
          throw new RequestError(-32000, "Agent turn failed", outcome.error);
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
        entry.streamed.clear();
        entry.terminals.clear();
        entry.toolCards.clear();
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
      entry.acceptingUpdates = false;
      entry.promptController?.abort();
      try {
        await entry.runtime.close();
      } finally {
        await entry.dispose();
      }
      sessions.delete(params.sessionId);
      await writes;
      return {};
    });
  connection = app.connect(stream);
  diagnostic("acp", "info", "acp.connection.opened", { connectionId });
  const closed = connection.closed.then(async () => {
    diagnostic("acp", "info", "acp.connection.closing", { connectionId, count: sessions.size });
    closing = true;
    for (const entry of sessions.values()) entry.acceptingUpdates = false;
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
