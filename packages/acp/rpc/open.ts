import { isAbsolute } from "node:path";

import { RequestError, type AgentContext, type NewSessionRequest } from "@agentclientprotocol/sdk";
import {
  createSession,
  restoreSession,
  SessionNotFoundError,
  type SessionOptions,
} from "@labkit-agent/core";
import type { Tool } from "@labkit-agent/core/host";
import { diagnostic, diagnosticError } from "@labkit-agent/core/logging";

import type { AcpOptions } from "../adapter.ts";
import { clientElicitation } from "../client-elicitation.ts";
import { clientFiles } from "../client-files.ts";
import { clientTerminal } from "../client-terminal.ts";
import { availableCommands, bindCommands, type AcpCommand } from "../commands.ts";
import type { AcpMcpBridge } from "../mcp-acp.ts";
import { mcpConnections, McpOpenError } from "../mcp.ts";
import { PlanEntriesSchema } from "../plan.ts";
import { bindConfig, configState, waitForBoundary, type ConfigState } from "../session-config.ts";
import { usageReporter } from "../session-usage.ts";
import { mcpToolContent } from "../tool-content.ts";
import { logUnlisted, type ConfigProjection } from "./config.ts";
import type { ConnectionGate } from "./connection.ts";
import type { AdapterCore } from "./core.ts";
import { forwardPermission } from "./permission.ts";
import type { Session } from "./session.ts";
import type { SessionRegistry } from "./sessions.ts";
import { toolEvidence, type SessionUpdates } from "./updates.ts";

/** Everything opening a session needs from the connection. */
export type OpenDeps = Readonly<{
  core: AdapterCore;
  gate: Pick<ConnectionGate, "requireAccess" | "clientCapabilities">;
  registry: SessionRegistry;
  updates: SessionUpdates;
  config: Pick<ConfigProjection, "prime">;
  mcpBridge: Pick<AcpMcpBridge, "transport">;
  sessionOptions: AcpOptions["sessionOptions"];
  /** Whether initialize advertises sessionCapabilities.additionalDirectories. */
  additionalDirectories: boolean;
}>;

/**
 * Creates or restores a runtime and binds it to this connection. `replay` sends saved history;
 * `visible` publishes the session to the client (a privately borrowed fork parent is not).
 */
export type OpenSession = (
  params: NewSessionRequest & { sessionId?: string },
  client: AgentContext,
  signal: AbortSignal,
  replay?: boolean,
  visible?: boolean,
) => Promise<{ sessionId: string } & ConfigState>;

/** Additional roots are opt-in; refuse them rather than silently dropping workspace roots. */
export function requireRootsAdvertised(
  advertised: boolean,
  requested: readonly string[] | null | undefined,
  trace: Record<string, unknown>,
) {
  if (!requested?.length || advertised) return;
  diagnostic("acp", "warning", "acp.session.additional_directories.refused", {
    ...trace,
    count: requested.length,
    reason: "sessionCapabilities.additionalDirectories is not advertised",
  });
  throw RequestError.invalidParams(
    { capability: "sessionCapabilities.additionalDirectories" },
    "additionalDirectories was refused because this agent does not advertise sessionCapabilities.additionalDirectories; resend without additionalDirectories to use cwd as the only workspace root",
  );
}

/** Builds the session opener used by session/new, load, resume and fork. */
export function opener(deps: OpenDeps): OpenSession {
  const { core, gate, updates, config } = deps;
  const { connectionId } = core;
  const { sessions, opening, deleting, resources } = deps.registry.state;
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
    gate.requireAccess();
    if (!isAbsolute(params.cwd))
      throw RequestError.invalidParams(undefined, "cwd must be absolute");
    requireRootsAdvertised(deps.additionalDirectories, params.additionalDirectories, trace);
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
    signal = AbortSignal.any([signal, core.signal(), deps.registry.state.authLifetime.signal]);
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
      gate.clientCapabilities(),
      sessionIdentity,
      core.signal(),
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
          (serverId) => deps.mcpBridge.transport(serverId, client),
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
        gate.clientCapabilities(),
        sessionIdentity,
        core.signal(),
      );
      const terminal =
        gate.clientCapabilities().terminal === true
          ? clientTerminal(
              client,
              sessionIdentity,
              params.cwd,
              core.signal(),
              updates.terminalAttached(client, sessionIdentity),
            )
          : undefined;
      const original = await deps.sessionOptions({
        cwd: params.cwd,
        additionalDirectories,
        ...(id ? { sessionId: id } : {}),
        mcpTools,
        clientFiles: filesystem,
        elicitation: elicitation.port,
        publishCommands: (commands) => {
          try {
            if (
              !commandPublisherActive ||
              signal.aborted ||
              core.signal().aborted ||
              core.isClosing()
            )
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
          if (operationSignal.aborted || core.signal().aborted) return;
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
      gate.requireAccess();
      signal.throwIfAborted();
      if (core.isClosing()) throw new Error("Connection closed");
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
          gate.clientCapabilities().session?.configOptions?.boolean != null,
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
          ...updates.bindings(entry, client, renderers, subscribers, () => boundSessionId),
          requestPermission: forwardPermission(core, entry, client),
        },
      };
      const runtime = id ? await restoreSession(bound, id) : await createSession(bound);
      if (core.isClosing() || signal.aborted) {
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
        gate.requireAccess();
      } catch (error) {
        await runtime.close();
        throw error;
      }
      entry.commands = pendingCommands ?? entry.commands;
      config.prime(entry, configuration);
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
  return open;
}
