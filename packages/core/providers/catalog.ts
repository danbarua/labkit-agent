import snapshot from "./models.dev.json" with { type: "json" };
import {
  anthropicMessagesV3,
  anthropicMessagesV4,
  googleGenerateV3,
  openaiChatV2,
  openaiResponsesV3,
} from "./streaming-profiles.ts";
import type { CompletionProfile } from "./types.ts";

type ReasoningOption = {
  type?: string;
  values?: string[];
  min?: number;
  max?: number;
};

type CatalogModelRecord = {
  id: string;
  name: string;
  release_date?: string;
  reasoning?: boolean;
  reasoning_options?: ReasoningOption[];
  tool_call?: boolean;
  modalities?: { output?: string[] };
  limit?: { output?: number };
};

type CatalogProviderRecord = {
  id: string;
  name: string;
  env?: string[];
  models: CatalogModelRecord[] | Record<string, CatalogModelRecord>;
};

type Snapshot = { source: string; providers: Record<string, CatalogProviderRecord> };

const SNAPSHOT = snapshot as Snapshot;

/** Where the committed snapshot came from. The catalog is never fetched at runtime. */
export const CATALOG_SOURCE: string = SNAPSHOT.source;

/** Default origin for the local OpenAI-chat-compatible server. */
export const LOCALHOST_BASE_URL = "http://localhost:8000/v1";

export type CatalogModel = Readonly<{
  /** Application model id; this is `policy.model`. */
  id: string;
  label: string;
  wireModel: string;
  profile: CompletionProfile;
  /** Display order: "off" | "adaptive" | "budget" | effort levels. */
  thinking: readonly string[];
  maxOutputTokens?: number;
  thinkingBudgetMin?: number;
  omitThinkingWhenOff: boolean;
}>;

export type CatalogProvider = Readonly<{
  /** Application provider id; this is `policy.provider`. */
  id: string;
  label: string;
  defaultModel: string;
  baseUrl: string;
  /** Carries credentials. Never log. */
  headers: Readonly<Record<string, string>>;
  /** Name of the env var that supplied the key, never its value. */
  credential?: string;
  models: readonly CatalogModel[];
}>;

export type LocalhostResult =
  | { kind: "available"; provider: CatalogProvider }
  | { kind: "unavailable"; baseUrl: string; reason: string; status?: number };

const EFFORT: Record<string, true> = { low: true, medium: true, high: true };

const KEYED = ["anthropic", "openai", "google", "xai"] as const;

const TRANSPORTS: Record<
  (typeof KEYED)[number],
  { baseUrl: string; header: (key: string) => Record<string, string> }
> = {
  anthropic: {
    baseUrl: "https://api.anthropic.com/v1",
    header: (key) => ({ "x-api-key": key }),
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    header: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  google: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    header: (key) => ({ "x-goog-api-key": key }),
  },
  xai: {
    baseUrl: "https://api.x.ai/v1",
    header: (key) => ({ Authorization: `Bearer ${key}` }),
  },
};

const PREFERRED: Record<string, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-5.4",
  google: "gemini-2.5-flash",
  xai: "grok-4.5",
};

const SKIP =
  /realtime|computer-use|transcribe|live-translate|deep-research|image|voice|tts|stt|omni-flash/i;

function chatModels(models: CatalogProviderRecord["models"]) {
  return (Array.isArray(models) ? models : Object.values(models))
    .filter((model) => {
      if (model.tool_call === false) return false;
      if (model.modalities?.output && !model.modalities.output.includes("text")) return false;
      if (model.limit?.output === 0) return false;
      return !SKIP.test(model.id);
    })
    .sort(
      (left, right) =>
        String(right.release_date ?? "").localeCompare(String(left.release_date ?? "")) ||
        left.name.localeCompare(right.name),
    );
}

function option(model: CatalogModelRecord, type: string) {
  return model.reasoning_options?.find((entry) => entry.type === type);
}

function adaptive(model: CatalogModelRecord) {
  const effort = option(model, "effort");
  return (
    Boolean(option(model, "toggle")) ||
    Boolean(effort?.values?.some((value) => value === "max" || value === "xhigh"))
  );
}

function profileFor(providerId: string, model: CatalogModelRecord) {
  if (providerId === "anthropic") {
    if (adaptive(model)) return anthropicMessagesV4;
    return anthropicMessagesV3;
  }
  if (providerId === "google") return googleGenerateV3;
  if (providerId === "xai" || providerId === "localhost") return openaiChatV2;
  return openaiResponsesV3;
}

function thinkingFor(providerId: string, model: CatalogModelRecord, profile: CompletionProfile) {
  const values: string[] = [];
  const effort = option(model, "effort");
  const budget = option(model, "budget_tokens");
  const mode = profile.capabilities.thinking.mode;
  const alwaysOn = providerId === "anthropic" && /fable|mythos/i.test(model.id);
  if (!alwaysOn) values.push("off");
  if (providerId === "anthropic" && mode === "adaptive") values.push("adaptive");
  if (mode === "budget" && budget) values.push("budget");
  if (mode === "effort") {
    const allowed = effort?.values?.filter((value) => EFFORT[value]) ?? [];
    if (allowed.length) values.push(...allowed);
    else if (model.reasoning && !effort && !budget && providerId === "xai")
      values.push("low", "medium", "high");
  }
  return values.length ? values : ["off"];
}

function wire(
  provider: CatalogProviderRecord,
  transport: { baseUrl: string; headers: Record<string, string>; credential?: string },
): CatalogProvider | undefined {
  const models = chatModels(provider.models).map((model): CatalogModel => {
    const profile = profileFor(provider.id, model);
    const budget = option(model, "budget_tokens");
    return {
      id: model.id,
      label: model.name,
      wireModel: model.id,
      profile,
      thinking: thinkingFor(provider.id, model, profile),
      ...(model.limit?.output ? { maxOutputTokens: model.limit.output } : {}),
      ...(budget?.min ? { thinkingBudgetMin: budget.min } : {}),
      omitThinkingWhenOff: profile.capabilities.thinking.mode === "effort",
    };
  });
  const first = models.find((entry) => entry.id === PREFERRED[provider.id]) ?? models[0];
  if (!first) return undefined;
  return {
    id: provider.id,
    label: provider.name,
    defaultModel: first.id,
    baseUrl: transport.baseUrl,
    headers: transport.headers,
    ...(transport.credential ? { credential: transport.credential } : {}),
    models,
  };
}

/**
 * Binds every snapshot provider whose credential is present in `env`. Pure: the caller supplies
 * the environment, and core never reads `process.env`.
 */
export function catalogProviders(env: Readonly<Record<string, string | undefined>>): {
  providers: CatalogProvider[];
  skipped: { id: string; checked: readonly string[] }[];
} {
  const providers: CatalogProvider[] = [];
  const skipped: { id: string; checked: readonly string[] }[] = [];
  for (const id of KEYED) {
    const provider = SNAPSHOT.providers[id];
    if (!provider) continue;
    const names = provider.env ?? [];
    const credential = names.find((name) => env[name]);
    const key = credential === undefined ? undefined : env[credential];
    if (!credential || !key) {
      skipped.push({ id, checked: names });
      continue;
    }
    const transport = TRANSPORTS[id];
    const wired = wire(provider, {
      baseUrl: transport.baseUrl,
      headers: transport.header(key),
      credential,
    });
    if (wired) providers.push(wired);
  }
  return { providers, skipped };
}

type LocalList = {
  data?: Array<{ id?: string }>;
  models?: Array<{
    slug?: string;
    display_name?: string;
    supported_in_api?: boolean;
    supported_reasoning_levels?: Array<{ effort?: string }>;
  }>;
};

/**
 * Lists models from a local OpenAI-chat-compatible server via `GET <baseUrl>/models`. An
 * unreachable or empty server is reported as `unavailable`; this never throws.
 */
export async function localhostProvider(options: {
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<LocalhostResult> {
  const { baseUrl } = options;
  const request = options.fetch ?? fetch;
  try {
    const response = await request(`${baseUrl}/models`, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 2000),
    });
    if (!response.ok) {
      return {
        kind: "unavailable",
        baseUrl,
        reason: `GET /models answered HTTP ${response.status}`,
        status: response.status,
      };
    }
    const body = (await response.json()) as LocalList;
    const listed = (body.models ?? [])
      .filter((model) => model.supported_in_api !== false && model.slug)
      .map((model) => ({
        id: model.slug!,
        name: model.display_name || model.slug!,
        reasoning: true,
        reasoning_options: [
          {
            type: "effort",
            values: (model.supported_reasoning_levels ?? [])
              .map((level) => level.effort)
              .filter((effort): effort is string => Boolean(effort)),
          },
        ],
      }));
    const models =
      listed.length > 0
        ? listed
        : (body.data ?? []).flatMap((model) =>
            model.id ? [{ id: model.id, name: model.id }] : [],
          );
    const provider = wire({ id: "localhost", name: "Localhost", models }, { baseUrl, headers: {} });
    if (!provider) return { kind: "unavailable", baseUrl, reason: "GET /models listed no models" };
    return { kind: "available", provider };
  } catch (error) {
    return {
      kind: "unavailable",
      baseUrl,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
