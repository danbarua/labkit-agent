import { z } from "zod";

import type { PreparedModel } from "../agent/agent.ts";
import { blobRefs, type BlobResolver } from "../agent/content.ts";
import { CompletionSchema } from "../agent/types.ts";
import { freeze } from "../fsm/fsm.ts";
import { diagnostic, diagnosticError, redactDiagnostics } from "../logging/index.ts";
import { HANDOFF_TOOL } from "./shared.ts";
import { assembleStream } from "./stream.ts";
import {
  parseRequest,
  ProviderSettingsSchema,
  validateProviderSettings,
  type CompletionProfile,
  type DecodedCompletion,
  type HttpRequest,
  type HttpResponse,
  type StreamAssembler,
  type StreamDeltaSink,
  type validateThinking,
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
  toolCallId?: string;
}>;

export type ProviderCapture = (
  event: Readonly<{
    kind: "http_request" | "http_response" | "completion";
    httpRequestId: string;
    [key: string]: unknown;
  }>,
) => void | Promise<void>;

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
  capture?: ProviderCapture;
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
  const captureSink = binding.capture;
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
      endpoint:
        base + request.path + (request.query ? `?${new URLSearchParams(request.query)}` : ""),
      method: request.method,
      streaming: !!streaming,
    };
    const capture = async (
      kind: "http_request" | "http_response",
      fields: Record<string, unknown>,
    ) => {
      if (captureSink)
        await captureSink(
          redactDiagnostics(
            { kind, ...trace, ...fields },
            secrets,
          ) as Parameters<ProviderCapture>[0],
        );
    };
    let responseBody = "";
    let responseMetadata: Record<string, unknown> = {};
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
      await capture("http_request", {
        body: redact(JSON.stringify(request.body)),
        endpoint: base + request.path + query,
      });
      signal.throwIfAborted();
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
      responseMetadata = evidence;
      diagnostic("provider", "debug", "provider.http.received", evidence);
      signal.throwIfAborted();
      if (!response.ok) {
        phase = "http_error";
        const errorBody = redact(await response.text());
        responseBody = errorBody;
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
          async (chunk) => {
            responseBody += chunk;
            await capture("http_response", {
              ...evidence,
              body: responseBody,
              phase,
              outcome: "in_progress",
            });
          },
        );
        await capture("http_response", {
          ...evidence,
          body: responseBody,
          phase,
          ...responseEvidence(body),
          outcome: "received",
        });
        diagnostic("provider", "debug", "provider.http.completed", {
          ...evidence,
          durationMs: Math.round(performance.now() - started),
        });
        return { status: response.status, headers: response.headers, body };
      }
      let body: unknown;
      try {
        responseBody = await response.text();
        body = JSON.parse(responseBody);
      } catch (cause) {
        signal.throwIfAborted();
        throw new Error("Completion response is not valid JSON", { cause });
      }
      await capture("http_response", {
        ...evidence,
        body: responseBody,
        phase,
        ...responseEvidence(body),
      });
      signal.throwIfAborted();
      diagnostic("provider", "debug", "provider.http.completed", {
        ...evidence,
        durationMs: Math.round(performance.now() - started),
      });
      return { status: response.status, headers: response.headers, body };
    } catch (error) {
      const safeError = diagnosticError(error, secrets);
      await capture("http_response", {
        ...responseMetadata,
        body: responseBody,
        phase,
        error: safeError,
      });
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
      throw Object.assign(
        new Error(String(safeError.message ?? "Provider request failed"), { cause: safeError }),
        {
          ...safeError,
          httpStatus: responseMetadata.httpStatus,
          providerRequestId: responseMetadata.providerRequestId,
          phase,
        },
      );
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
      thinkingBudgetTokens: prepared.thinkingBudgetTokens,
      stream: prepared.stream,
      maxOutputTokens: prepared.maxOutputTokens,
      successors: prepared.successors ?? [],
    },
    undefined,
    true,
  );
}

export type ResolvedModel = Readonly<{
  provider: string;
  model: string;
  wireModel: string;
  profile: string;
  capabilities: CompletionProfile["capabilities"];
}>;

export type ProviderBindings = ReadonlyMap<
  string,
  Readonly<{
    profile: CompletionProfile;
    transport: TransportBinding;
    models?: ReadonlyMap<string, Readonly<{ wireModel: string; profile: CompletionProfile }>>;
  }>
>;
/** Copy binding identities/settings once. Code and credentials never enter restored state. */
export function bindProviders(bindings: ProviderBindings) {
  const bound = new Map(
    [...bindings].map(([id, binding]) => {
      const secrets = Object.entries(binding.transport.headers ?? {})
        .filter(([name]) => /authorization|api[-_]?key|token|secret|cookie/i.test(name))
        .flatMap(([, value]) => [value, value.replace(/^(Bearer|Basic)\s+/i, "")])
        .filter(Boolean);
      const captureSink = binding.transport.capture;
      const capture: ProviderCapture | undefined = captureSink
        ? (event) =>
            captureSink(redactDiagnostics(event, secrets) as Parameters<ProviderCapture>[0])
        : undefined;

      return [
        id,
        {
          profile: Object.freeze({
            ...binding.profile,
            capabilities: freeze(structuredClone(binding.profile.capabilities)),
          }),
          http: httpTransport(binding.transport),
          capture,
          secrets,
          models: binding.models
            ? new Map(
                [...binding.models].map(([name, model]) => [
                  name,
                  {
                    wireModel: model.wireModel,
                    profile: Object.freeze({
                      ...model.profile,
                      capabilities: freeze(structuredClone(model.profile.capabilities)),
                    }),
                  },
                ]),
              )
            : undefined,
        },
      ] as const;
    }),
  );
  return Object.freeze({
    ids: Object.freeze([...bound.keys()]),
    describe: (provider: string, model: string): ResolvedModel | undefined => {
      const binding = bound.get(provider);
      if (!binding) return undefined;
      const selected = binding.models?.get(model);
      if (binding.models && !selected) return undefined;
      const profile = selected?.profile ?? binding.profile;
      return freeze({
        provider,
        model,
        wireModel: selected?.wireModel ?? model,
        profile: profile.id,
        capabilities: profile.capabilities,
      });
    },
    validateSelection: (
      provider: string,
      model: string | undefined,
      thinking: Parameters<typeof validateThinking>[0],
      stream?: boolean,
      thinkingBudgetTokens?: number | null,
      maxOutputTokens?: number,
    ) => {
      const binding = bound.get(provider);
      if (!binding)
        throw new Error(`Unknown provider ${provider}; supported: ${[...bound.keys()].join(", ")}`);
      const selected = binding.models?.get(model ?? "");
      if (binding.models && !selected)
        throw new Error(
          `Unknown model ${model ?? "(missing)"} for ${provider}; supported: ${[...binding.models.keys()].join(", ")}`,
        );
      const profile = selected?.profile ?? binding.profile;
      validateProviderSettings(
        { thinking, thinkingBudgetTokens, maxOutputTokens },
        profile.capabilities,
      );
      if (stream && (!profile.capabilities.stream || !profile.stream))
        throw new Error(
          `Unsupported streaming for model ${model ?? "(default)"}; use stream:false`,
        );
    },
    mediaFor: (provider: string, model: string) => {
      const binding = bound.get(provider);
      return (binding?.models?.get(model)?.profile ?? binding?.profile)?.capabilities.media ?? [];
    },
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
        thinkingBudgetTokens: request.thinkingBudgetTokens,
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
          thinkingBudgetTokens: request.thinkingBudgetTokens,
          stream: request.stream,
          maxOutputTokens: request.maxOutputTokens,
        });
        const binding = bound.get(request.provider);
        if (!binding) throw new Error("Missing versioned provider binding");
        const selected = binding.models?.get(request.model);
        if (binding.models && !selected)
          throw new Error(
            `Unknown model ${request.model}; supported: ${[...binding.models.keys()].join(", ")}`,
          );
        const profile = selected?.profile ?? binding.profile;
        Object.assign(trace, {
          profile: profile.id,
          wireModel: selected?.wireModel ?? request.model,
        });
        validateProviderSettings(request, profile.capabilities);
        if (request.stream && (!profile.capabilities.stream || !profile.stream))
          throw new Error("Unsupported streaming setting");
        const input = canonicalRequest(request);
        const wireInput = {
          ...input,
          provider: profile.id,
          model: selected?.wireModel ?? input.model,
          continuations: input.continuations?.map((entry) => ({ ...entry, provider: profile.id })),
        };
        for (const ref of blobRefs(input.messages))
          if (!profile.capabilities.media.includes(ref.media))
            throw new Error(`Provider does not support attachment media: ${ref.media}`);
        phase = "encode";
        const encoded = profile.encode(wireInput, blobs);
        phase = "transport";
        const response = await binding.http(
          encoded,
          signal,
          request.stream ? { assembler: profile.stream!(), sink: onDelta } : undefined,
          trace,
        );
        terminalEvidence = {
          httpStatus: response.status,
          providerRequestId:
            response.headers.get("request-id") ?? response.headers.get("x-request-id"),
          ...responseEvidence(response.body),
        };
        phase = "decode";
        const decoded = profile.decode(response, wireInput);
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
        await bound.get(request.provider!)?.capture?.({
          kind: "completion",
          ...trace,
          ...terminalEvidence,
          phase,
          outcome: "completed",
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
        const safeError = diagnosticError(error, bound.get(request.provider ?? "")?.secrets);
        await bound.get(request.provider ?? "")?.capture?.({
          kind: "completion",
          ...trace,
          ...terminalEvidence,
          phase,
          outcome: signal.aborted ? "cancelled" : "failed",
          error: safeError,
        });
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
        throw Object.assign(
          new Error(String(safeError.message ?? "Completion failed"), { cause: safeError }),
          {
            phase,
            ...terminalEvidence,
            ...(safeError.providerStop === undefined
              ? {}
              : { providerStop: safeError.providerStop }),
          },
        );
      }
    },
  });
}
