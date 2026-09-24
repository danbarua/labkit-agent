import { z } from "zod";

import type { PreparedModel } from "../agent/agent.ts";
import { blobRefs, type BlobResolver } from "../agent/content.ts";
import { CompletionSchema } from "../agent/types.ts";
import { freeze } from "../fsm/fsm.ts";
import { HANDOFF_TOOL } from "./shared.ts";
import {
  parseRequest,
  ProviderSettingsSchema,
  validateThinking,
  type CompletionProfile,
  type DecodedCompletion,
  type HttpRequest,
  type HttpResponse,
} from "./types.ts";

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
  return async (request: HttpRequest, signal: AbortSignal): Promise<HttpResponse> => {
    signal.throwIfAborted();
    if (
      !request.path.startsWith("/") ||
      request.path.startsWith("//") ||
      /[?#]/.test(request.path) ||
      request.path.split("/").includes("..")
    )
      throw new Error("Profile endpoint must be a relative API path");
    const response = await fetcher(base + request.path, {
      method: request.method,
      ...(legacyChatErrors ? {} : { redirect: "error" as const }),
      headers: { "Content-Type": "application/json", ...request.headers, ...headers },
      body: JSON.stringify(request.body),
      signal,
    });
    if (!response.ok) {
      if (legacyChatErrors)
        throw new Error(
          `OpenAI-compatible API request failed (${response.status}): ${await response.text()}`,
        );
      throw new Error(`Completion HTTP failure (${response.status})`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      signal.throwIfAborted();
      throw new Error("Completion response is not valid JSON");
    }
    signal.throwIfAborted();
    return { status: response.status, headers: response.headers, body };
  };
}
export function canonicalRequest(prepared: PreparedModel) {
  return parseRequest({
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
  });
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
    ): Promise<DecodedCompletion> => {
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
      const input = canonicalRequest(request);
      for (const ref of blobRefs(input.messages))
        if (!binding.profile.capabilities.media.includes(ref.media))
          throw new Error(`Provider does not support attachment media: ${ref.media}`);
      const response = await binding.http(binding.profile.encode(input, blobs), signal);
      const decoded = binding.profile.decode(response, input);
      const result = CompletionSchema.parse(decoded.completion);
      if (result.kind === "handoff" && !input.successors.includes(result.agent))
        throw new Error("Unpermitted handoff target");
      if (result.kind === "tools" && result.calls.some((call) => call.name === HANDOFF_TOOL))
        throw new Error("Reserved handoff tool cannot be executed");
      return freeze({
        completion: result,
        ...(decoded.continuationPayload === undefined
          ? {}
          : { continuationPayload: z.json().parse(decoded.continuationPayload) }),
      });
    },
  });
}
