import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@logtape/testing-bun/autoload";

import { rotatingFileSink } from "./launcher-logging.ts";

test("diagnostic rotation retains complete records with bounded backups", async () => {
  const directory = await mkdtemp(join(tmpdir(), "labkit-rotation-"));
  try {
    const path = join(directory, "events.jsonl");
    const sink = rotatingFileSink(path, 60, 2);
    for (let index = 0; index < 10; index++)
      sink.write(`${JSON.stringify({ index, event: "operation.completed" })}\n`);
    sink.close();
    expect((await readdir(directory)).sort()).toEqual([
      "events.jsonl",
      "events.jsonl.1",
      "events.jsonl.2",
    ]);
    expect(JSON.parse(await readFile(path, "utf8")).index).toBe(9);
    expect(JSON.parse(await readFile(`${path}.2`, "utf8")).index).toBe(7);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("launcher failures persist causes across restarts with API keys redacted and stdout clean", async () => {
  const directory = await mkdtemp(join(tmpdir(), "labkit-launcher-failure-"));
  try {
    const config = join(directory, "broken.ts");
    await Bun.write(
      config,
      `throw new Error("Cannot bind provider; key=" + process.env.OPENAI_API_KEY, { cause: new Error("missing profile @99") });`,
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      const child = Bun.spawn(
        [process.execPath, new URL("./cli.ts", import.meta.url).pathname, "--config", config],
        {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            LABKIT_ACP_LOG_DIR: directory,
            OPENAI_API_KEY: "synthetic-credential-123",
          },
        },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("Labkit diagnostics:");
      expect(stderr).not.toContain("synthetic-credential-123");
    }
    const files = (await readdir(directory)).filter((file) => file.endsWith(".jsonl"));
    expect(files).toHaveLength(2);
    const launchers = new Set();
    for (const file of files) {
      const text = await readFile(join(directory, file), "utf8");
      expect(text).not.toContain("synthetic-credential-123");
      const records = text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records.map((record) => record.event)).toEqual([
        "launcher.started",
        "launcher.failed",
        "launcher.stopped",
      ]);
      expect(text).toContain("missing profile @99");
      expect(text).toContain("Cannot bind provider");
      expect(text).toContain("broken.ts");
      for (const record of records) {
        expect(record.processId).toBeNumber();
        expect(record.launcherId).toBe(records[0].launcherId);
      }
      launchers.add(records[0].launcherId);
    }
    expect(launchers.size).toBe(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unavailable diagnostic directory reports failure and emits structured stderr fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "labkit-log-fallback-"));
  try {
    const path = join(directory, "file");
    await Bun.write(path, "not a directory");
    const child = Bun.spawn(
      [process.execPath, new URL("./cli.ts", import.meta.url).pathname, "--help"],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, LABKIT_ACP_LOG_DIR: join(path, "logs") },
      },
    );
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stdout).toBe("");
    expect(stderr).toContain("diagnostic file failure");
    expect(stderr).toContain('"event":"launcher.started"');
    expect(stderr).toContain("ENOTDIR");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("oversized failure records remain reconstructable across bounded rotated files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "labkit-log-chunks-"));
  try {
    const config = join(directory, "broken.ts");
    const message = `failure-start-${"detail ".repeat(200)}-failure-end`;
    await Bun.write(config, `throw new Error(${JSON.stringify(message)});`);
    const child = Bun.spawn(
      [process.execPath, new URL("./cli.ts", import.meta.url).pathname, "--config", config],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          LABKIT_ACP_LOG_DIR: directory,
          LABKIT_ACP_LOG_MAX_BYTES: "1024",
          LABKIT_ACP_LOG_BACKUPS: "100",
        },
      },
    );
    await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const chunks: any[] = [];
    for (const file of (await readdir(directory)).filter((name) => name.includes(".jsonl"))) {
      const bytes = await readFile(join(directory, file));
      expect(bytes.byteLength).toBeLessThanOrEqual(1024);
      chunks.push(
        ...bytes
          .toString()
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
          .filter((record) => record.event === "diagnostic.record_chunk"),
      );
    }
    expect(chunks.length).toBeGreaterThan(1);
    const records = [...new Set(chunks.map((chunk) => chunk.recordId))].map((id) => {
      const group = chunks
        .filter((chunk) => chunk.recordId === id)
        .sort((a, b) => a.index - b.index);
      expect(group).toHaveLength(group[0].total);
      return JSON.parse(group.map((chunk) => chunk.serializedFragment).join(""));
    });
    expect(records.find((record) => record.event === "launcher.failed").error.message).toBe(
      message,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
