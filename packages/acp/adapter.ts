import { isAbsolute } from "node:path";

import {
  agent,
  PROTOCOL_VERSION,
  RequestError,
  type AgentConnection,
  type AgentContext,
  type NewSessionRequest,
  type SessionUpdate,
  type Stream,
} from "@agentclientprotocol/sdk";
import {
  createSession,
  restoreSession,
  type BoundSessionOptions,
  type JournalState,
  type SessionPersistence,
  type SessionRuntime,
  type SessionState,
} from "@labkit-agent/core";
import type { HostToolNotification } from "@labkit-agent/core/host";
import type { AgentMessage } from "@labkit-agent/core/types";

import { promptInput } from "./prompt-input.ts";

export type SessionOptionsContext = Readonly<{
  cwd: string;
  sessionId?: string;
  signal: AbortSignal;
}>;
export type AcpOptions = Readonly<{
  /** Bind tools to cwd without changing process.cwd(). On load, validate cwd against saved ownership. */
  sessionOptions: (
    context: SessionOptionsContext,
  ) => BoundSessionOptions | Promise<BoundSessionOptions>;
  /** Enable only when sessionOptions can resolve compatible persistence/configuration for saved IDs. */
  loadSession?: boolean;
  agentInfo?: { name: string; version: string; title?: string };
}>;
type Session = {
  runtime: SessionRuntime;
  persistence: SessionPersistence;
  promptController?: AbortController;
  cwd: string;
  busy: boolean;
  acceptingUpdates: boolean;
  revision: number;
  streamed: Map<string, string>;
};

function toolUpdate(event: HostToolNotification): SessionUpdate {
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
function observeSafely<T>(callback: ((value: T) => unknown) | undefined, value: T) {
  try {
    void Promise.resolve(callback?.(value)).catch(() => {});
  } catch {}
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
  const sessions = new Map<string, Session>();
  const opening = new Set<string>();
  const sessionOptions = options.sessionOptions;
  const loadSession = options.loadSession === true;
  const agentInfo = { ...(options.agentInfo ?? { name: "labkit-agent", version: "0.1.0" }) };
  let initialized = false;
  let closing = false;
  let connection: AgentConnection;
  let writes: Promise<void> = Promise.resolve();
  const send = (client: AgentContext, sessionId: string, update: SessionUpdate) => {
    if (closing) return;
    writes = writes
      .then(() => client.notify("session/update", { sessionId, update }))
      .catch((error) => {
        connection.close(error);
      });
  };
  const requireInitialized = () => {
    if (!initialized) throw new RequestError(-32002, "Initialize the connection first");
    if (closing) throw new RequestError(-32000, "Connection closed");
  };
  const lookup = (id: string) => {
    requireInitialized();
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
  ) {
    requireInitialized();
    if (!isAbsolute(params.cwd))
      throw RequestError.invalidParams(undefined, "cwd must be absolute");
    if (params.mcpServers.length)
      throw RequestError.invalidParams(undefined, "MCP server connections are not implemented");
    if (params.additionalDirectories?.length)
      throw RequestError.invalidParams(undefined, "Additional directories are not supported");
    if (params.sessionId && (sessions.has(params.sessionId) || opening.has(params.sessionId)))
      throw RequestError.invalidParams(undefined, "Session is already loaded");
    const id = params.sessionId;
    if (id) opening.add(id);
    try {
      const original = await sessionOptions({
        cwd: params.cwd,
        ...(id ? { sessionId: id } : {}),
        signal,
      });
      const subscribers = { ...original.bindings };
      signal.throwIfAborted();
      if (closing) throw new Error("Connection closed");
      const entry = {
        cwd: params.cwd,
        persistence: original.persistence,
        busy: false,
        acceptingUpdates: false,
        revision: 0,
        streamed: new Map(),
      };
      const bound: BoundSessionOptions = {
        ...original,
        configuration: {
          ...original.configuration,
          policy: {
            ...original.configuration.policy,
            permissions: original.configuration.policy?.permissions ?? "ask",
          },
        },
        bindings: {
          ...original.bindings,
          observe: (snapshot) => {
            observe(entry, client, snapshot);
            observeSafely(subscribers.observe, snapshot);
          },
          toolUpdate: (event) => {
            if (entry.acceptingUpdates && event.sessionId)
              send(client, event.sessionId, toolUpdate(event));
            observeSafely(subscribers.toolUpdate, event);
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
            observeSafely(subscribers.streamUpdate, event);
          },
          requestPermission: async (request, permissionSignal) => {
            await writes;
            if (permissionSignal.aborted || closing) return { outcome: { outcome: "cancelled" } };
            return new Promise((resolve, reject) => {
              const abort = () => resolve({ outcome: { outcome: "cancelled" } });
              permissionSignal.addEventListener("abort", abort, { once: true });
              const { locations, ...toolCall } = request.toolCall;
              void client
                .request(
                  "session/request_permission",
                  {
                    sessionId: request.sessionId!,
                    toolCall: { ...toolCall, ...(locations ? { locations: [...locations] } : {}) },
                    options: [...request.options],
                  },
                  { cancellationSignal: permissionSignal },
                )
                .then(resolve, reject)
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
      if (sessions.has(sessionId)) {
        await runtime.close();
        throw new Error("Duplicate session identity");
      }
      sessions.set(sessionId, Object.assign(entry, { runtime }));
      entry.revision = runtime.snapshot.durable.revision;
      if (id) {
        const durable = runtime.snapshot.durable;
        const state = durable.conversation;
        const evidence = toolEvidence(durable);
        replayMessages(client, id, state.context, `${id}/context`, evidence);
        state.log.forEach((record, index) => {
          replayMessages(client, id, record.messages, `${id}/history/${index}`, evidence);
        });
      }
      entry.acceptingUpdates = true;
      await writes;
      return { sessionId };
    } finally {
      if (id) opening.delete(id);
    }
  }
  const app = agent()
    .onRequest("initialize", () => {
      if (initialized)
        throw RequestError.invalidRequest(undefined, "Connection already initialized");
      initialized = true;
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentInfo,
        authMethods: [],
        agentCapabilities: {
          loadSession,
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
          mcpCapabilities: { http: false, sse: false },
          sessionCapabilities: { close: {} },
        },
      };
    })
    .onRequest("session/new", ({ params, client, signal }) => open(params, client, signal))
    .onRequest("session/load", async ({ params, client, signal }) => {
      if (!loadSession) throw RequestError.methodNotFound("session/load");
      await open(params, client, signal);
      return {};
    })
    .onRequest("session/prompt", async ({ params, client, signal }) => {
      const entry = lookup(params.sessionId);
      if (entry.busy) throw new RequestError(-32000, "Session already has an active prompt");
      entry.busy = true;
      const controller = new AbortController();
      entry.promptController = controller;
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
          params.prompt,
          entry.cwd,
          entry.persistence,
          entry.runtime.snapshot.durable.conversation.sessionId,
          promptSignal,
        );
        promptSignal.throwIfAborted();
        const turn = entry.runtime.input(input);
        admitted = true;
        if (promptSignal.aborted) abort();
        const receipt = await turn.accepted;
        if (receipt.kind !== "accepted")
          throw new RequestError(-32000, "Prompt admission failed", receipt);
        const result = await turn.settled;
        observe(entry, client, entry.runtime.snapshot);
        await writes;
        if (aborted || result.kind === "closed") return { stopReason: "cancelled" };
        if (result.kind !== "terminal")
          throw new RequestError(-32000, "Session storage failed", { message: result.message });
        const outcome = result.record.outcome;
        if (outcome.kind === "failed") {
          const refused = entry.runtime.snapshot.durable.records.some((record) => {
            const body = record.body;
            return (
              body.kind === "event" &&
              body.event.type === "child" &&
              body.event.turnId === result.turnId &&
              body.event.event.type === "permission_settled" &&
              body.event.event.result.kind === "succeeded" &&
              body.event.event.result.value.some((decision) => decision.decision === "reject_once")
            );
          });
          if (refused) return { stopReason: "refusal" };
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
        if (promptSignal.aborted) return { stopReason: "cancelled" };
        throw error;
      } finally {
        promptSignal.removeEventListener("abort", abort);
        entry.promptController = undefined;
        entry.busy = false;
        entry.streamed.clear();
      }
    })
    .onNotification("session/cancel", async ({ params }) => {
      const entry = lookup(params.sessionId);
      entry.promptController?.abort();
    })
    .onRequest("session/close", async ({ params }) => {
      const entry = lookup(params.sessionId);
      // Close is terminal for this runtime, even if the client never answers permission requests.
      entry.acceptingUpdates = false;
      entry.promptController?.abort();
      await entry.runtime.close();
      sessions.delete(params.sessionId);
      await writes;
      return {};
    });
  connection = app.connect(stream);
  const closed = connection.closed.then(async () => {
    closing = true;
    for (const entry of sessions.values()) entry.acceptingUpdates = false;
    await Promise.all([...sessions.values()].map((entry) => entry.runtime.close()));
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
