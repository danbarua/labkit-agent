import { expect, test } from "bun:test";

import type { ContentBlock } from "@agentclientprotocol/sdk";
import { MAX_BLOB_BYTES } from "@labkit-agent/core";
import { createMemoryPersistence } from "@labkit-agent/core/testing";
import { SessionIdSchema } from "@labkit-agent/core/types";

import { promptInput } from "./prompt-input.ts";

const sessionId = SessionIdSchema.parse(crypto.randomUUID());
const signal = new AbortController().signal;

test("embedded text and image use supplied bytes, without accessing resource URIs", async () => {
  const persistence = createMemoryPersistence();
  const result = await promptInput(
    [
      {
        type: "resource",
        resource: {
          uri: "file:///outside/missing.ts",
          mimeType: "text/typescript",
          text: "unsaved editor contents",
        },
      },
      {
        type: "image",
        uri: "https://must-not-fetch.invalid/image",
        mimeType: "image/png",
        data: "AQID",
      },
    ],
    "/nonexistent-workspace",
    persistence,
    sessionId,
    signal,
  );
  expect(result.attachments?.map((ref) => ref.media)).toEqual(["text/plain", "image/png"]);
  const [text, image] = result.attachments!;
  const loaded = await persistence.getBlob(sessionId, text!.id, signal);
  expect("bytes" in loaded && new TextDecoder().decode(loaded.bytes)).toBe(
    "unsaved editor contents",
  );
  const loadedImage = await persistence.getBlob(sessionId, image!.id, signal);
  expect("bytes" in loadedImage && [...loadedImage.bytes]).toEqual([1, 2, 3]);
  expect(JSON.stringify(result)).not.toContain("unsaved editor contents");
});

test("invalid embedded data rejects the whole prompt before storing any blob", async () => {
  const base = createMemoryPersistence();
  let puts = 0;
  const persistence = {
    ...base,
    putBlob: (...args: Parameters<typeof base.putBlob>) => {
      puts++;
      return base.putBlob(...args);
    },
  };
  const invalid: ContentBlock[] = [
    { type: "image", mimeType: "image/png", data: "not base64!" },
    { type: "image", mimeType: "image/gif", data: "AQID" },
    { type: "resource", resource: { uri: "urn:bad", mimeType: "text/plain", blob: "/w==" } },
    { type: "resource", resource: { uri: "urn:unknown", blob: "AQID" } },
    { type: "resource", resource: { uri: "urn:large", text: "x".repeat(MAX_BLOB_BYTES + 1) } },
    {
      type: "image",
      mimeType: "image/png",
      data: Buffer.alloc(MAX_BLOB_BYTES + 1).toString("base64"),
    },
    { type: "audio", mimeType: "audio/wav", data: "AQID" },
  ];
  for (const block of invalid) {
    await expect(
      promptInput(
        [{ type: "resource", resource: { uri: "urn:valid", text: "valid" } }, block],
        "/tmp",
        persistence,
        sessionId,
        signal,
      ),
    ).rejects.toThrow();
  }
  expect(puts).toBe(0);
});

test("provider media rejection happens before blob storage", async () => {
  const base = createMemoryPersistence();
  let puts = 0;
  const persistence = {
    ...base,
    putBlob: (...args: Parameters<typeof base.putBlob>) => {
      puts++;
      return base.putBlob(...args);
    },
  };
  await expect(
    promptInput(
      [
        {
          type: "resource",
          resource: { uri: "urn:pdf", mimeType: "application/pdf", blob: "AQID" },
        },
      ],
      "/tmp",
      persistence,
      sessionId,
      signal,
      ["text/plain"],
    ),
  ).rejects.toThrow("Provider does not support");
  expect(puts).toBe(0);
});

test("resource links in additional roots become session blobs and removed roots stop new reads", async () => {
  const { mkdtemp, mkdir, writeFile, rm, realpath } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const root = await realpath(await mkdtemp(join(tmpdir(), "labkit-prompt-roots-")));
  try {
    const cwd = join(root, "primary");
    const extra = join(root, "extra");
    await mkdir(cwd);
    await mkdir(extra);
    await writeFile(join(extra, "DESIGN.md"), "# attached design");
    const block: ContentBlock = {
      type: "resource_link",
      name: "DESIGN.md",
      uri: pathToFileURL(join(extra, "DESIGN.md")).href,
    };
    const store = createMemoryPersistence();
    const result = await promptInput(
      [block],
      cwd,
      store,
      sessionId,
      signal,
      ["text/markdown"],
      [extra],
    );
    const ref = result.attachments![0]!;
    expect(ref.media).toBe("text/markdown");
    expect(JSON.stringify(result)).not.toContain("# attached design");
    await expect(
      promptInput([block], cwd, store, sessionId, signal, ["text/markdown"]),
    ).rejects.toThrow();
    const blob = await store.getBlob(sessionId, ref.id, signal);
    expect("bytes" in blob && new TextDecoder().decode(blob.bytes)).toBe("# attached design");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
