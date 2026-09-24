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
import { openaiResponses, type CompletionProfile } from "../../core/providers/index.ts";
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
  FailureView,
  HostInfo,
  MessageView,
  OutcomeView,
  PermissionPrompt,
  ProviderOption,
  PublicReceipt,
  SessionView,
} from "../protocol.ts";
import { wiredProviders, type WiredModel, type WiredProvider } from "./model-catalog.ts";

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

type CatalogModel = WiredModel;

type CatalogProvider = WiredProvider;

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
  if (capability.mode === "adaptive") values.push("adaptive");
  if (capability.mode === "budget") values.push("budget");
  return values;
}

function model(id: string, label: string, profile: CompletionProfile): CatalogModel {
  return {
    id,
    label,
    wireModel: id,
    profile,
    thinking: thinkingChoices(profile),
    omitThinkingWhenOff: profile.capabilities.thinking.mode === "effort",
  };
}

function providerCatalog() {
  return wiredProviders();
}

function fixtureProvider(): CatalogProvider {
  return {
    id: "fixture",
    label: "Fixture",
    defaultModel: "fixture",
    baseUrl: "https://fixture.invalid/v1",
    headers: {},
    models: [model("fixture", "Fixture", openaiResponses)],
  };
}

function publicProvider(provider: CatalogProvider): ProviderOption {
  const fallback = provider.models[0];
  return {
    id: provider.id,
    label: provider.label,
    stream: provider.models.some((entry) => entry.profile.capabilities.stream),
    thinking: fallback?.thinking ?? ["off"],
    media: [...new Set(provider.models.flatMap((entry) => entry.profile.capabilities.media))],
    defaultModel: provider.defaultModel,
    models: provider.models.map((entry) => ({
      id: entry.id,
      label: entry.label,
      stream: entry.profile.capabilities.stream,
      thinking: entry.thinking,
      ...(entry.maxOutputTokens === undefined ? {} : { maxOutputTokens: entry.maxOutputTokens }),
      ...(entry.thinkingBudgetMin === undefined
        ? {}
        : { thinkingBudgetMin: entry.thinkingBudgetMin }),
    })),
  };
}

export async function hostInfo(): Promise<HostInfo> {
  const catalog = await providerCatalog();
  if (!catalog.length) return { mode: "fixture", providers: [publicProvider(fixtureProvider())] };
  return { mode: "live", providers: catalog.map(publicProvider) };
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

function failureView(error: {
  message: string;
  classification?: string;
  phase?: string;
  timeoutMs?: number;
  operation?: { id: string; kind: string; toolName?: string; callId?: string };
  cause?: unknown;
}): FailureView {
  let cause: string | undefined;
  if (typeof error.cause === "string") cause = error.cause;
  else if (error.cause && typeof error.cause === "object" && "message" in error.cause) {
    const message = error.cause.message;
    if (typeof message === "string" && message !== error.message) cause = message;
  }
  return {
    message: error.message,
    ...(error.classification ? { classification: error.classification } : {}),
    ...(error.phase ? { phase: error.phase } : {}),
    ...(error.timeoutMs ? { timeoutMs: error.timeoutMs } : {}),
    ...(error.operation
      ? {
          operation: {
            id: error.operation.id,
            kind: error.operation.kind,
            ...(error.operation.toolName ? { toolName: error.operation.toolName } : {}),
            ...(error.operation.callId ? { callId: error.operation.callId } : {}),
          },
        }
      : {}),
    ...(cause ? { cause } : {}),
  };
}

function outcomeView(outcome: {
  kind: string;
  error?: Parameters<typeof failureView>[0];
  reason?: Parameters<typeof failureView>[0];
}): OutcomeView {
  const failure = outcome.kind === "failed" ? outcome.error : outcome.reason;
  return { kind: outcome.kind, ...(failure ? { failure: failureView(failure) } : {}) };
}

export function project(
  snapshot: SessionState,
  fallbackModel: string,
  resolved?: {
    provider: string;
    model: string;
    wireModel: string;
    profile: string;
    capabilities: { stream: boolean };
  },
): SessionView {
  const conversation = snapshot.durable.conversation;
  const policy = snapshot.durable.policy;
  return {
    sessionId: conversation.sessionId,
    sessionStatus: snapshot.status,
    phase: conversation.turn.status,
    ...(snapshot.status === "failed" ? { sessionError: failureView(snapshot.error) } : {}),
    ...(resolved
      ? {
          resolved: {
            provider: resolved.provider,
            model: resolved.model,
            wireModel: resolved.wireModel,
            profile: resolved.profile,
            stream: resolved.capabilities.stream,
          },
        }
      : {}),
    policy: {
      provider: policy?.provider,
      model: policy?.model ?? resolved?.model ?? fallbackModel,
      thinking: policy?.thinking,
      thinkingBudgetTokens: policy?.thinkingBudgetTokens,
      maxOutputTokens: policy?.maxOutputTokens,
      stream: policy?.stream,
      permissions: policy?.permissions,
      completionTimeoutMs: policy?.completionTimeoutMs,
      toolTimeoutMs: policy?.toolTimeoutMs,
    },
    log: conversation.log.map((turn) => ({
      agent: turn.agent,
      outcome: outcomeView(turn.outcome),
      messages: turn.messages.map(messageView),
    })),
    live: liveMessages(conversation.turn),
  };
}

function publicReceipt(receipt: EnvReceipt): PublicReceipt {
  if (receipt.kind === "failed") {
    return {
      kind: "failed",
      message: receipt.error?.message ?? receipt.message,
      ...(receipt.error ? { failure: failureView(receipt.error) } : {}),
    };
  }
  return { kind: receipt.kind };
}

function publicSettlement(settlement: EnvSettlement) {
  if (settlement.kind === "terminal") {
    return {
      kind: "terminal",
      turnId: settlement.turnId,
      outcome: outcomeView(settlement.record.outcome),
    };
  }
  if (settlement.kind === "failed") {
    return {
      kind: settlement.kind,
      message: settlement.error?.message ?? settlement.message,
      ...(settlement.error ? { failure: failureView(settlement.error) } : {}),
    };
  }
  if (settlement.kind === "closed") return { kind: settlement.kind, message: settlement.message };
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
  const catalog = await providerCatalog();
  const fixture = !catalog.length;
  const providers = fixture ? [fixtureProvider()] : catalog;
  const selected = providers.find((provider) => provider.id === input.providerId) ?? providers[0];
  if (!selected) throw new Error("No provider is configured");
  const chosen =
    selected.models.find((entry) => entry.id === input.model?.trim()) ??
    selected.models.find((entry) => entry.id === selected.defaultModel) ??
    selected.models[0];
  if (!chosen) throw new Error(`Provider ${selected.label} has no models`);
  const model = chosen.id;
  const stream = Boolean(input.stream && chosen.profile.capabilities.stream);
  const thinking =
    input.thinking && chosen.thinking.includes(input.thinking)
      ? input.thinking
      : (chosen.thinking.find((value) => value !== "off") ?? "off");
  const outputCap =
    input.maxOutputTokens === undefined
      ? chosen.maxOutputTokens
      : chosen.maxOutputTokens === undefined
        ? input.maxOutputTokens
        : Math.min(input.maxOutputTokens, chosen.maxOutputTokens);
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
    publish(hosted, {
      kind: "snapshot",
      view: project(snapshot, hosted.model, hosted.runtime?.model),
    });
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
    agents: new Map([
      ["operator", { model, systemPrompt: SYSTEM, tools: ["echo", "now"], successors: [] }],
    ]),
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
  hosted.runtime = await createSession({
    persistence,
    configuration: {
      ...configuration,
      policy: {
        provider: selected.id,
        model,
        stream,
        ...(thinking === "off" && chosen.omitThinkingWhenOff
          ? {}
          : { thinking: thinking as "off" }),
        ...(outputCap === undefined ? {} : { maxOutputTokens: outputCap }),
        ...(thinking === "budget"
          ? {
              thinkingBudgetTokens: input.thinkingBudgetTokens ?? chosen.thinkingBudgetMin ?? 4096,
            }
          : thinking === "off"
            ? {}
            : { thinkingBudgetTokens: null }),
        permissions,
      },
    },
    bindings: {
      ...bindings,
      providers: new Map(
        providers.map((provider) => [
          provider.id,
          {
            profile: (provider.models.find((entry) => entry.id === provider.defaultModel) ??
              provider.models[0])!.profile,
            models: new Map(
              provider.models.map((entry) => [
                entry.id,
                { wireModel: entry.wireModel, profile: entry.profile },
              ]),
            ),
            transport: {
              baseUrl: provider.baseUrl,
              headers: provider.headers,
              fetch: fixture ? fixtureFetch() : fetch,
            },
          },
        ]),
      ),
    },
  });
  const sessionId = hosted.runtime.snapshot.durable.conversation.sessionId;
  sessions.set(sessionId, hosted);
  return {
    sessionId,
    view: project(hosted.runtime.snapshot, model, hosted.runtime.model),
    host: await hostInfo(),
  };
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
  if (
    body.optionId !== "allow-once" &&
    body.optionId !== "allow-session" &&
    body.optionId !== "reject-once"
  ) {
    return {
      status: 400 as const,
      body: { error: "optionId must be allow-once, allow-session, or reject-once" },
    };
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
      subscriber({
        kind: "snapshot",
        view: project(hosted.runtime.snapshot, hosted.model, hosted.runtime.model),
      });
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
