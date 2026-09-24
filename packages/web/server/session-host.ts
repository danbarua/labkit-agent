import { z } from "zod";

import type { TurnState } from "../../core/agent/agent-fsm.ts";
import {
  BlobIdSchema,
  MAX_BLOB_BYTES,
  MediaKindSchema,
  SessionIdSchema,
  type AgentMessage,
} from "../../core/agent/types.ts";
import type { PermissionPort, PermissionRequest } from "../../core/host/ports.ts";
import {
  anthropicMessages,
  anthropicMessagesV2,
  anthropicMessagesV3,
  googleGenerate,
  googleGenerateV2,
  googleGenerateV3,
  openaiChat,
  openaiChatV2,
  openaiResponses,
  openaiResponsesV2,
  openaiResponsesV3,
  type CompletionProfile,
} from "../../core/providers/index.ts";
import {
  createSession,
  defineTool,
  type EnvReceipt,
  type EnvSettlement,
  type HostStreamNotification,
  type HostToolNotification,
  type SessionRuntime,
  type SessionState,
} from "../../core/session/index.ts";
import { createMemoryPersistence } from "../../core/session/testing/memory-persistence.ts";
import type {
  ConsoleEvent,
  CreateSessionBody,
  HostInfo,
  MessageView,
  PermissionPrompt,
  ProviderOption,
  PublicReceipt,
  SessionView,
} from "../protocol.ts";

const SYSTEM = "You are a lab operator assistant. Be concise. Use echo and now when they help.";
const FIXTURE_DELAY_MS = Number(process.env.LABKIT_FIXTURE_DELAY_MS ?? 1500);
const persistence = createMemoryPersistence();
const ADMITTED: Record<string, true> = {
  user: true,
  abort: true,
  policy: true,
  system: true,
  close: true,
};

type Subscriber = (event: ConsoleEvent) => void;
type BoundProfile = {
  profile: CompletionProfile;
  label: string;
  defaultModel: string;
  baseUrl: string;
  headers: Record<string, string>;
};
type PendingPermission = {
  request: PermissionRequest;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};
type Hosted = {
  runtime: SessionRuntime;
  model: string;
  subscribers: Set<Subscriber>;
  pendingPermissions: Map<string, PendingPermission>;
};

const sessions = new Map<string, Hosted>();

function thinkingChoices(profile: CompletionProfile) {
  const capability = profile.capabilities.thinking;
  const values = ["off"];
  if (capability.mode === "effort") {
    for (const value of capability.values) if (value !== "none") values.push(value);
  }
  if (capability.mode === "adaptive" || capability.mode === "budget") values.push("adaptive");
  return values;
}

function boundProfiles(): BoundProfile[] {
  const openai = process.env.OPENAI_API_KEY;
  const anthropic = process.env.ANTHROPIC_API_KEY;
  const google = process.env.GOOGLE_API_KEY;
  const xai = process.env.XAI_API_KEY;
  const bound: BoundProfile[] = [];
  const add = (
    profiles: CompletionProfile[],
    labelFor: (profile: CompletionProfile) => string,
    defaultModel: string,
    baseUrl: string,
    headers: Record<string, string>,
  ) => {
    for (const profile of profiles) {
      bound.push({ profile, label: labelFor(profile), defaultModel, baseUrl, headers });
    }
  };
  if (openai) {
    add(
      [openaiResponses, openaiResponsesV2, openaiResponsesV3, openaiChat, openaiChatV2],
      (profile) => profile.id,
      "gpt-4.1-mini",
      "https://api.openai.com/v1",
      { Authorization: `Bearer ${openai}` },
    );
  } else if (xai) {
    add(
      [openaiChat, openaiChatV2],
      (profile) => `xAI via ${profile.id}`,
      "grok-3",
      "https://api.x.ai/v1",
      { Authorization: `Bearer ${xai}` },
    );
  }
  if (anthropic) {
    add(
      [anthropicMessages, anthropicMessagesV2, anthropicMessagesV3],
      (profile) => profile.id,
      "claude-sonnet-4-5",
      "https://api.anthropic.com/v1",
      { "x-api-key": anthropic },
    );
  }
  if (google) {
    add(
      [googleGenerate, googleGenerateV2, googleGenerateV3],
      (profile) => profile.id,
      "gemini-2.5-flash",
      "https://generativelanguage.googleapis.com/v1beta",
      { "x-goog-api-key": google },
    );
  }
  return bound;
}

function publicProvider(profile: BoundProfile): ProviderOption {
  return {
    id: profile.profile.id,
    label: profile.label,
    stream: profile.profile.capabilities.stream,
    thinking: thinkingChoices(profile.profile),
    media: [...profile.profile.capabilities.media],
    defaultModel: profile.defaultModel,
  };
}

export function hostInfo(): HostInfo {
  const providers = boundProfiles().map(publicProvider);
  return { mode: providers.length ? "live" : "fixture", providers };
}

function publish(hosted: Hosted, event: ConsoleEvent) {
  for (const subscriber of hosted.subscribers) {
    try {
      subscriber(event);
    } catch {
      /* A dropped browser cannot change the session. */
    }
  }
}

function messageView(message: AgentMessage): MessageView {
  if (message.role === "tool") {
    return { role: "tool", text: message.text, callId: message.callId };
  }
  const attachments = message.parts?.flatMap((part) => (part.type === "blob" ? [part.ref] : []));
  return {
    role: message.role,
    text: message.text,
    ...(message.role === "assistant" && message.calls
      ? {
          calls: message.calls.map((call) => ({
            id: call.id,
            name: call.name,
            args: call.args,
          })),
        }
      : {}),
    ...(attachments?.length ? { attachments } : {}),
  };
}

function liveMessages(turn: Exclude<TurnState, { status: "done" }>) {
  if (turn.status === "idle") return [];
  return turn.turn.messages.map(messageView);
}

export function project(snapshot: SessionState, model: string): SessionView {
  const conversation = snapshot.durable.conversation;
  const policy = snapshot.durable.policy;
  return {
    sessionId: conversation.sessionId,
    sessionStatus: snapshot.status,
    phase: conversation.turn.status,
    policy: {
      provider: policy?.provider,
      model: policy?.model ?? model,
      thinking: policy?.thinking,
      stream: policy?.stream,
      permissions: policy?.permissions,
    },
    log: conversation.log.map((turn) => ({
      agent: turn.agent,
      outcome:
        turn.outcome.kind === "failed"
          ? { kind: turn.outcome.kind, message: turn.outcome.error.message }
          : { kind: turn.outcome.kind },
      messages: turn.messages.map(messageView),
    })),
    live: liveMessages(conversation.turn),
  };
}

function publicReceipt(receipt: EnvReceipt): PublicReceipt {
  if (receipt.kind === "failed") return { kind: "failed", message: receipt.message };
  return { kind: receipt.kind };
}

function publicSettlement(settlement: EnvSettlement) {
  if (settlement.kind === "terminal") {
    return {
      kind: "terminal",
      turnId: settlement.turnId,
      outcome: settlement.record.outcome.kind,
    };
  }
  if (settlement.kind === "failed" || settlement.kind === "closed") {
    return { kind: settlement.kind, message: settlement.message };
  }
  if (settlement.kind === "acknowledged") return { kind: "acknowledged" };
  return { kind: "branch" };
}

function demoTools() {
  return new Map([
    [
      "echo",
      defineTool({
        description: "Return the supplied text as JSON.",
        input: z.object({ text: z.string() }),
        run: ({ text }) => JSON.stringify({ echo: text }),
      }),
    ],
    [
      "now",
      defineTool({
        description: "Return the current UTC time as JSON.",
        input: z.object({}),
        run: () => JSON.stringify({ now: new Date().toISOString() }),
      }),
    ],
  ]);
}

function permissionPrompt(request: PermissionRequest): PermissionPrompt {
  return {
    requestId: request.requestId,
    turnId: request.turnId,
    tool: {
      toolCallId: request.toolCall.toolCallId,
      title: request.toolCall.title,
      name: request.toolCall.name,
      kind: request.toolCall.kind,
      rawInput: request.toolCall.rawInput,
      locations: request.toolCall.locations?.map((location) => ({ ...location })),
    },
    options: request.options.map((option) => ({
      optionId: option.optionId,
      name: option.name,
      kind: option.kind,
    })),
  };
}

function waitForAbort(signal: AbortSignal | undefined) {
  const { promise, reject } = Promise.withResolvers<never>();
  const fail = () => reject(signal?.reason ?? new Error("aborted"));
  if (signal?.aborted) fail();
  else signal?.addEventListener("abort", fail, { once: true });
  return promise;
}

async function fixtureThink(signal: AbortSignal | undefined) {
  if (process.env.LABKIT_FIXTURE_HOLD === "1") {
    await waitForAbort(signal);
    return;
  }
  const delayMs = Number.isFinite(FIXTURE_DELAY_MS) ? Math.max(0, FIXTURE_DELAY_MS) : 1500;
  if (delayMs === 0) return;
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, delayMs);
  const onAbort = () => {
    clearTimeout(timer);
    reject(signal?.reason ?? new Error("aborted"));
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await promise;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function lastUserText(body: unknown) {
  if (!body || typeof body !== "object") return "";
  const input = (body as { input?: unknown }).input;
  if (!Array.isArray(input)) return "";
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (!item || typeof item !== "object") continue;
    const row = item as { role?: unknown; content?: unknown };
    if (row.role !== "user") continue;
    return typeof row.content === "string" ? row.content : "";
  }
  return "";
}

function fixtureFetch(): typeof fetch {
  return (async (_url, init) => {
    await fixtureThink(init?.signal ?? undefined);
    let body: unknown = {};
    try {
      body = JSON.parse(String(init?.body ?? "{}"));
    } catch {
      body = {};
    }
    const input =
      body && typeof body === "object" ? (body as { input?: unknown }).input : undefined;
    const hasToolResult =
      Array.isArray(input) &&
      input.some(
        (item) =>
          item &&
          typeof item === "object" &&
          (item as { type?: unknown }).type === "function_call_output",
      );
    const text = lastUserText(body);
    if (!hasToolResult && (/\becho\b/i.test(text) || /use tools?/i.test(text))) {
      const match = text.match(/echo\s+(.+)$/i);
      const payload = match?.[1]?.trim() || "hi";
      return Response.json({
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Calling echo." }],
          },
          {
            type: "function_call",
            call_id: "echo-1",
            name: "echo",
            arguments: JSON.stringify({ text: payload }),
          },
        ],
      });
    }
    return Response.json({
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: hasToolResult ? "Tool finished." : "fixture",
            },
          ],
        },
      ],
    });
  }) as typeof fetch;
}

function requestPermissionFor(hosted: Hosted): PermissionPort {
  return (request, signal) => {
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const pending: PendingPermission = { request, resolve, reject };
    hosted.pendingPermissions.set(request.requestId, pending);
    publish(hosted, { kind: "permission", request: permissionPrompt(request) });
    const onAbort = () => {
      if (!hosted.pendingPermissions.delete(request.requestId)) return;
      publish(hosted, { kind: "permission_clear", requestId: request.requestId });
      reject(signal.reason ?? new Error("aborted"));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    return promise.finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  };
}

export async function openSession(input: CreateSessionBody = {}) {
  const bound = boundProfiles();
  const selected = bound.find((profile) => profile.profile.id === input.providerId) ?? bound[0];
  const model = input.model?.trim() || selected?.defaultModel || "fixture";
  const stream = Boolean(input.stream && selected?.profile.capabilities.stream);
  const thinking = input.thinking || "off";
  const subscribers = new Set<Subscriber>();
  const hosted: Hosted = {
    subscribers,
    model,
    runtime: undefined as unknown as SessionRuntime,
    pendingPermissions: new Map(),
  };
  const observe = (snapshot: SessionState) => {
    if (snapshot.durable.conversation.turn.status === "idle") {
      for (const requestId of hosted.pendingPermissions.keys()) {
        publish(hosted, { kind: "permission_clear", requestId });
      }
      hosted.pendingPermissions.clear();
    }
    publish(hosted, { kind: "snapshot", view: project(snapshot, hosted.model) });
  };
  const streamUpdate = (notification: HostStreamNotification) => {
    publish(hosted, {
      kind: "delta",
      turnId: notification.turnId,
      text: notification.text,
      thinking: notification.thinking,
      status: notification.status,
    });
  };
  const toolUpdate = (notification: HostToolNotification) => {
    publish(hosted, {
      kind: "tool",
      turnId: notification.turnId,
      name: notification.sessionUpdate === "tool_call" ? notification.name : undefined,
      status: notification.status,
      args: notification.sessionUpdate === "tool_call" ? notification.rawInput : undefined,
      result: "rawOutput" in notification ? notification.rawOutput : undefined,
    });
  };
  const configuration = {
    agent: "operator",
    agents: new Map([["operator", { model, systemPrompt: SYSTEM, tools: ["echo", "now"] }]]),
    steps: 6,
  };
  const bindings = {
    tools: demoTools(),
    observe,
    streamUpdate,
    toolUpdate,
    requestPermission: requestPermissionFor(hosted),
  };
  const permissions = "ask" as const;
  hosted.runtime = selected
    ? await createSession({
        persistence,
        configuration: {
          ...configuration,
          policy: {
            provider: selected.profile.id,
            stream,
            thinking: thinking as "off",
            maxOutputTokens: 2048,
            permissions,
          },
        },
        bindings: {
          ...bindings,
          providers: new Map(
            bound.map((profile) => [
              profile.profile.id,
              {
                profile: profile.profile,
                transport: { baseUrl: profile.baseUrl, headers: profile.headers, fetch },
              },
            ]),
          ),
        },
      })
    : await createSession({
        persistence,
        configuration: {
          ...configuration,
          policy: {
            provider: openaiResponses.id,
            stream: false,
            thinking: "off",
            maxOutputTokens: 2048,
            permissions,
          },
        },
        bindings: {
          ...bindings,
          providers: new Map([
            [
              openaiResponses.id,
              {
                profile: openaiResponses,
                transport: {
                  baseUrl: "https://fixture.invalid/v1",
                  fetch: fixtureFetch(),
                },
              },
            ],
          ]),
        },
      });
  const sessionId = hosted.runtime.snapshot.durable.conversation.sessionId;
  sessions.set(sessionId, hosted);
  return { sessionId, view: project(hosted.runtime.snapshot, model), host: hostInfo() };
}

export async function admit(sessionId: string, event: unknown) {
  const hosted = sessions.get(sessionId);
  if (!hosted) return { status: 404 as const, body: { error: "Unknown session" } };
  if (!event || typeof event !== "object" || !("type" in event) || typeof event.type !== "string") {
    return { status: 400 as const, body: { error: "Event type is required" } };
  }
  if (!ADMITTED[event.type]) {
    return { status: 400 as const, body: { error: "Event is not admitted by this console" } };
  }
  try {
    const handle = hosted.runtime.dispatch(event);
    const receipt = await handle.accepted;
    void handle.settled.then(
      (settlement) => {
        publish(hosted, { kind: "settled", settlement: publicSettlement(settlement) });
      },
      (error: unknown) => {
        publish(hosted, {
          kind: "settled",
          settlement: {
            kind: "failed",
            message: error instanceof Error ? error.message : String(error),
          },
        });
      },
    );
    const body = { receipt: publicReceipt(receipt) };
    publish(hosted, { kind: "receipt", receipt: body.receipt });
    return { status: 200 as const, body };
  } catch (error) {
    return {
      status: 400 as const,
      body: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

export async function answerPermission(
  sessionId: string,
  body: { requestId?: unknown; optionId?: unknown },
) {
  const hosted = sessions.get(sessionId);
  if (!hosted) return { status: 404 as const, body: { error: "Unknown session" } };
  if (typeof body.requestId !== "string") {
    return { status: 400 as const, body: { error: "requestId is required" } };
  }
  const pending = hosted.pendingPermissions.get(body.requestId);
  if (!pending) return { status: 404 as const, body: { error: "Unknown permission request" } };
  if (body.optionId !== "allow-once" && body.optionId !== "reject-once") {
    return { status: 400 as const, body: { error: "optionId must be allow-once or reject-once" } };
  }
  hosted.pendingPermissions.delete(body.requestId);
  publish(hosted, { kind: "permission_clear", requestId: body.requestId });
  pending.resolve({ outcome: { outcome: "selected", optionId: body.optionId } });
  return { status: 200 as const, body: { ok: true } };
}

export async function storeBlob(
  sessionId: string,
  bytes: Uint8Array,
  media: string,
  name?: string,
) {
  if (!sessions.has(sessionId)) throw new Response("Unknown session", { status: 404 });
  if (bytes.byteLength > MAX_BLOB_BYTES) throw new Response("Blob exceeds 8 MiB", { status: 413 });
  const parsed = MediaKindSchema.safeParse(media);
  if (!parsed.success) throw new Response("Unsupported media", { status: 415 });
  return persistence.putBlob(
    SessionIdSchema.parse(sessionId),
    bytes,
    { media: parsed.data, ...(name ? { name } : {}) },
    AbortSignal.timeout(30_000),
  );
}

export async function readBlob(sessionId: string, blobId: string) {
  if (!sessions.has(sessionId)) return null;
  const loaded = await persistence.getBlob(
    SessionIdSchema.parse(sessionId),
    BlobIdSchema.parse(blobId),
    AbortSignal.timeout(30_000),
  );
  return "kind" in loaded ? null : loaded;
}

export function eventResponse(sessionId: string, signal: AbortSignal) {
  const hosted = sessions.get(sessionId);
  if (!hosted) return new Response("Unknown session", { status: 404 });
  const encoder = new TextEncoder();
  let subscriber: Subscriber = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      subscriber = (event) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      hosted.subscribers.add(subscriber);
      subscriber({ kind: "snapshot", view: project(hosted.runtime.snapshot, hosted.model) });
      for (const pending of hosted.pendingPermissions.values()) {
        subscriber({ kind: "permission", request: permissionPrompt(pending.request) });
      }
      const stop = () => {
        hosted.subscribers.delete(subscriber);
        try {
          controller.close();
        } catch {
          /* Already closed. */
        }
      };
      signal.addEventListener("abort", stop, { once: true });
    },
    cancel() {
      hosted.subscribers.delete(subscriber);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}
