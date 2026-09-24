import type { PolicyPatch } from "@labkit-agent/core";
import {
  anthropicMessagesV3,
  anthropicMessagesV4,
  googleGenerateV3,
  openaiChatV2,
  openaiResponsesV3,
} from "@labkit-agent/core/providers";

import type { AcpOptions } from "../adapter.ts";
import { terminalTool } from "../client-terminal.ts";
import { workspaceToolContent } from "../file-write.ts";
import { planTool } from "../plan.ts";
import type { AcpConfigBinding } from "../session-config.ts";
import { workspaceDirectory } from "../workspace-directory.ts";
import { workspaceFiles } from "../workspace-files.ts";
import { workspacePersistence } from "../workspace-persistence.ts";
import { workspaceTools } from "../workspace-tools.ts";

/** Exported separately for injected-environment tests. Keys stay in transport bindings. */
export function workspaceAgent(
  env: Readonly<Record<string, string | undefined>> = process.env,
  directory = workspaceDirectory(),
): AcpOptions {
  const id = env.LABKIT_ACP_PROVIDER ?? "anthropic";
  const profiles = new Map([
    [
      "anthropic",
      env.LABKIT_ACP_THINKING_MODE === "budget" ? anthropicMessagesV3 : anthropicMessagesV4,
    ],
    ["openai", openaiChatV2],
    ["openai-responses", openaiResponsesV3],
    ["google", googleGenerateV3],
  ]);
  const profile = profiles.get(id);
  if (!profile)
    throw new Error(
      `Unsupported LABKIT_ACP_PROVIDER ${JSON.stringify(id)}; choose anthropic, openai, openai-responses, or google. Adapter profile IDs are not provider selections.`,
    );
  const model = env.LABKIT_ACP_MODEL;
  if (!model) throw new Error("Set LABKIT_ACP_MODEL to your provider's model ID");
  const models = [
    ...new Set([
      model,
      ...(env.LABKIT_ACP_MODELS ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ]),
  ];
  const maxOutputTokens = Number(env.LABKIT_ACP_MAX_OUTPUT_TOKENS ?? 16384);
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0)
    throw new Error("LABKIT_ACP_MAX_OUTPUT_TOKENS must be a positive integer");
  const outputLimits = [...new Set([4096, 8192, 16384, 32768, maxOutputTokens])].sort(
    (a, b) => a - b,
  );
  const capability = profile.capabilities.thinking;
  const thinking =
    capability.mode === "effort"
      ? ["off" as const, ...capability.values.filter((value) => value !== "none")]
      : capability.mode === "off"
        ? ["off" as const]
        : capability.mode === "budget"
          ? ["off" as const, "budget" as const]
          : ["off" as const, "adaptive" as const];
  const anthropic = id.startsWith("anthropic");
  const google = id.startsWith("google");
  const keyName = anthropic ? "ANTHROPIC_API_KEY" : google ? "GOOGLE_API_KEY" : "OPENAI_API_KEY";
  const key = env[keyName];
  if (!key) throw new Error(`Set ${keyName} before launching Labkit`);
  const baseUrl =
    env.LABKIT_ACP_BASE_URL ??
    (anthropic
      ? "https://api.anthropic.com/v1"
      : google
        ? "https://generativelanguage.googleapis.com/v1beta"
        : "https://api.openai.com/v1");
  const headers: Record<string, string> = anthropic
    ? { "x-api-key": key }
    : google
      ? { "x-goog-api-key": key }
      : { Authorization: `Bearer ${key}` };
  return {
    loadSession: true,
    forkSession: true,
    additionalDirectories: true,
    listSessions: (params, signal) => directory.list(params, signal),
    deleteSession: (params, signal) => directory.deleteSession(params, signal),
    sessionInfo: (params, signal) => directory.info(params, signal),
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
      const files = await workspaceFiles(cwd, additionalDirectories);
      signal.throwIfAborted();
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
          current: (policy) => policy.model ?? model,
          options: models.map((value) => ({ value, name: value, patch: { model: value } })),
        },
        {
          id: "thinking",
          name: "Thinking",
          category: "thought_level",
          current: (policy) =>
            policy.thinking === "budget"
              ? `budget:${policy.thinkingBudgetTokens}`
              : (policy.thinking ?? "off"),
          options: thinking.flatMap<{ value: string; name: string; patch: PolicyPatch }>((value) =>
            value === "budget"
              ? [4096, 8192, 16384].map((tokens) => ({
                  value: `budget:${tokens}`,
                  name: `Manual thinking: ${tokens.toLocaleString("en-US")} tokens (output limit must be higher)`,
                  patch: { thinking: "budget" as const, thinkingBudgetTokens: tokens },
                }))
              : [
                  {
                    value,
                    name: value === "off" ? "Off" : value === "adaptive" ? "Adaptive" : value,
                    patch: { thinking: value, thinkingBudgetTokens: null },
                  },
                ],
          ),
        },
        {
          id: "max_output_tokens",
          name: "Maximum output tokens (thinking and answer)",
          current: (policy) => String(policy.maxOutputTokens),
          options: outputLimits.map((tokens) => ({
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
                model,
                tools: [...tools.keys()],
                // Omitting successors permits handoff to all registered agents, including self.
                successors: [],
                systemPrompt: `You are a workspace file assistant rooted at ${files.root}. Use read_file to ground answers in actual file contents. Use only the provided workspace tools. Do not claim to have read a file without a tool result or supplied attachment. For complex tasks, use update_plan when available to publish and update the complete plan. Only run commands if run_command is available. Ask before writing; file tools require user approval.`,
              },
            ],
          ]),
          steps: 12,
          policy: {
            provider: id,
            model,
            permissions: "ask",
            toolFailure: "return-error-and-continue",
            stream: true,
            thinking: "off",
            maxOutputTokens,
          },
        },
        bindings: {
          tools,
          providers: new Map([
            [
              id,
              {
                profile,
                models: new Map(models.map((model) => [model, { wireModel: model, profile }])),
                transport: { baseUrl, headers },
              },
            ],
          ]),
        },
      };
    },
  };
}
// Resolve environment only when the host opens a session; importing this example performs no I/O.
let options: AcpOptions | undefined;

let directory: ReturnType<typeof workspaceDirectory> | undefined;

function discovery() {
  directory ??= workspaceDirectory();
  return directory;
}
export default {
  loadSession: true,
  forkSession: true,
  additionalDirectories: true,
  deleteSession: (params, signal) => discovery().deleteSession(params, signal),
  sessionInfo: (params, signal) => discovery().info(params, signal),
  listSessions: (params, signal) => {
    return discovery().list(params, signal);
  },
  sessionOptions: (context) => {
    options ??= workspaceAgent(process.env, discovery());
    return options.sessionOptions(context);
  },
} satisfies AcpOptions;
