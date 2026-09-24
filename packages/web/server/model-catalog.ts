import {
  anthropicMessagesV3,
  anthropicMessagesV4,
  googleGenerateV3,
  openaiChatV2,
  openaiResponsesV3,
  type CompletionProfile,
} from "../../core/providers/index.ts";

const SOURCE = "https://models.dev/catalog.json";
const SNAPSHOT = new URL("./models.dev.json", import.meta.url);

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

export type WiredModel = {
  id: string;
  label: string;
  wireModel: string;
  profile: CompletionProfile;
  thinking: string[];
  maxOutputTokens?: number;
  thinkingBudgetMin?: number;
  omitThinkingWhenOff: boolean;
};

export type WiredProvider = {
  id: string;
  label: string;
  defaultModel: string;
  baseUrl: string;
  headers: Record<string, string>;
  models: WiredModel[];
};

const EFFORT = new Set(["low", "medium", "high"]);

const TRANSPORTS: Record<
  string,
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

const SKIP =
  /realtime|computer-use|transcribe|live-translate|deep-research|image|voice|tts|stt|omni-flash/i;

let cached: Promise<WiredProvider[]> | undefined;

function modelList(models: CatalogProviderRecord["models"]) {
  return Array.isArray(models) ? models : Object.values(models);
}

function chatModels(models: CatalogProviderRecord["models"]) {
  return modelList(models)
    .filter(
      (model) =>
        model.tool_call &&
        model.modalities?.output?.includes("text") &&
        (model.limit?.output ?? 0) > 0 &&
        !SKIP.test(model.id),
    )
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
  if (providerId === "xai") return openaiChatV2;
  return openaiResponsesV3;
}

function thinkingFor(providerId: string, model: CatalogModelRecord, profile: CompletionProfile) {
  const values: string[] = [];
  const effort = option(model, "effort");
  const budget = option(model, "budget_tokens");
  const mode = profile.capabilities.thinking.mode;
  const requiresEffort = Boolean(effort && !effort.values?.includes("none"));
  if (!requiresEffort) values.push("off");
  if (providerId === "anthropic" && mode === "adaptive") values.push("adaptive");
  if (mode === "budget" && budget) values.push("budget");
  if (mode === "effort") {
    const allowed = effort?.values?.filter((value) => EFFORT.has(value)) ?? [];
    if (allowed.length) values.push(...allowed);
    else if (model.reasoning && !effort && !budget && providerId === "xai")
      values.push("low", "medium", "high");
  }
  return values.length ? values : ["off"];
}

function wire(provider: CatalogProviderRecord, key: string): WiredProvider | undefined {
  const transport = TRANSPORTS[provider.id];
  if (!transport) return undefined;
  const models = chatModels(provider.models).map((model) => {
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
  const first = models[0];
  if (!first) return undefined;
  return {
    id: provider.id,
    label: provider.name,
    defaultModel: first.id,
    baseUrl: transport.baseUrl,
    headers: transport.header(key),
    models,
  };
}

async function readSnapshot() {
  return (await Bun.file(SNAPSHOT).json()) as { providers: Record<string, CatalogProviderRecord> };
}

async function loadProviders() {
  try {
    const response = await fetch(SOURCE, { signal: AbortSignal.timeout(4000) });
    if (response.ok) {
      const body = (await response.json()) as { providers?: Record<string, CatalogProviderRecord> };
      if (body.providers?.anthropic && body.providers.openai) return body.providers;
    }
  } catch {
    /* The committed snapshot is the catalog when models.dev is unreachable. */
  }
  return (await readSnapshot()).providers;
}

export function wiredProviders() {
  cached ??= loadProviders().then((providers) => {
    const bound: WiredProvider[] = [];
    for (const id of ["anthropic", "openai", "google", "xai"]) {
      const provider = providers[id];
      const key = provider?.env?.map((name) => process.env[name]).find((value) => value);
      if (!provider || !key) continue;
      const wired = wire(provider, key);
      if (wired) bound.push(wired);
    }
    return bound;
  });
  return cached;
}
