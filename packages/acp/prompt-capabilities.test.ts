import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { SessionPersistence } from "@labkit-agent/core";
import {
  anthropicMessagesV3,
  googleGenerateV3,
  openaiChatV2,
  type CompletionProfile,
} from "@labkit-agent/core/providers";
import { SessionIdSchema } from "@labkit-agent/core/types";
import { expect, test } from "@logtape/testing-bun/autoload";

import { withFixtureDiagnostics } from "../core/logging/fixture-capture.ts";
import { streamResponse, streamVector } from "../core/providers/testing/stream-vectors.ts";
import type { AcpOptions } from "./adapter.ts";
import { workspaceAgent } from "./examples/vscode-workspace.ts";
import type { AcpPromptCapabilities } from "./prompt-input.ts";
import { harness, setup } from "./testing/harness.ts";

type Flag = "image" | "audio" | "embeddedContext";

type Diagnostic = Record<string, unknown>;

const IMAGE = Buffer.from("IMAGE_CONTENT_SENTINEL").toString("base64");

const AUDIO = Buffer.from("AUDIO_CONTENT_SENTINEL").toString("base64");

const TEXT = "EMBEDDED_CONTEXT_SENTINEL";

const PDF = Buffer.from("PDF_CONTENT_SENTINEL").toString("base64");

/** Runs `callback` with fixture diagnostics and returns the parsed events it logged. */
async function captured<T>(name: string, callback: () => Promise<T>) {
  const directory = resolve(
    `.session-artifacts/acp-prompt-capabilities/${name}-${crypto.randomUUID()}`,
  );
  try {
    const result = await withFixtureDiagnostics(directory, {}, callback);
    const logs = (await Bun.file(`${directory}/diagnostics.jsonl`).text())
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Diagnostic);
    return { result, logs };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Journal record count; unchanged means nothing was admitted or journaled. */
async function journalRecords(persistence: SessionPersistence, id: string) {
  const journal = await persistence.load(SessionIdSchema.parse(id), new AbortController().signal);
  if (journal.kind !== "loaded") throw new Error(`Journal ${id} is ${journal.kind}`);
  return journal.batches.flatMap((batch) => batch.records).length;
}

/** Adapter bound to one streaming provider profile; records wire bodies and blob writes. */
function bound(profile: CompletionProfile, promptCapabilities: AcpPromptCapabilities) {
  const base = setup();
  const bodies: unknown[] = [];
  let puts = 0;
  const persistence: SessionPersistence = {
    ...base.persistence,
    putBlob: async (...args) => {
      puts++;
      return base.persistence.putBlob(...args);
    },
  };
  const options: AcpOptions = {
    ...base.options,
    promptCapabilities,
    sessionOptions: async (context) => {
      const original = await base.options.sessionOptions(context);
      return {
        ...original,
        persistence,
        configuration: {
          ...original.configuration,
          policy: {
            provider: profile.id,
            stream: true,
            thinking: profile.id === openaiChatV2.id ? "high" : "budget",
            thinkingBudgetTokens: profile.capabilities.thinking.mode === "budget" ? 1024 : null,
            maxOutputTokens: 2048,
          },
        },
        bindings: {
          ...original.bindings,
          complete: undefined,
          providers: new Map([
            [
              profile.id,
              {
                profile,
                transport: {
                  baseUrl: "https://provider.invalid",
                  fetch: (async (_url: string, init?: RequestInit) => {
                    bodies.push(JSON.parse(String(init?.body)));
                    return streamResponse(streamVector(profile));
                  }) as unknown as typeof fetch,
                },
              },
            ],
          ]),
        },
      };
    },
  };
  return { h: harness(options), persistence, bodies, puts: () => puts };
}

const cases: readonly {
  flag: Flag;
  block: ContentBlock;
  accepts: CompletionProfile;
  wire: (body: unknown) => void;
  lacking: { profile: CompletionProfile; block: ContentBlock; media: string };
}[] = [
  {
    flag: "image",
    block: { type: "image", mimeType: "image/png", data: IMAGE },
    accepts: anthropicMessagesV3,
    wire: (body) =>
      expect(body).toEqual(
        expect.objectContaining({
          messages: [
            expect.objectContaining({
              content: expect.arrayContaining([
                { type: "image", source: { type: "base64", media_type: "image/png", data: IMAGE } },
              ]),
            }),
          ],
        }),
      ),
    lacking: {
      profile: openaiChatV2,
      block: { type: "image", mimeType: "image/png", data: IMAGE },
      media: "image/png",
    },
  },
  {
    flag: "audio",
    block: { type: "audio", mimeType: "audio/wav", data: AUDIO },
    accepts: googleGenerateV3,
    wire: (body) =>
      expect(body).toEqual(
        expect.objectContaining({
          contents: [
            expect.objectContaining({
              parts: expect.arrayContaining([
                { inlineData: { mimeType: "audio/wav", data: AUDIO } },
              ]),
            }),
          ],
        }),
      ),
    lacking: {
      profile: anthropicMessagesV3,
      block: { type: "audio", mimeType: "audio/wav", data: AUDIO },
      media: "audio/wav",
    },
  },
  {
    flag: "embeddedContext",
    block: {
      type: "resource",
      resource: { uri: "untitled:notes.md", mimeType: "text/markdown", text: TEXT },
    },
    accepts: openaiChatV2,
    wire: (body) => expect(JSON.stringify(body)).toContain(TEXT),
    lacking: {
      profile: openaiChatV2,
      block: {
        type: "resource",
        resource: { uri: "untitled:report.pdf", mimeType: "application/pdf", blob: PDF },
      },
      media: "application/pdf",
    },
  },
];

const all = { image: true, audio: true, embeddedContext: true };

for (const { flag, block, accepts, wire } of cases)
  test(`promptCapabilities.${flag}: advertised content reaches a model that accepts it`, async () => {
    const { h, bodies } = bound(accepts, { [flag]: true });
    try {
      const init = await h.initialize();
      expect(init.result.agentCapabilities.promptCapabilities).toEqual({
        image: false,
        audio: false,
        embeddedContext: false,
        [flag]: true,
      });
      const id = await h.newSession();
      const response = await h.request("session/prompt", {
        sessionId: id,
        prompt: [{ type: "text", text: "Use the attachment" }, block],
      });
      expect(response.error).toBeUndefined();
      expect(response.result.stopReason).toBe("end_turn");
      expect(bodies).toHaveLength(1);
      wire(bodies[0]);
    } finally {
      await h.close();
    }
  });

for (const { flag, block, accepts } of cases)
  test(`promptCapabilities.${flag}: unadvertised content is refused before storage or journaling`, async () => {
    const { result: id, logs } = await captured(`refused-${flag}`, async () => {
      const { h, persistence, bodies, puts } = bound(accepts, { ...all, [flag]: false });
      try {
        await h.initialize();
        const id = await h.newSession();
        const before = await journalRecords(persistence, id);
        const response = await h.request("session/prompt", {
          sessionId: id,
          prompt: [{ type: "text", text: "Use the attachment" }, block],
        });
        expect(response.error?.code).toBe(-32602);
        expect(response.error?.message).toContain(
          `Prompt contains ${block.type} content, but this agent does not advertise promptCapabilities.${flag}`,
        );
        expect(await journalRecords(persistence, id)).toBe(before);
        expect(puts()).toBe(0);
        expect(bodies).toHaveLength(0);
        // The refusal leaves the session usable.
        expect(
          (
            await h.request("session/prompt", {
              sessionId: id,
              prompt: [{ type: "text", text: "hi" }],
            })
          ).result.stopReason,
        ).toBe("end_turn");
        return id;
      } finally {
        await h.close();
      }
    });
    const refused = logs.filter((line) => line.event === "acp.prompt.content_refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({
      level: "warning",
      method: "session/prompt",
      sessionId: id,
      rpcRequestId: expect.any(String),
      connectionId: expect.any(String),
      blockIndex: 1,
      blockType: block.type,
      capability: `promptCapabilities.${flag}`,
    });
  });

for (const { flag, lacking } of cases)
  test(`promptCapabilities.${flag}: advertised content the current model lacks gets the per-model refusal`, async () => {
    const { h, persistence, bodies, puts } = bound(lacking.profile, all);
    try {
      await h.initialize();
      const id = await h.newSession();
      const before = await journalRecords(persistence, id);
      const response = await h.request("session/prompt", {
        sessionId: id,
        prompt: [{ type: "text", text: "Use the attachment" }, lacking.block],
      });
      expect(response.error?.code).toBe(-32602);
      expect(response.error?.message).toContain(
        `Provider does not support attachment media: ${lacking.media}; supported media: ${lacking.profile.capabilities.media.join(", ")}. Select a model that accepts ${lacking.media}`,
      );
      expect(await journalRecords(persistence, id)).toBe(before);
      expect(puts()).toBe(0);
      expect(bodies).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

test("resource links need no prompt capability", async () => {
  const { h, bodies } = bound(openaiChatV2, {});
  try {
    await h.initialize();
    const id = await h.newSession();
    const response = await h.request("session/prompt", {
      sessionId: id,
      prompt: [
        { type: "text", text: "Read this" },
        { type: "resource_link", name: "design", uri: "https://example.invalid/DESIGN.md" },
      ],
    });
    expect(response.result.stopReason).toBe("end_turn");
    expect(JSON.stringify(bodies[0])).toContain("https://example.invalid/DESIGN.md");
  } finally {
    await h.close();
  }
});

test("a failing capability declaration refuses initialize with an explanation", async () => {
  const { logs } = await captured("declaration-failed", async () => {
    const { options } = setup();
    const h = harness({
      ...options,
      promptCapabilities: () => {
        throw new Error("catalog snapshot unreadable");
      },
    });
    try {
      const response = await h.initialize();
      expect(response.error?.code).toBe(-32603);
      expect(response.error?.message).toContain(
        "Cannot determine which prompt content this agent accepts: catalog snapshot unreadable",
      );
      expect((await h.request("session/new", { cwd: "/tmp", mcpServers: [] })).error?.code).toBe(
        -32002,
      );
    } finally {
      await h.close();
    }
  });
  expect(logs.find((line) => line.event === "acp.capabilities.failed")).toMatchObject({
    level: "error",
    method: "initialize",
    connectionId: expect.any(String),
    rpcRequestId: expect.any(String),
  });
});

async function workspace() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "labkit-acp-prompt-caps-")));
  return { cwd: root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** Localhost discovery is offline; provider transports answer with a scripted stream. */
function scripted(calls: string[]) {
  return (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.endsWith("/models")) throw new Error("connect ECONNREFUSED 127.0.0.1:8000");
    return streamResponse(streamVector(anthropicMessagesV3));
  }) as unknown as typeof fetch;
}

for (const { env, advertised, providers } of [
  {
    env: { OPENAI_API_KEY: "caps-openai" },
    advertised: { image: false, audio: false, embeddedContext: true },
    providers: { image: [], audio: [], embeddedContext: ["openai"] },
  },
  {
    env: { ANTHROPIC_API_KEY: "caps-anthropic", XAI_API_KEY: "caps-xai" },
    advertised: { image: true, audio: false, embeddedContext: true },
    providers: { image: ["anthropic"], audio: [], embeddedContext: ["anthropic", "xai"] },
  },
  {
    env: { ANTHROPIC_API_KEY: "caps-anthropic", GEMINI_API_KEY: "caps-google" },
    advertised: { image: true, audio: true, embeddedContext: true },
    providers: {
      image: ["anthropic"],
      audio: ["google"],
      embeddedContext: ["anthropic", "google"],
    },
  },
])
  test(`workspace launcher advertises prompt content from its catalog: ${Object.keys(env).join(", ")}`, async () => {
    const f = await workspace();
    const calls: string[] = [];
    try {
      const { logs } = await captured("launcher", async () => {
        const h = harness(workspaceAgent(env, undefined, { fetch: scripted(calls) }));
        try {
          expect(calls).toEqual([]);
          const init = await h.initialize();
          expect(init.result.agentCapabilities.promptCapabilities).toEqual(advertised);
          expect(calls.filter((url) => url.endsWith("/models"))).toHaveLength(1);
          const created = await h.request("session/new", { cwd: f.cwd, mcpServers: [] });
          expect(created.error).toBeUndefined();
          // session/new reuses the catalog initialize discovered.
          expect(calls.filter((url) => url.endsWith("/models"))).toHaveLength(1);
        } finally {
          await h.close();
        }
      });
      const events = logs.filter((line) => line.event === "acp.capabilities.advertised");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ level: "info", ...advertised, providers });
    } finally {
      await f.cleanup();
    }
  });

test("workspace launcher without any provider advertises no prompt content and says why", async () => {
  const calls: string[] = [];
  const { logs } = await captured("launcher-none", async () => {
    const h = harness(workspaceAgent({}, undefined, { fetch: scripted(calls) }));
    try {
      const init = await h.initialize();
      expect(init.result.agentCapabilities.promptCapabilities).toEqual({
        image: false,
        audio: false,
        embeddedContext: false,
      });
    } finally {
      await h.close();
    }
  });
  expect(logs.find((line) => line.event === "acp.capabilities.advertised")).toMatchObject({
    level: "warning",
    image: false,
    audio: false,
    embeddedContext: false,
    error: { message: expect.stringContaining("No model provider is available") },
  });
});

test("workspace launcher sends no usage, cost or context size during a completed prompt", async () => {
  const f = await workspace();
  const calls: string[] = [];
  try {
    const h = harness(
      workspaceAgent({ ANTHROPIC_API_KEY: "caps-anthropic" }, undefined, {
        fetch: scripted(calls),
      }),
    );
    try {
      await h.initialize();
      const created = await h.request("session/new", { cwd: f.cwd, mcpServers: [] });
      expect(created.error).toBeUndefined();
      const response = await h.request("session/prompt", {
        sessionId: created.result.sessionId,
        prompt: [{ type: "text", text: "Say hello" }],
      });
      expect(response.error).toBeUndefined();
      expect(response.result).toEqual({ stopReason: "end_turn" });
      // The scripted provider stream reports token usage; none of it may surface as ACP usage.
      expect(calls.some((url) => url.includes("anthropic"))).toBe(true);
      const updates = h.updates().map(({ update }) => update);
      expect(updates.some((update) => update.sessionUpdate === "agent_message_chunk")).toBe(true);
      expect(updates.filter((update) => update.sessionUpdate === "usage_update")).toEqual([]);
      const wire = JSON.stringify([created.result, updates, response.result]);
      expect(wire).not.toMatch(/"(used|size|cost|usage|inputTokens|outputTokens)"\s*:/);
    } finally {
      await h.close();
    }
  } finally {
    await f.cleanup();
  }
});
