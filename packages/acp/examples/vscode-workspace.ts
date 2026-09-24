import {
  anthropicMessagesV3,
  googleGenerateV3,
  openaiChatV2,
  openaiResponsesV3,
} from "@labkit-agent/core/providers";
import { createMemoryPersistence } from "@labkit-agent/core/testing";

import type { AcpOptions } from "../adapter.ts";
import { workspaceFiles } from "../workspace-files.ts";
import { workspaceTools } from "../workspace-tools.ts";

/** Exported separately for injected-environment tests. Keys stay in transport bindings. */
export function workspaceAgent(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AcpOptions {
  const profiles = [anthropicMessagesV3, openaiChatV2, openaiResponsesV3, googleGenerateV3];
  const id = env.LABKIT_ACP_PROVIDER ?? anthropicMessagesV3.id;
  const profile = profiles.find((entry) => entry.id === id);
  if (!profile) throw new Error("LABKIT_ACP_PROVIDER must name a supported streaming profile");
  const model = env.LABKIT_ACP_MODEL;
  if (!model) throw new Error("Set LABKIT_ACP_MODEL to your provider's model ID");
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
  let warned = false;
  return {
    loadSession: false,
    async sessionOptions({ cwd, sessionId, signal }) {
      if (sessionId)
        throw new Error(
          "This example uses memory persistence; loading after restart is unavailable",
        );
      signal.throwIfAborted();
      const files = await workspaceFiles(cwd);
      signal.throwIfAborted();
      if (!warned) {
        console.error(
          "Labkit: session journals and blobs are process-local memory only; restart loses them. session/load is disabled.",
        );
        warned = true;
      }
      const tools = workspaceTools(files);
      return {
        persistence: createMemoryPersistence(),
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
                systemPrompt: `You are a workspace file assistant rooted at ${files.root}. Use read_file to ground answers in actual file contents. Use only the provided workspace tools. Do not claim to have read a file without a tool result or supplied attachment. Never use shell commands. Ask before writing; file tools require user approval.`,
              },
            ],
          ]),
          steps: 12,
          policy: {
            provider: profile.id,
            model,
            permissions: "ask",
            stream: true,
            thinking: "off",
            maxOutputTokens: 4096,
          },
        },
        bindings: {
          tools,
          providers: new Map([[profile.id, { profile, transport: { baseUrl, headers } }]]),
        },
      };
    },
  };
}
// Resolve environment only when the host opens a session; importing this example performs no I/O.
let options: AcpOptions | undefined;
export default {
  loadSession: false,
  sessionOptions: (context) => {
    options ??= workspaceAgent();
    return options.sessionOptions(context);
  },
} satisfies AcpOptions;
