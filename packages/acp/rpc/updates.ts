import type { AgentContext, SessionUpdate } from "@agentclientprotocol/sdk";
import type {
  JournalState,
  SessionBindings,
  SessionRuntime,
  SessionState,
} from "@labkit-agent/core";
import type { HostToolNotification } from "@labkit-agent/core/host";
import { diagnostic, diagnosticError } from "@labkit-agent/core/logging";
import type { AgentMessage } from "@labkit-agent/core/types";

import type { AcpOptions } from "../adapter.ts";
import { parseSessionInfo } from "../session-info.ts";
import { renderToolContent, type AcpToolContent } from "../tool-content.ts";
import type { ConfigProjection } from "./config.ts";
import type { AdapterCore } from "./core.ts";
import type { Session } from "./session.ts";

/** Runtime display callbacks that ACP projects to the client. */
export type DisplayBindings = Pick<SessionBindings, "observe" | "toolUpdate" | "streamUpdate">;

/** Projects runtime state and display events to `session/update` notifications. */
export type SessionUpdates = Readonly<{
  observe(
    entry: Omit<Session, "runtime"> & { runtime?: SessionRuntime },
    client: AgentContext,
    snapshot: SessionState,
  ): void;
  refreshInfo(entry: Session, client: AgentContext): void;
  replay(
    client: AgentContext,
    id: string,
    messages: readonly AgentMessage[],
    prefix: string,
    evidence: Map<string, "completed" | "failed">,
    renderers: ReadonlyMap<string, AcpToolContent>,
  ): void;
  bindings(
    entry: Omit<Session, "runtime"> & { runtime?: SessionRuntime },
    client: AgentContext,
    renderers: ReadonlyMap<string, AcpToolContent>,
    subscribers: DisplayBindings,
    boundSessionId: () => string | undefined,
  ): DisplayBindings;
  terminalAttached(
    client: AgentContext,
    sessionIdentity: () => string,
  ): (toolCallId: string, terminalId: string) => void;
  resetTurn(entry: Session): void;
}>;

/** Append validated locations to a tool title for clients that show only the title. */
export function locatedTitle(
  title: string,
  locations?: readonly { path: string; line?: number }[],
) {
  return locations?.length
    ? `${title}: ${locations.map(({ path, line }) => `${JSON.stringify(path)}${line === undefined ? "" : `:${line}`}`).join(", ")}`
    : title;
}

function toolUpdate(
  event: HostToolNotification,
  terminals: readonly string[] = [],
  renderers: ReadonlyMap<string, AcpToolContent> = new Map(),
): SessionUpdate {
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
            ...renderToolContent(
              event.status === "completed" && event.name ? renderers.get(event.name) : undefined,
              event.rawOutput,
              {
                sessionId: event.sessionId,
                toolCallId: event.toolCallId,
                toolName: event.name,
                turnId: event.turnId,
                batchId: event.batchId,
                callId: event.callId,
                reconstructed: false,
              },
            ),
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
export function toolEvidence(state: JournalState) {
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

/** Builds the session/update projection for one connection. */
export function sessionUpdates(
  core: AdapterCore,
  current: (sessionId: string) => Session | undefined,
  sessionInfo: AcpOptions["sessionInfo"],
  project: ConfigProjection["project"],
): SessionUpdates {
  const { connectionId } = core;
  const text = (
    client: AgentContext,
    id: string,
    value: string,
    messageId: string,
    thought = false,
  ) => {
    if (value)
      core.send(client, id, {
        sessionUpdate: thought ? "agent_thought_chunk" : "agent_message_chunk",
        messageId,
        content: { type: "text", text: value },
      });
  };

  const refreshInfo = (entry: Session, client: AgentContext) => {
    if (!sessionInfo || !entry.acceptingUpdates || core.isClosing()) return;
    const sessionId = entry.runtime.snapshot.durable.conversation.sessionId;
    const revision = entry.runtime.snapshot.durable.revision;
    const epoch = ++entry.infoEpoch;
    try {
      const result = sessionInfo({ sessionId, cwd: entry.cwd }, core.signal());
      void Promise.resolve(result)
        .then((value) => {
          if (
            core.isClosing() ||
            current(sessionId) !== entry ||
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
          core.send(client, sessionId, { sessionUpdate: "session_info_update", ...info });
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

  const observe = (
    entry: Omit<Session, "runtime"> & { runtime?: SessionRuntime },
    client: AgentContext,
    snapshot: SessionState,
  ) => {
    if (!entry.acceptingUpdates) return;
    entry.usage?.refresh();
    const id = snapshot.durable.conversation.sessionId;
    // Pending registry adoption can reconcile the policy the next turn uses before it is journaled.
    const policy = entry.runtime ? entry.runtime.policy : snapshot.durable.policy;
    project(entry, client, id, policy, snapshot.durable.revision);
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

  const replay = (
    client: AgentContext,
    id: string,
    messages: readonly AgentMessage[],
    prefix: string,
    evidence: Map<string, "completed" | "failed">,
    renderers: ReadonlyMap<string, AcpToolContent>,
  ) => {
    const calls = new Map<
      string,
      { toolCallId: string; toolName: string; status?: "completed" | "failed" }
    >();
    messages.forEach((message, index) => {
      const messageId =
        message.role === "assistant" && message.owner
          ? `${message.owner.turnId}/${message.owner.generation}`
          : `${prefix}/${index}`;
      if (message.role === "user" || message.role === "assistant") {
        if (message.text)
          core.send(client, id, {
            sessionUpdate: message.role === "user" ? "user_message_chunk" : "agent_message_chunk",
            messageId,
            content: { type: "text", text: message.text },
          });
        for (const part of message.parts ?? [])
          if (part.type === "blob")
            core.send(client, id, {
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
          calls.set(call.id, {
            toolCallId,
            toolName: call.name,
            status: evidence.get(`${messageId}/${call.id}`),
          });
          core.send(client, id, {
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
          const { toolCallId, toolName, status } = call;
          core.send(client, id, {
            sessionUpdate: "tool_call_update",
            toolCallId,
            ...(status ? { status } : {}),
            rawOutput: message.text,
            _meta: { "labkit.dev/reconstructed": true },
            content: renderToolContent(
              status === "completed" ? renderers.get(toolName) : undefined,
              message.text,
              { sessionId: id, toolCallId, toolName, reconstructed: true },
            ),
          });
          calls.delete(message.callId);
        }
      }
    });
    for (const { toolCallId } of calls.values())
      core.send(client, id, { sessionUpdate: "tool_call_update", toolCallId, status: "failed" });
  };

  return {
    refreshInfo,
    observe,
    replay,
    bindings: (entry, client, renderers, subscribers, boundSessionId) => ({
      observe: (snapshot) => {
        const bound = boundSessionId();
        if (!bound || snapshot.durable.conversation.sessionId === bound)
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
          core.send(client, event.sessionId, {
            ...toolUpdate(event, entry.terminals.get(event.toolCallId), renderers),
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
            text(client, event.sessionId, event.thinking, `${event.completionId}/thought`, true);
          if (event.status === "failed") entry.streamed.delete(event.completionId);
        }
        observeSafely(subscribers.streamUpdate, event, {
          connectionId,
          sessionId: event.sessionId,
          childId: event.completionId,
          operation: "streamUpdate",
        });
      },
    }),
    terminalAttached: (client, sessionIdentity) => (toolCallId, terminalId) => {
      const sessionId = sessionIdentity();
      const active = current(sessionId);
      if (!active?.acceptingUpdates) return;
      const ids = active.terminals.get(toolCallId) ?? [];
      if (!ids.includes(terminalId)) ids.push(terminalId);
      active.terminals.set(toolCallId, ids);
      core.send(client, sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId,
        content: ids.map((terminalId) => ({ type: "terminal", terminalId })),
      });
    },
    resetTurn: (entry) => {
      entry.streamed.clear();
      entry.terminals.clear();
      entry.toolCards.clear();
    },
  };
}
