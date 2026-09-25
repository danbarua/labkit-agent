import { diagnostic, diagnosticError } from "@labkit-agent/core/logging";
import type { Policy, PolicyPatch } from "@labkit-agent/core/policy";
import {
  CATALOG_SOURCE,
  catalogProviders,
  LOCALHOST_BASE_URL,
  localhostProvider,
  type CatalogModel,
  type CatalogProvider,
} from "@labkit-agent/core/providers";

import type { AcpOptions } from "../adapter.ts";
import { terminalTool } from "../client-terminal.ts";
import { workspaceToolContent } from "../file-write.ts";
import { planTool } from "../plan.ts";
import type { AcpPromptCapabilities } from "../prompt-input.ts";
import type { AcpConfigBinding, AcpSelectOption } from "../session-config.ts";
import { workspaceDirectory } from "../workspace-directory.ts";
import { workspaceFiles } from "../workspace-files.ts";
import { workspacePersistence } from "../workspace-persistence.ts";
import { workspaceTools } from "../workspace-tools.ts";

type Env = Readonly<Record<string, string | undefined>>;

type Selection = Readonly<{ provider: CatalogProvider; model: CatalogModel }>;

type Catalog = Readonly<{ providers: readonly CatalogProvider[]; selection: Selection }>;

const OUTPUT_PRESETS = [4096, 8192, 16384, 32768, 65536, 128000];

const BUDGET_PRESETS = [1024, 4096, 8192, 16384];

const DEFAULT_OUTPUT_TOKENS = 32768;

/** Option values name the provider first; localhost model IDs themselves contain slashes. */
function optionValue(provider: string | undefined, model: string | undefined) {
  return `${provider ?? ""}/${model ?? ""}`;
}

function find(providers: readonly CatalogProvider[], provider?: string, model?: string) {
  const bound = providers.find((entry) => entry.id === provider);
  const chosen = bound?.models.find((entry) => entry.id === model);
  return bound && chosen ? { provider: bound, model: chosen } : undefined;
}

/** `<provider>/<model>` or a bare model ID served by the first bound provider that lists it. */
function requested(providers: readonly CatalogProvider[], value: string) {
  const slash = value.indexOf("/");
  const qualified =
    slash > 0 ? find(providers, value.slice(0, slash), value.slice(slash + 1)) : undefined;
  if (qualified) return qualified;
  for (const provider of providers) {
    const model = provider.models.find((entry) => entry.id === value);
    if (model) return { provider, model };
  }
  return undefined;
}

function defaultThinking(model: CatalogModel) {
  return model.thinking.includes("off")
    ? "off"
    : (model.thinking.find((value) => value !== "budget") ?? "off");
}

/** Presets up to the model limit, plus the limit and a carried-over value the model accepts. */
function outputLimits(model: CatalogModel | undefined, policy: Policy) {
  const limit = model?.maxOutputTokens;
  const budget = policy.thinking === "budget" ? (policy.thinkingBudgetTokens ?? 0) : 0;
  const current = policy.maxOutputTokens;
  return [
    ...new Set([
      ...OUTPUT_PRESETS,
      ...(limit === undefined ? [] : [limit]),
      ...(current === undefined ? [] : [current]),
    ]),
  ]
    .filter((tokens) => (limit === undefined || tokens <= limit) && tokens > budget)
    .sort((a, b) => a - b);
}

function budgets(model: CatalogModel, maxOutputTokens: number | undefined) {
  const capability = model.profile.capabilities.thinking;
  const min = Math.max(
    model.thinkingBudgetMin ?? 0,
    capability.mode === "budget" ? capability.minTokens : 0,
  );
  const max = capability.mode === "budget" ? capability.maxTokens : undefined;
  return BUDGET_PRESETS.filter(
    (tokens) =>
      tokens >= min &&
      (max === undefined || tokens <= max) &&
      (maxOutputTokens === undefined || tokens < maxOutputTokens),
  );
}

type Thinking = NonNullable<Policy["thinking"]>;

/** Switch model and keep the policy valid for it: thinking, output limit and streaming. */
function selectModel(policy: Policy, { provider, model }: Selection): PolicyPatch {
  const limit = model.maxOutputTokens;
  const maxOutputTokens =
    policy.maxOutputTokens === undefined
      ? Math.min(DEFAULT_OUTPUT_TOKENS, limit ?? DEFAULT_OUTPUT_TOKENS)
      : Math.min(policy.maxOutputTokens, limit ?? policy.maxOutputTokens);
  const wanted = policy.thinking ?? "off";
  const budget = policy.thinkingBudgetTokens;
  const keepsBudget =
    wanted === "budget" &&
    model.thinking.includes("budget") &&
    budget != null &&
    budgets(model, maxOutputTokens).includes(budget);
  const thinking = (
    keepsBudget || (wanted !== "budget" && model.thinking.includes(wanted))
      ? wanted
      : defaultThinking(model)
  ) as Thinking;
  // Effort-profile models send "off" as reasoning effort none; keep an omitted setting omitted.
  const omit = thinking === "off" && model.omitThinkingWhenOff && policy.thinking === undefined;
  return {
    provider: provider.id,
    model: model.id,
    ...(omit ? {} : { thinking }),
    ...(keepsBudget
      ? {}
      : policy.thinkingBudgetTokens === undefined
        ? {}
        : { thinkingBudgetTokens: null }),
    maxOutputTokens,
    ...(policy.stream && !model.profile.capabilities.stream ? { stream: false } : {}),
  };
}

function thinkingChoices(model: CatalogModel | undefined, policy: Policy): AcpSelectOption[] {
  return (model?.thinking ?? ["off"]).flatMap((value): AcpSelectOption[] =>
    value === "budget"
      ? budgets(model!, policy.maxOutputTokens).map((tokens) => ({
          value: `budget:${tokens}`,
          name: `Manual thinking: ${tokens.toLocaleString("en-US")} tokens`,
          patch: { thinking: "budget", thinkingBudgetTokens: tokens },
        }))
      : [
          {
            value,
            name:
              value === "off"
                ? "Off"
                : value === "adaptive"
                  ? "Adaptive"
                  : value.charAt(0).toUpperCase() + value.slice(1),
            patch: { thinking: value as Thinking, thinkingBudgetTokens: null },
          },
        ],
  );
}

async function discover(env: Env, fetchImpl: typeof fetch | undefined): Promise<Catalog> {
  const { providers: keyed, skipped } = catalogProviders(env);
  const baseUrl = env.LABKIT_LOCAL_BASE_URL ?? LOCALHOST_BASE_URL;
  const local = await localhostProvider({ baseUrl, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  if (local.kind === "unavailable")
    diagnostic("acp", "info", "acp.catalog.localhost_unavailable", {
      baseUrl: local.baseUrl,
      reason: local.reason,
      status: local.status,
      consequence: "localhost models are not offered; other providers are unaffected",
    });
  const providers = local.kind === "available" ? [...keyed, local.provider] : keyed;
  diagnostic("acp", "info", "acp.catalog.loaded", {
    source: CATALOG_SOURCE,
    providers: providers.map((provider) => ({
      id: provider.id,
      label: provider.label,
      models: provider.models.length,
      credential: provider.credential,
    })),
    skipped,
    localhost:
      local.kind === "available"
        ? { status: "available", baseUrl }
        : { status: "unavailable", baseUrl: local.baseUrl, reason: local.reason },
  });
  const first = providers[0];
  if (!first) {
    const keys = skipped.map(({ id, checked }) => `${id}: ${checked.join(" or ")}`).join("; ");
    const reason = local.kind === "unavailable" ? local.reason : "no models";
    throw new Error(
      `No model provider is available. Set an API key (${keys}) or start an OpenAI-compatible server at ${baseUrl} (LABKIT_LOCAL_BASE_URL); it was unavailable: ${reason}.`,
    );
  }
  const fallback = find(providers, first.id, first.defaultModel);
  if (!fallback) throw new Error(`Catalog provider ${first.id} lacks its default model`);
  const wanted = env.LABKIT_ACP_MODEL;
  const chosen = wanted ? requested(providers, wanted) : undefined;
  if (wanted && !chosen)
    diagnostic("acp", "warning", "acp.catalog.default_model_unresolved", {
      requested: wanted,
      fallbackProvider: fallback.provider.id,
      fallbackModel: fallback.model.id,
      available: providers.map((provider) => provider.id),
      consequence: `new sessions start with ${optionValue(fallback.provider.id, fallback.model.id)}; saved sessions keep their model`,
    });
  return { providers, selection: chosen ?? fallback };
}

/** Provider ids with at least one bound model whose profile accepts matching media. */
function accepting(providers: readonly CatalogProvider[], media: (kind: string) => boolean) {
  return providers
    .filter((provider) =>
      provider.models.some((model) => model.profile.capabilities.media.some(media)),
    )
    .map((provider) => provider.id);
}

/** Advertise prompt content only when a bound catalog model accepts it. */
async function promptCapabilities(catalog: () => Promise<Catalog>): Promise<AcpPromptCapabilities> {
  let providers: readonly CatalogProvider[];
  try {
    ({ providers } = await catalog());
  } catch (error) {
    diagnostic("acp", "warning", "acp.capabilities.advertised", {
      image: false,
      audio: false,
      embeddedContext: false,
      providers: { image: [], audio: [], embeddedContext: [] },
      error: diagnosticError(error),
      reason:
        "No model provider is bound, so no prompt media is advertised; session/new reports the missing provider",
    });
    return {};
  }
  const behind = {
    image: accepting(providers, (kind) => kind.startsWith("image/")),
    audio: accepting(providers, (kind) => kind.startsWith("audio/")),
    embeddedContext: accepting(
      providers,
      (kind) => kind === "text/plain" || kind === "text/markdown",
    ),
  };
  const declared = {
    image: behind.image.length > 0,
    audio: behind.audio.length > 0,
    embeddedContext: behind.embeddedContext.length > 0,
  };
  diagnostic("acp", "info", "acp.capabilities.advertised", {
    ...declared,
    providers: behind,
    reason:
      "Prompt content is advertised only when at least one bound catalog model accepts that media",
  });
  return declared;
}

/** Launcher options; prompt capabilities always come from the catalog. */
export type WorkspaceAgentOptions = AcpOptions & {
  promptCapabilities: () => Promise<AcpPromptCapabilities>;
};

/**
 * Exported separately for injected-environment tests. Keys stay in transport bindings. `fetch`
 * replaces HTTP for localhost discovery and provider transports.
 */
export function workspaceAgent(
  env: Env = process.env,
  directory = workspaceDirectory(),
  inject: Readonly<{ fetch?: typeof fetch }> = {},
): WorkspaceAgentOptions {
  // Discovered on first use so importing performs no I/O; retried while no provider is bound.
  let catalog: Promise<Catalog> | undefined;
  const loadCatalog = () => {
    catalog ??= discover(env, inject.fetch);
    const pending = catalog;
    pending.catch(() => {
      if (catalog === pending) catalog = undefined;
    });
    return pending;
  };
  return {
    loadSession: true,
    forkSession: true,
    additionalDirectories: true,
    listSessions: (params, signal) => directory.list(params, signal),
    deleteSession: (params, signal) => directory.deleteSession(params, signal),
    sessionInfo: (params, signal) => directory.info(params, signal),
    promptCapabilities: () => promptCapabilities(loadCatalog),
    async sessionOptions({
      cwd,
      additionalDirectories,
      signal,
      mcpTools,
      clientFiles,
      terminal,
      publishPlan,
    }) {
      signal.throwIfAborted();
      const { providers, selection } = await loadCatalog();
      signal.throwIfAborted();
      const files = await workspaceFiles(cwd, additionalDirectories);
      signal.throwIfAborted();
      const current = (policy: Policy) => find(providers, policy.provider, policy.model)?.model;
      const initial = selection.model;
      const thinking = defaultThinking(initial);
      directory.remember(files.root);
      const persistence = workspacePersistence(files.root);
      const tools = new Map([...workspaceTools(files, clientFiles), ...(mcpTools ?? [])]);
      if (publishPlan) tools.set("update_plan", planTool(publishPlan));
      if (env.LABKIT_ACP_TERMINAL === "1" && terminal)
        tools.set("run_command", terminalTool(terminal, files.root));
      const config: AcpConfigBinding[] = [
        {
          id: "tool_failure",
          name: "Tool failure handling",
          current: (policy) => policy.toolFailure,
          options: [
            {
              value: "return-error-and-continue",
              name: "Report failure to the model and continue",
              patch: { toolFailure: "return-error-and-continue" },
            },
            {
              value: "fail-turn",
              name: "Stop the turn on tool failure",
              patch: { toolFailure: "fail-turn" },
            },
          ],
        },
        {
          id: "permissions",
          name: "Tool approvals",
          description:
            "Remembered approvals cover one tool and all its arguments until the session closes or tool scope changes or permissions are explicitly reset. Select Ask to clear approvals.",
          current: (policy) => policy.permissions ?? "off",
          options: [
            {
              value: "ask",
              name: "Ask / clear remembered approvals",
              patch: { permissions: "ask" },
            },
            {
              value: "off",
              name: "Allow all enabled tools without asking",
              patch: { permissions: "off" },
            },
          ],
        },
        {
          id: "stream",
          name: "Stream responses",
          category: "model_config",
          type: "boolean",
          current: (policy) => policy.stream ?? false,
          patches: { true: { stream: true }, false: { stream: false } },
        },
        {
          id: "mode",
          name: "File access",
          category: "mode",
          current: (policy) =>
            policy.tools.workspace?.some((name) => name === "write_file") ? "edit" : "read-only",
          options: [
            {
              value: "read-only",
              name: "Read only",
              description: "Read and list workspace files; tool permission is still required",
              patch: {
                tools: {
                  workspace: ["read_file", "list_dir", ...(publishPlan ? ["update_plan"] : [])],
                },
              },
            },
            {
              value: "edit",
              name: "Edit",
              description: "Read, list, and write workspace files with approval",
              patch: { tools: { workspace: [...tools.keys()] } },
            },
          ],
        },
        {
          id: "model",
          name: "Model",
          category: "model",
          current: (policy) => optionValue(policy.provider, policy.model),
          options: (policy) =>
            providers.map((provider) => ({
              group: provider.id,
              name: provider.label,
              options: provider.models.map((model) => ({
                value: optionValue(provider.id, model.id),
                name: model.label,
                patch: selectModel(policy, { provider, model }),
              })),
            })),
        },
        {
          id: "thinking",
          name: "Thinking",
          category: "thought_level",
          current: (policy) =>
            policy.thinking === "budget"
              ? `budget:${policy.thinkingBudgetTokens}`
              : (policy.thinking ?? "off"),
          options: (policy) => thinkingChoices(current(policy), policy),
        },
        {
          id: "max_output_tokens",
          name: "Maximum output tokens (thinking and answer)",
          current: (policy) => String(policy.maxOutputTokens),
          options: (policy) =>
            outputLimits(current(policy), policy).map((tokens) => ({
              value: String(tokens),
              name: tokens.toLocaleString("en-US"),
              patch: { maxOutputTokens: tokens },
            })),
        },
      ];
      return {
        config,
        toolContent: workspaceToolContent,
        commands: [
          {
            name: "review",
            description: "Review workspace files or supplied attachments",
            input: { hint: "files or review focus" },
            prompt:
              "Review the requested workspace files or supplied attachments. Ground findings in actual content; report concrete problems with file locations. Use file tools when content has not been supplied. Do not change files unless explicitly requested.",
          },
          {
            name: "explain",
            description: "Explain code using workspace evidence",
            input: { hint: "file, symbol, or question" },
            prompt:
              "Explain the requested code or design using the supplied attachments and workspace file tools. Cite relevant file paths. State what you could not verify.",
          },
          {
            name: "plan",
            description: "Plan a workspace task without implementing it",
            input: { hint: "task to plan" },
            prompt:
              "Inspect the relevant workspace content, then propose a concrete plan for the requested task. Publish the complete plan with update_plan when available. Do not implement the plan or run commands in this turn.",
          },
        ],
        persistence,
        onReady: (sessionId, signal) =>
          persistence.setScope(sessionId, files.roots.slice(1), signal),
        configuration: {
          agent: "workspace",
          agents: new Map([
            [
              "workspace",
              {
                model: initial.id,
                tools: [...tools.keys()],
                // Omitting successors permits handoff to all registered agents, including self.
                successors: [],
                systemPrompt: `You are a workspace file assistant rooted at ${files.root}. Use read_file to ground answers in actual file contents. Use only the provided workspace tools. Do not claim to have read a file without a tool result or supplied attachment. For complex tasks, use update_plan when available to publish and update the complete plan. Only run commands if run_command is available. Ask before writing; file tools require user approval.`,
              },
            ],
          ]),
          steps: 12,
          policy: {
            provider: selection.provider.id,
            model: initial.id,
            permissions: "ask",
            toolFailure: "return-error-and-continue",
            stream: initial.profile.capabilities.stream,
            ...(thinking === "off" && initial.omitThinkingWhenOff
              ? {}
              : { thinking: thinking as Thinking }),
            maxOutputTokens: Math.min(
              DEFAULT_OUTPUT_TOKENS,
              initial.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS,
            ),
          },
        },
        bindings: {
          tools,
          providers: new Map(
            providers.map((provider) => [
              provider.id,
              {
                profile: (provider.models.find((model) => model.id === provider.defaultModel) ??
                  provider.models[0])!.profile,
                models: new Map(
                  provider.models.map((model) => [
                    model.id,
                    { wireModel: model.wireModel, profile: model.profile },
                  ]),
                ),
                transport: {
                  baseUrl: provider.baseUrl,
                  headers: { ...provider.headers },
                  ...(inject.fetch ? { fetch: inject.fetch } : {}),
                },
              },
            ]),
          ),
        },
      };
    },
  };
}

// Resolve environment only when the host initializes or opens a session; importing performs no I/O.
let options: WorkspaceAgentOptions | undefined;

let directory: ReturnType<typeof workspaceDirectory> | undefined;

function discovery() {
  directory ??= workspaceDirectory();
  return directory;
}

function workspace() {
  options ??= workspaceAgent(process.env, discovery());
  return options;
}

export default {
  loadSession: true,
  forkSession: true,
  additionalDirectories: true,
  deleteSession: (params, signal) => discovery().deleteSession(params, signal),
  sessionInfo: (params, signal) => discovery().info(params, signal),
  promptCapabilities: () => workspace().promptCapabilities(),
  listSessions: (params, signal) => {
    return discovery().list(params, signal);
  },
  sessionOptions: (context) => workspace().sessionOptions(context),
} satisfies AcpOptions;
