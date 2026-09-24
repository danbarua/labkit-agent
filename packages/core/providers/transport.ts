import { z } from "zod";

import type { PreparedModel } from "../agent/agent.ts";
import { blobRefs, type BlobResolver } from "../agent/content.ts";
import { CompletionSchema } from "../agent/types.ts";
import { freeze } from "../fsm/fsm.ts";
import { diagnostic, diagnosticError } from "../logging/index.ts";
import { HANDOFF_TOOL } from "./shared.ts";
import { assembleStream } from "./stream.ts";
import {
  parseRequest,
  ProviderSettingsSchema,
  validateThinking,
  type CompletionProfile,
  type DecodedCompletion,
  type HttpRequest,
  type HttpResponse,
  type StreamAssembler,
  type StreamDeltaSink,
} from "./types.ts";

export type ProviderDiagnosticContext = Readonly<{
  sessionId?: string;
  turnId?: string;
  childId?: string;
  generation?: number;
  requestId?: string;
  httpRequestId?: string;
  provider?: string;
  model?: string;
}>;

/** Numeric usage and terminal reasons only; never copy generated content. */
function responseEvidence(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object") return {};
  const value = body as Record<string, unknown>;
  const numeric = (item: unknown): unknown => {
    if (!item || typeof item !== "object") return undefined;
    return Object.fromEntries(Object.entries(item).filter(([, n]) => typeof n === "number"));
  };
  const entries = Array.isArray(value.choices)
    ? value.choices
    : Array.isArray(value.candidates)
      ? value.candidates
      : [];
  return {
    stopReason: value.stop_reason ?? value.status,
    finishReasons: entries.map((entry) => entry?.finish_reason ?? entry?.finishReason),
    usage: numeric(value.usage ?? value.usageMetadata),
  };
}

/** Origin/version prefix and credentials are environment-owned, never journaled. */
export type TransportBinding = Readonly<{
  baseUrl: string;
  headers?: Readonly<Record<string, string>>;
  fetch?: typeof fetch;
}>;
export function httpTransport(binding: TransportBinding, legacyChatErrors = false) {
  const base = z
    .url({ protocol: /^https?$/ })
    .parse(binding.baseUrl)
    .replace(/\/+$/, "");
  const url = new URL(base);
  if (url.username || url.password || url.search || url.hash)
    throw new Error("Transport base URL must not contain credentials, query, or fragment");
  const headers = { ...binding.headers };
  const fetcher = binding.fetch ?? fetch;
  // Remove actual configured credentials even when a provider echoes them in prose.
  const secrets = Object.entries(headers)
    .filter(([name]) => /authorization|api[-_]?key|token|secret|cookie/i.test(name))
    .flatMap(([, value]) => [value, value.replace(/^(Bearer|Basic)\s+/i, "")])
    .filter(Boolean);
  const redact = (text: string) =>
    secrets.reduce((value, secret) => value.split(secret).join("[REDACTED]"), text);
  return async (
    request: HttpRequest,
    signal: AbortSignal,
    streaming?: { assembler: StreamAssembler; sink?: StreamDeltaSink },
    context: ProviderDiagnosticContext = {},
  ): Promise<HttpResponse> => {
    const started = performance.now();
    const trace = {
      ...context,
      httpRequestId: context.httpRequestId ?? crypto.randomUUID(),
      endpoint: base + request.path,
      method: request.method,
      streaming: !!streaming,
    };
    let phase = "encode";
    try {
      signal.throwIfAborted();
      if (
        !request.path.startsWith("/") ||
        request.path.startsWith("//") ||
        /[?#]/.test(request.path) ||
        request.path.split("/").includes("..")
      )
        throw new Error("Profile endpoint must be a relative API path");
      const query = request.query ? `?${new URLSearchParams(request.query)}` : "";
      phase = "fetch";
      diagnostic("provider", "debug", "provider.http.started", trace);
      const response = await fetcher(base + request.path + query, {
        method: request.method,
        ...(legacyChatErrors ? {} : { redirect: "error" as const }),
        headers: { "Content-Type": "application/json", ...request.headers, ...headers },
        body: JSON.stringify(request.body),
        signal,
      });
      const providerRequestId =
        response.headers.get("request-id") ??
        response.headers.get("x-request-id") ??
        response.headers.get("x-goog-request-id");
      const evidence = {
        ...trace,
        httpStatus: response.status,
        providerRequestId,
        durationMs: Math.round(performance.now() - started),
      };
      diagnostic("provider", "debug", "provider.http.received", evidence);
      signal.throwIfAborted();
      if (!response.ok) {
        phase = "http_error";
        const errorBody = redact(await response.text());
        diagnostic("provider", "warning", "provider.http.rejected", { ...evidence, errorBody });
        throw Object.assign(
          new Error(
            `${legacyChatErrors ? "OpenAI-compatible API request failed" : "Completion HTTP failure"} (${response.status})${providerRequestId ? ` [request ${providerRequestId}]` : ""}: ${errorBody}`,
          ),
          { httpStatus: response.status, providerRequestId, errorBody },
        );
      }
      phase = streaming ? "stream" : "response_json";
      if (streaming) {
        const body = await assembleStream(
          response,
          streaming.assembler,
          signal,
          streaming.sink,
          evidence,
          secrets,
        );
        diagnostic("provider", "debug", "provider.http.completed", {
          ...evidence,
          durationMs: Math.round(performance.now() - started),
        });
        return { status: response.status, headers: response.headers, body };
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch (cause) {
        signal.throwIfAborted();
        throw new Error("Completion response is not valid JSON", { cause });
      }
      signal.throwIfAborted();
      diagnostic("provider", "debug", "provider.http.completed", {
        ...evidence,
        durationMs: Math.round(performance.now() - started),
      });
      return { status: response.status, headers: response.headers, body };
    } catch (error) {
      const safeError = diagnosticError(error, secrets);
      diagnostic(
        "provider",
        signal.aborted ? "info" : "warning",
        signal.aborted ? "provider.http.cancelled" : "provider.http.failed",
        {
          ...trace,
          phase,
          durationMs: Math.round(performance.now() - started),
          error: safeError,
        },
      );
      // Preserve causes while ensuring credential echoes cannot enter journal errors.
      if (JSON.stringify(diagnosticError(error)) !== JSON.stringify(safeError))
        throw new Error(String(safeError.message ?? "Provider request failed"), {
          cause: safeError,
        });
      throw error;
    }
  };
}
export function canonicalRequest(prepared: PreparedModel) {
  return parseRequest(
    {
      provider: prepared.provider,
      model: prepared.model,
      messages: prepared.messages.map((message) => {
        if (message.role === "tool")
          return { role: "tool", text: message.content, callId: message.tool_call_id };
        if (message.role === "assistant" && message.tool_calls)
          return {
            role: "assistant",
            text: message.content,
            ...(message.parts ? { parts: message.parts } : {}),
            ...(message.owner ? { owner: message.owner } : {}),
            calls: message.tool_calls.map((call) => ({
              id: call.id,
              name: call.function.name,
              args: JSON.parse(call.function.arguments),
            })),
          };
        return {
          role: message.role,
          text: message.content,
          ...(message.parts ? { parts: message.parts } : {}),
          ...(message.role === "assistant" && message.owner ? { owner: message.owner } : {}),
        };
      }),
      continuations: prepared.continuations,
      tools: (prepared.tools ?? []).map((tool) => tool.function),
      temperature: prepared.temperature,
      thinking: prepared.thinking,
      stream: prepared.stream,
      maxOutputTokens: prepared.maxOutputTokens,
      successors: prepared.successors ?? [],
    },
    undefined,
    true,
  );
}
export type ProviderBindings = ReadonlyMap<
  string,
  Readonly<{ profile: CompletionProfile; transport: TransportBinding }>
>;
/** Copy binding identities/settings once. Code and credentials never enter restored state. */
export function bindProviders(bindings: ProviderBindings) {
  const bound = new Map(
    [...bindings].map(([id, binding]) => {
      if (id !== binding.profile.id) throw new Error("Provider binding identity mismatch");
      return [
        id,
        {
          profile: Object.freeze({
            ...binding.profile,
            capabilities: freeze(structuredClone(binding.profile.capabilities)),
          }),
          http: httpTransport(binding.transport),
        },
      ] as const;
    }),
  );
  return Object.freeze({
    ids: Object.freeze([...bound.keys()]),
    streams: new Map(
      [...bound].map(([id, binding]) => [
        id,
        binding.profile.capabilities.stream && !!binding.profile.stream,
      ]),
    ),
    media: new Map([...bound].map(([id, binding]) => [id, binding.profile.capabilities.media])),
    capabilities: new Map(
      [...bound].map(([id, binding]) => [
        id,
        freeze(structuredClone(binding.profile.capabilities.thinking)),
      ]),
    ),
    complete: async (
      request: PreparedModel,
      signal: AbortSignal,
      blobs?: BlobResolver,
      onDelta?: StreamDeltaSink,
      context: ProviderDiagnosticContext = {},
    ): Promise<DecodedCompletion> => {
      const started = performance.now();
      const trace = {
        ...context,
        httpRequestId: context.httpRequestId ?? crypto.randomUUID(),
        provider: request.provider,
        model: request.model,
        stream: request.stream ?? false,
        thinking: request.thinking,
        maxOutputTokens: request.maxOutputTokens,
        messageCount: request.messages.length,
        toolCount: request.tools?.length ?? 0,
      };
      let phase = "validate";
      let terminalEvidence: Record<string, unknown> = {};
      diagnostic("provider", "debug", "provider.completion.started", trace);
      try {
        if (!request.provider) throw new Error("Prepared request has no provider");
        ProviderSettingsSchema.parse({
          provider: request.provider,
          thinking: request.thinking,
          stream: request.stream,
          maxOutputTokens: request.maxOutputTokens,
        });
        const binding = bound.get(request.provider);
        if (!binding) throw new Error("Missing versioned provider binding");
        validateThinking(request.thinking, binding.profile.capabilities.thinking);
        if (request.stream && (!binding.profile.capabilities.stream || !binding.profile.stream))
          throw new Error("Unsupported streaming setting");
        const input = canonicalRequest(request);
        for (const ref of blobRefs(input.messages))
          if (!binding.profile.capabilities.media.includes(ref.media))
            throw new Error(`Provider does not support attachment media: ${ref.media}`);
        phase = "encode";
        const encoded = binding.profile.encode(input, blobs);
        phase = "transport";
        const response = await binding.http(
          encoded,
          signal,
          request.stream ? { assembler: binding.profile.stream!(), sink: onDelta } : undefined,
          trace,
        );
        terminalEvidence = responseEvidence(response.body);
        phase = "decode";
        const decoded = binding.profile.decode(response, input);
        const result = CompletionSchema.parse(decoded.completion);
        if (result.kind === "handoff" && !input.successors.includes(result.agent))
          throw new Error("Unpermitted handoff target");
        if (result.kind === "tools" && result.calls.some((call) => call.name === HANDOFF_TOOL))
          throw new Error("Reserved handoff tool cannot be executed");
        const completion = freeze({
          completion: result,
          ...(decoded.continuationPayload === undefined
            ? {}
            : { continuationPayload: z.json().parse(decoded.continuationPayload) }),
        });
        diagnostic("provider", "info", "provider.completion.completed", {
          ...trace,
          durationMs: Math.round(performance.now() - started),
          ...terminalEvidence,
          completionKind: result.kind,
          continuation: decoded.continuationPayload !== undefined,
        });
        return completion;
      } catch (error) {
        diagnostic(
          "provider",
          signal.aborted ? "info" : "warning",
          signal.aborted ? "provider.completion.cancelled" : "provider.completion.failed",
          {
            ...trace,
            ...terminalEvidence,
            phase,
            durationMs: Math.round(performance.now() - started),
            error: diagnosticError(error),
          },
        );
        throw error;
      }
    },
  });
}
