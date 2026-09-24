import { z } from "zod";

import type { TurnState } from "../../core/agent/agent-fsm.ts";
import {
  BlobIdSchema,
  MAX_BLOB_BYTES,
  MediaKindSchema,
  SessionIdSchema,
  type AgentMessage,
} from "../../core/agent/types.ts";
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
  ProviderOption,
  PublicReceipt,
  SessionView,
} from "../protocol.ts";

const SYSTEM = "You are a lab operator assistant. Be concise. Use echo and now when they help.";
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
type Hosted = {
  runtime: SessionRuntime;
  model: string;
  subscribers: Set<Subscriber>;
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
  };
  const observe = (snapshot: SessionState) => {
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
  const bindings = { tools: demoTools(), observe, streamUpdate, toolUpdate };
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
                  fetch: (async (_url, init) => {
                    if (process.env.LABKIT_FIXTURE_HOLD === "1") {
                      const { promise, reject } = Promise.withResolvers<Response>();
                      const fail = () => reject(init?.signal?.reason ?? new Error("aborted"));
                      if (init?.signal?.aborted) fail();
                      else init?.signal?.addEventListener("abort", fail, { once: true });
                      return promise;
                    }
                    return Response.json({
                      status: "completed",
                      output: [
                        {
                          type: "message",
                          role: "assistant",
                          content: [{ type: "output_text", text: "fixture" }],
                        },
                      ],
                    });
                  }) as typeof fetch,
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
