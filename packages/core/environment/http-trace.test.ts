import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@logtape/testing-bun/autoload";

import { openHttpTrace, pruneProviderCaptures } from "./provider-capture.ts";

async function tempRoot() {
  return mkdtemp(join(tmpdir(), "http-trace-test-"));
}

test("pruneProviderCaptures never removes anything under root that is not a recognized capture run", async () => {
  const root = await tempRoot();
  try {
    await writeFile(join(root, "notes.txt"), "keep me");
    await mkdir(join(root, "unrelated-directory"));
    await writeFile(join(root, "unrelated-directory", "data.json"), "{}");
    // Looks like a run name but has no manifest: not a recognized capture run.
    await mkdir(join(root, "11111111-1111-4111-8111-111111111111"));
    await pruneProviderCaptures(root, 0);
    const remaining = await readdir(root);
    expect(remaining.sort()).toEqual(
      ["11111111-1111-4111-8111-111111111111", "notes.txt", "unrelated-directory"].sort(),
    );
    expect(await readdir(join(root, "unrelated-directory"))).toEqual(["data.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pruneProviderCaptures never removes a run directory owned by a live process", async () => {
  const root = await tempRoot();
  try {
    const liveRun = `${process.pid}-22222222-2222-4222-8222-222222222222`;
    await mkdir(join(root, liveRun));
    await writeFile(join(root, liveRun, "manifest.jsonl"), "");
    await pruneProviderCaptures(root, 0);
    expect(await readdir(root)).toEqual([liveRun]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pruneProviderCaptures removes a recognized run whose owning process no longer exists", async () => {
  const root = await tempRoot();
  try {
    // A PID no real process holds for the duration of this test.
    const deadRun = "999999-33333333-3333-4333-8333-333333333333";
    await mkdir(join(root, deadRun));
    await writeFile(join(root, deadRun, "manifest.jsonl"), "");
    await pruneProviderCaptures(root, 0);
    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("openHttpTrace rejects a relative directory", async () => {
  await expect(openHttpTrace(".")).rejects.toThrow("absolute path");
  await expect(openHttpTrace("relative/trace")).rejects.toThrow("absolute path");
});

test("openHttpTrace appends one JSONL line per event and rotates after maxCalls", async () => {
  const root = await tempRoot();
  try {
    const trace = await openHttpTrace(root, { maxCalls: 1 });
    const first = trace.directory();
    await trace.capture({ kind: "http_request", httpRequestId: "a", body: "req-a" });
    await trace.capture({ kind: "http_response", httpRequestId: "a", body: "res-a" });
    expect(trace.directory()).toBe(first);
    // A second distinct call exceeds maxCalls=1, so it starts a new run directory.
    await trace.capture({ kind: "http_request", httpRequestId: "b", body: "req-b" });
    const second = trace.directory();
    expect(second).not.toBe(first);
    await trace.close();

    const firstManifest = (await Bun.file(join(first, "manifest.jsonl")).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(firstManifest).toHaveLength(2);
    expect(firstManifest[0]).toMatchObject({ kind: "http_request", httpRequestId: "a" });
    const secondManifest = (await Bun.file(join(second, "manifest.jsonl")).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(secondManifest).toHaveLength(1);
    expect(secondManifest[0]).toMatchObject({ kind: "http_request", httpRequestId: "b" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
