import { expect, test } from "@logtape/testing-bun/autoload";

import { deferred, until } from "../core/agent/test-support.ts";
import type { AcpOptions } from "./adapter.ts";
import { answer } from "./testing/fixtures.ts";
import { harness, setup } from "./testing/harness.ts";

test("local resource links become session blob refs; outside paths reject before admission; remote links never fetch", async () => {
  const { mkdtemp, mkdir, writeFile, symlink, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const root = await mkdtemp(join(tmpdir(), "labkit-acp-attachments-"));
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  const body = "# Attachment-only sentinel 57193";
  await writeFile(join(cwd, "DESIGN.md"), body);
  await writeFile(join(root, "outside.md"), "outside sentinel");
  await symlink(join(root, "outside.md"), join(cwd, "escape.md"));
  let completions = 0;
  const { options, persistence } = setup({
    complete: () => {
      completions++;
      return answer;
    },
  });
  const { openaiChat } = await import("@labkit-agent/core/providers");
  const original = options.sessionOptions;
  const h = harness({
    ...options,
    sessionOptions: async (context) => {
      const base = await original(context);
      return {
        ...base,
        configuration: {
          ...base.configuration,
          policy: { maxOutputTokens: 16384, provider: openaiChat.id },
        },
        bindings: {
          ...base.bindings,
          complete: undefined,
          providers: new Map([
            [
              openaiChat.id,
              {
                profile: openaiChat,
                transport: {
                  baseUrl: "https://provider.invalid/v1",
                  fetch: (async (url, init) => {
                    expect(String(url)).toBe("https://provider.invalid/v1/chat/completions");
                    completions++;
                    if (completions <= 2) expect(String(init?.body)).toContain(body);
                    return Response.json({ choices: [{ message: { content: "Done" } }] });
                  }) as typeof fetch,
                },
              },
            ],
          ]),
        },
      };
    },
  });
  try {
    await h.initialize();
    const id = (await h.request("session/new", { cwd, mcpServers: [] })).result.sessionId;
    for (const uri of [
      pathToFileURL(join(root, "outside.md")).href,
      "../outside.md",
      pathToFileURL(join(cwd, "escape.md")).href,
    ]) {
      expect(
        (
          await h.request("session/prompt", {
            sessionId: id,
            prompt: [{ type: "resource_link", name: "invalid", uri }],
          })
        ).error?.code,
      ).toBe(-32602);
    }
    expect(completions).toBe(0);
    for (const uri of [pathToFileURL(join(cwd, "DESIGN.md")).href, "DESIGN.md"]) {
      expect(
        (
          await h.request("session/prompt", {
            sessionId: id,
            prompt: [
              { type: "text", text: "Review" },
              { type: "resource_link", name: "DESIGN.md", uri },
            ],
          })
        ).result.stopReason,
      ).toBe("end_turn");
    }
    const { SessionIdSchema } = await import("@labkit-agent/core/types");
    const sessionId = SessionIdSchema.parse(id);
    const loaded = await persistence.load(sessionId, new AbortController().signal);
    if (loaded.kind !== "loaded") throw new Error("Missing journal");
    const records = loaded.batches.flatMap((batch) => batch.records.map((raw) => JSON.parse(raw)));
    const inputs = records.filter((r) => r.body.kind === "event" && r.body.event.type === "user");
    expect(inputs).toHaveLength(2);
    const ref = inputs[0].body.event.attachments[0];
    expect(ref).toMatchObject({
      media: "text/markdown",
      name: "DESIGN.md",
      bytes: Buffer.byteLength(body),
    });
    const blob = await persistence.getBlob(sessionId, ref.id, new AbortController().signal);
    expect("bytes" in blob && new TextDecoder().decode(blob.bytes)).toBe(body);
    expect(JSON.stringify(loaded.batches)).not.toContain(body);
    // If a URL were fetched this deliberately invalid host could not succeed.
    expect(
      (
        await h.request("session/prompt", {
          sessionId: id,
          prompt: [
            {
              type: "resource_link",
              name: "remote",
              uri: "https://must-not-fetch.invalid/README.md",
            },
          ],
        })
      ).result.stopReason,
    ).toBe("end_turn");
    expect(completions).toBe(3);
  } finally {
    await h.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("cancel during attachment storage never admits a user event or starts completion", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const cwd = await mkdtemp(join(tmpdir(), "labkit-acp-cancel-attachment-"));
  await writeFile(join(cwd, "file.txt"), "body");
  let entered = false;
  let storageSignal: AbortSignal | undefined;
  let completions = 0;
  const pending = deferred<void>();
  const { options, persistence } = setup({
    complete: () => {
      completions++;
      return answer;
    },
  });
  const { openaiChat } = await import("@labkit-agent/core/providers");
  const original = options.sessionOptions;
  const h = harness({
    ...options,
    sessionOptions: async (context) => {
      const base = await original(context);
      return {
        ...base,
        configuration: {
          ...base.configuration,
          policy: { maxOutputTokens: 16384, provider: openaiChat.id },
        },
        bindings: {
          ...base.bindings,
          complete: undefined,
          providers: new Map([
            [
              openaiChat.id,
              {
                profile: openaiChat,
                transport: {
                  baseUrl: "https://provider.invalid",
                  fetch: (async (_url, _init) => {
                    completions++;
                    return Response.json({
                      choices: [{ message: { content: "Unexpected completion" } }],
                    });
                  }) as typeof fetch,
                },
              },
            ],
          ]),
        },
        persistence: {
          ...persistence,
          putBlob: async (id, bytes, meta, signal) => {
            entered = true;
            storageSignal = signal;
            await pending.promise;
            return persistence.putBlob(id, bytes, meta, signal);
          },
        },
      };
    },
  });
  try {
    await h.initialize();
    const id = (await h.request("session/new", { cwd, mcpServers: [] })).result.sessionId;
    const promptId = await h.start("session/prompt", {
      sessionId: id,
      prompt: [{ type: "resource_link", name: "file", uri: "file.txt" }],
    });
    await until(() => entered);
    await h.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: id } });
    await until(() => !!storageSignal?.aborted);
    pending.resolve();
    expect((await h.response(promptId)).result.stopReason).toBe("cancelled");
    expect(completions).toBe(0);
    const { SessionIdSchema } = await import("@labkit-agent/core/types");
    const loaded = await persistence.load(SessionIdSchema.parse(id), new AbortController().signal);
    expect(
      loaded.kind === "loaded" && loaded.batches.flatMap((batch) => batch.records).length,
    ).toBe(1);
  } finally {
    pending.resolve();
    await h.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("durable ACP reload resolves stored attachments without source files; denied write returns refusal", async () => {
  const { mkdtemp, writeFile, rm, access } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { openaiChat } = await import("@labkit-agent/core/providers");
  const { workspacePersistence } = await import("./workspace-persistence.ts");
  const { workspaceFiles } = await import("./workspace-files.ts");
  const { workspaceTools } = await import("./workspace-tools.ts");
  const cwd = await mkdtemp(join(tmpdir(), "labkit-acp-durable-"));
  const document = "# Blob-only document sentinel 27381";
  await writeFile(join(cwd, "DESIGN.md"), document);
  let blobReads = 0;
  let completions = 0;
  const options: AcpOptions = {
    loadSession: true,
    sessionOptions: async () => {
      const tools = workspaceTools(await workspaceFiles(cwd));
      const persistence = workspacePersistence(cwd);
      return {
        persistence: {
          ...persistence,
          getBlob: (...args) => {
            blobReads++;
            return persistence.getBlob(...args);
          },
        },
        configuration: {
          agent: "workspace",
          agents: new Map([
            ["workspace", { model: "m", tools: [...tools.keys()], successors: [] }],
          ]),
          steps: 6,
          policy: { maxOutputTokens: 16384, provider: openaiChat.id, permissions: "ask" },
        },
        bindings: {
          tools,
          providers: new Map([
            [
              openaiChat.id,
              {
                profile: openaiChat,
                transport: {
                  baseUrl: "https://test.invalid",
                  fetch: (async (_url, init) => {
                    completions++;
                    const body = String(init?.body);
                    if (body.includes("WRITE_DENIED"))
                      return Response.json({
                        choices: [
                          {
                            message: {
                              content: null,
                              tool_calls: [
                                {
                                  id: "write-one",
                                  type: "function",
                                  function: {
                                    name: "write_file",
                                    arguments: JSON.stringify({
                                      path: "denied.txt",
                                      text: "must not write",
                                    }),
                                  },
                                },
                              ],
                            },
                          },
                        ],
                      });
                    expect(body).toContain(document);
                    return Response.json({
                      choices: [{ message: { content: "Attachment read" } }],
                    });
                  }) as typeof fetch,
                },
              },
            ],
          ]),
        },
      };
    },
  };
  let h = harness(options);
  try {
    await h.initialize();
    const sessionId = (await h.request("session/new", { cwd, mcpServers: [] })).result.sessionId;
    expect(
      (
        await h.request("session/prompt", {
          sessionId,
          prompt: [
            { type: "text", text: "Review" },
            { type: "resource_link", name: "DESIGN.md", uri: "DESIGN.md" },
          ],
        })
      ).result.stopReason,
    ).toBe("end_turn");
    await h.close();
    await rm(join(cwd, "DESIGN.md"));
    h = harness(options);
    await h.initialize();
    const before = blobReads;
    expect(
      (await h.request("session/load", { cwd, sessionId, mcpServers: [] })).error,
    ).toBeUndefined();
    expect(blobReads).toBe(before);
    expect(completions).toBe(1);
    expect(
      (
        await h.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: "Review that attachment again" }],
        })
      ).result.stopReason,
    ).toBe("end_turn");
    expect(blobReads).toBeGreaterThan(before);
    const denialSession = (await h.request("session/new", { cwd, mcpServers: [] })).result
      .sessionId;
    const pending = await h.start("session/prompt", {
      sessionId: denialSession,
      prompt: [{ type: "text", text: "WRITE_DENIED" }],
    });
    await until(() => h.messages.some((m) => m.method === "session/request_permission"));
    const permission = h.messages.find((m) => m.method === "session/request_permission")!;
    expect(permission.params.toolCall).toMatchObject({
      kind: "edit",
      locations: [
        { path: join(await import("node:fs/promises").then((m) => m.realpath(cwd)), "denied.txt") },
      ],
    });
    const option = permission.params.options.find((value: any) => value.kind === "reject_once");
    await h.send({
      jsonrpc: "2.0",
      id: permission.id,
      result: { outcome: { outcome: "selected", optionId: option.optionId } },
    });
    expect((await h.response(pending)).result.stopReason).toBe("refusal");
    await expect(access(join(cwd, "denied.txt"))).rejects.toThrow();
    expect(completions).toBe(3);
  } finally {
    await h.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("ACP embedded image, PDF, and large editor text reach provider wire through blobs only", async () => {
  const { anthropicMessagesV2 } = await import("@labkit-agent/core/providers");
  const { SessionIdSchema } = await import("@labkit-agent/core/types");
  const { withFixtureDiagnostics } = await import("../core/logging/fixture-capture.ts");
  const directory = `.session-artifacts/acp-full-text/${crypto.randomUUID()}`;
  await withFixtureDiagnostics(directory, {}, async () => {
    const base = setup();
    const text = "Documentation body. ".repeat(4000) + "UNSAVED_EDITOR_CONTENT_SENTINEL";
    const image = Buffer.from("IMAGE_CONTENT_SENTINEL").toString("base64");
    const pdf = Buffer.from("PDF_CONTENT_SENTINEL").toString("base64");
    let wire: any;
    const h = harness({
      ...base.options,
      promptCapabilities: { image: true, embeddedContext: true },
      sessionOptions: async (context) => {
        const original = await base.options.sessionOptions(context);
        return {
          ...original,
          configuration: {
            ...original.configuration,
            policy: { maxOutputTokens: 16384, provider: anthropicMessagesV2.id },
          },
          bindings: {
            ...original.bindings,
            complete: undefined,
            providers: new Map([
              [
                anthropicMessagesV2.id,
                {
                  profile: anthropicMessagesV2,
                  transport: {
                    baseUrl: "https://provider.invalid",
                    capture: async (event) => {
                      await Bun.write(
                        `${directory}/${event.kind}.json`,
                        JSON.stringify(event, null, 2),
                      );
                    },
                    fetch: (async (_url, init) => {
                      wire = JSON.parse(String(init?.body));
                      return Response.json({
                        role: "assistant",
                        content: [{ type: "text", text: "Done" }],
                        stop_reason: "end_turn",
                      });
                    }) as typeof fetch,
                  },
                },
              ],
            ]),
          },
        };
      },
    });
    try {
      await h.initialize();
      const id = await h.newSession();
      const response = await h.request("session/prompt", {
        sessionId: id,
        prompt: [
          { type: "image", mimeType: "image/png", data: image },
          {
            type: "resource",
            resource: { uri: "file:///outside/unsaved.md", mimeType: "text/markdown", text },
          },
          {
            type: "resource",
            resource: {
              uri: "https://must-not-fetch.invalid/doc.pdf",
              mimeType: "application/pdf",
              blob: pdf,
            },
          },
        ],
      });
      expect(response.error).toBeUndefined();
      expect(response.result.stopReason).toBe("end_turn");
      const content = wire.messages[0].content;
      expect(content).toContainEqual({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: image },
      });
      expect(content).toContainEqual({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: pdf },
      });
      expect(JSON.stringify(content)).toContain(text);
      const journal = await base.persistence.load(
        SessionIdSchema.parse(id),
        new AbortController().signal,
      );
      expect(JSON.stringify(journal)).not.toContain(text);
      expect(JSON.stringify(journal)).not.toContain(image);
      expect(JSON.stringify(journal)).not.toContain(pdf);
    } finally {
      await h.close();
    }
  });
  const records = (await Bun.file(`${directory}/diagnostics.jsonl`).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    records.find(
      (record) => record.event === "attachment.stored" && record.media === "text/markdown",
    ).bytes,
  ).toBeGreaterThan(65536);
  expect(records.filter((record) => ["warning", "error"].includes(record.level))).toHaveLength(0);
});

test("unbound attachment media is rejected before blob storage or user admission", async () => {
  const base = setup();
  let puts = 0;
  const h = harness({
    ...base.options,
    promptCapabilities: { embeddedContext: true },
    sessionOptions: async (context) => ({
      ...(await base.options.sessionOptions(context)),
      persistence: {
        ...base.persistence,
        putBlob: async (...args) => {
          puts++;
          return base.persistence.putBlob(...args);
        },
      },
    }),
  });
  try {
    await h.initialize();
    const id = await h.newSession();
    const response = await h.request("session/prompt", {
      sessionId: id,
      prompt: [{ type: "resource", resource: { uri: "urn:text", text: "unsupported text" } }],
    });
    expect(response.error?.code).toBe(-32602);
    expect(puts).toBe(0);
    const { SessionIdSchema } = await import("@labkit-agent/core/types");
    const journal = await base.persistence.load(
      SessionIdSchema.parse(id),
      new AbortController().signal,
    );
    expect(
      journal.kind === "loaded" && journal.batches.flatMap((batch) => batch.records).length,
    ).toBe(1);
  } finally {
    await h.close();
  }
});

test("ACP admits an additional-root resource as a blob and passes its contents through the provider", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { openaiChat } = await import("@labkit-agent/core/providers");
  const { SessionIdSchema } = await import("@labkit-agent/core/types");
  const root = mkdtempSync(join(tmpdir(), "labkit-acp-root-blob-"));
  const cwd = join(root, "primary");
  const extra = join(root, "extra");
  mkdirSync(cwd);
  mkdirSync(extra);
  const path = join(extra, "DESIGN.md");
  const body = "extra workspace document bytes";
  writeFileSync(path, body);
  const base = setup();
  let calls = 0;
  const h = harness({
    ...base.options,
    additionalDirectories: true,
    sessionOptions: async (context) => {
      expect(context.additionalDirectories).toEqual([extra]);
      const options = await base.options.sessionOptions(context);
      return {
        ...options,
        configuration: {
          ...options.configuration,
          policy: { maxOutputTokens: 16384, provider: openaiChat.id },
        },
        bindings: {
          ...options.bindings,
          complete: undefined,
          providers: new Map([
            [
              openaiChat.id,
              {
                profile: openaiChat,
                transport: {
                  baseUrl: "https://provider.invalid/v1",
                  fetch: (async (_url, init) => {
                    calls++;
                    expect(String(init?.body)).toContain(body);
                    return Response.json({ choices: [{ message: { content: "Done" } }] });
                  }) as typeof fetch,
                },
              },
            ],
          ]),
        },
      };
    },
  });
  try {
    await h.initialize();
    const id = (
      await h.request("session/new", { cwd, additionalDirectories: [extra], mcpServers: [] })
    ).result.sessionId;
    expect(
      (
        await h.request("session/prompt", {
          sessionId: id,
          prompt: [{ type: "resource_link", name: "DESIGN.md", uri: path }],
        })
      ).result.stopReason,
    ).toBe("end_turn");
    expect(calls).toBe(1);
    const loaded = await base.persistence.load(
      SessionIdSchema.parse(id),
      new AbortController().signal,
    );
    expect(loaded.kind).toBe("loaded");
    expect(JSON.stringify(loaded)).not.toContain(body);
    expect(JSON.stringify(loaded)).toContain("attachments");
  } finally {
    await h.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ACP audio reaches Google as exact inline bytes, remains a journal ref, and reload performs no HTTP", async () => {
  const { googleGenerateV3 } = await import("../core/providers/index.ts");
  const { SessionIdSchema } = await import("../core/agent/types.ts");
  const { withFixtureDiagnostics } = await import("../core/logging/fixture-capture.ts");
  const directory = `.session-artifacts/acp-audio/${crypto.randomUUID()}`;
  await withFixtureDiagnostics(directory, {}, async () => {
    const wav = Buffer.alloc(44 + 320);
    wav.write("RIFF", 0);
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16000, 24);
    wav.writeUInt32LE(32000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(320, 40);
    const data = wav.toString("base64");
    const wires: any[] = [];
    const base = setup();
    const options: AcpOptions = {
      ...base.options,
      promptCapabilities: { audio: true },
      sessionOptions: async (context) => {
        const original = await base.options.sessionOptions(context);
        return {
          ...original,
          configuration: {
            ...original.configuration,
            policy: { provider: "google", model: "audio-test", thinking: "off" },
          },
          bindings: {
            ...original.bindings,
            complete: undefined,
            providers: new Map([
              [
                "google",
                {
                  profile: googleGenerateV3,
                  transport: {
                    baseUrl: "https://example.invalid",
                    fetch: (async (_url, init) => {
                      wires.push(JSON.parse(String(init?.body)));
                      return Response.json({
                        candidates: [
                          {
                            finishReason: "STOP",
                            content: {
                              role: "model",
                              parts: [{ text: "Scripted audio response" }],
                            },
                          },
                        ],
                      });
                    }) as typeof fetch,
                  },
                },
              ],
            ]),
          },
        };
      },
    };
    let h = harness(options);
    try {
      await h.initialize();
      const id = await h.newSession();
      const response = await h.request("session/prompt", {
        sessionId: id,
        prompt: [
          { type: "text", text: "Describe this recording" },
          { type: "audio", mimeType: "audio/wav", data },
        ],
      });
      expect(response.result.stopReason).toBe("end_turn");
      expect(wires[0].contents[0].parts).toContainEqual({
        inlineData: { mimeType: "audio/wav", data },
      });
      const loaded = await base.persistence.load(
        SessionIdSchema.parse(id),
        new AbortController().signal,
      );
      expect(JSON.stringify(loaded)).toContain("audio/wav");
      expect(JSON.stringify(loaded)).not.toContain(data);
      await h.close();
      h = harness(options);
      await h.initialize();
      expect(
        (await h.request("session/load", { sessionId: id, cwd: "/tmp", mcpServers: [] })).error,
      ).toBeUndefined();
      expect(wires).toHaveLength(1);
      expect(
        h
          .updates()
          .some(
            (message) =>
              message.update.sessionUpdate === "user_message_chunk" &&
              message.update.content.type === "resource_link" &&
              message.update.content.mimeType === "audio/wav",
          ),
      ).toBe(true);
      await h.request("session/prompt", {
        sessionId: id,
        prompt: [{ type: "text", text: "Describe the recording again" }],
      });
      expect(wires).toHaveLength(2);
      expect(wires[1].contents[0].parts).toContainEqual({
        inlineData: { mimeType: "audio/wav", data },
      });
    } finally {
      await h.close();
      await Bun.write(`${directory}/requests.json`, JSON.stringify(wires, null, 2));
    }
  });
  const records = (await Bun.file(`${directory}/diagnostics.jsonl`).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(records.find((record) => record.event === "attachment.stored")).toMatchObject({
    media: "audio/wav",
    bytes: 364,
  });
  expect(records.filter((record) => ["warning", "error"].includes(record.level))).toHaveLength(0);
});
