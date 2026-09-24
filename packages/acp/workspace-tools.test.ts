import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSession, restoreSession } from "@labkit-agent/core";
import { createMemoryPersistence } from "@labkit-agent/core/testing";
import { expect, test } from "@logtape/testing-bun/autoload";

import { workspaceAgent } from "./examples/vscode-workspace.ts";
import type { AcpSelectBinding } from "./session-config.ts";
import { MAX_FILE_BYTES, workspaceFiles } from "./workspace-files.ts";
import { workspaceTools } from "./workspace-tools.ts";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "labkit-workspace-"));
  const root = await realpath(directory);
  await mkdir(join(root, "workspace"));
  const cwd = join(root, "workspace");
  await writeFile(join(root, "outside.txt"), "private");
  await writeFile(join(cwd, "README.md"), "# workspace 🌍");
  const files = await workspaceFiles(cwd);
  return {
    root,
    cwd,
    files,
    tools: workspaceTools(files),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
const signal = () => new AbortController().signal;

test("file tools resolve absolute locations, read/write/list JSON values, and bind cwd without chdir", async () => {
  const f = await fixture();
  const previous = process.cwd();
  try {
    const read = f.tools.get("read_file")!;
    const input = await read.parseInput({ path: "README.md" });
    expect(read.kind).toBe("read");
    expect(read.locations!(input)).toEqual([{ path: join(f.cwd, "README.md") }]);
    expect(await read.run(input, signal())).toEqual({
      path: join(f.cwd, "README.md"),
      text: "# workspace 🌍",
    });
    const write = f.tools.get("write_file")!;
    expect(write.kind).toBe("edit");
    await write.run(await write.parseInput({ path: "new.txt", text: "changed" }), signal());
    expect(await readFile(join(f.cwd, "new.txt"), "utf8")).toBe("changed");
    const list = f.tools.get("list_dir")!;
    expect(list.kind).toBe("search");
    expect(list.locations!(await list.parseInput({ path: "." }))).toEqual([{ path: f.cwd }]);
    expect(await list.run(await list.parseInput({ path: "." }), signal())).toMatchObject({
      entries: [
        { name: "new.txt", type: "file" },
        { name: "README.md", type: "file" },
      ],
    });
    expect(process.cwd()).toBe(previous);
  } finally {
    await f.cleanup();
  }
});

test("traversal, sibling prefixes, symlinks and hard-link aliases cannot escape the workspace", async () => {
  const f = await fixture();
  try {
    for (const path of [
      "../outside.txt",
      "nested/../README.md",
      join(f.root, "workspace-other/file"),
      join(f.root, "outside.txt"),
    ]) {
      expect(() => f.files.path(path)).toThrow();
    }
    await symlink(join(f.root, "outside.txt"), join(f.cwd, "alias"));
    await symlink(f.root, join(f.cwd, "parent"));
    await link(join(f.root, "outside.txt"), join(f.cwd, "hard"));
    for (const path of ["alias", "parent/outside.txt", "hard"]) {
      await expect(f.files.readText(path, signal())).rejects.toThrow();
      await expect(f.files.write(path, "bad", signal())).rejects.toThrow();
    }
    await expect(f.files.list("parent", signal())).rejects.toThrow();
    expect(await readFile(join(f.root, "outside.txt"), "utf8")).toBe("private");
  } finally {
    await f.cleanup();
  }
});

test("bounded UTF-8 reads/writes and abort fail closed", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.cwd, "large.txt"), new Uint8Array(MAX_FILE_BYTES + 1));
    await writeFile(join(f.cwd, "binary"), new Uint8Array([0xff, 0xfe]));
    await expect(f.files.readText("large.txt", signal())).rejects.toThrow("narrow");
    await expect(f.files.readText("binary", signal())).rejects.toThrow();
    await expect(
      f.files.write("README.md", "x".repeat(MAX_FILE_BYTES + 1), signal()),
    ).rejects.toThrow("narrow");
    const controller = new AbortController();
    controller.abort();
    await expect(f.files.write("README.md", "bad", controller.signal)).rejects.toThrow();
    expect(await readFile(join(f.cwd, "README.md"), "utf8")).toBe("# workspace 🌍");
  } finally {
    await f.cleanup();
  }
});

test("permission rejection for write_file preserves bytes; approved execution reports absolute path", async () => {
  const f = await fixture();
  try {
    for (const optionId of ["reject-once", "allow-once"]) {
      let completions = 0;
      const session = await createSession({
        persistence: createMemoryPersistence(),
        configuration: {
          agent: "workspace",
          agents: new Map([
            ["workspace", { model: "m", successors: [], tools: [...f.tools.keys()] }],
          ]),
          steps: 3,
          policy: { permissions: "ask" },
        },
        bindings: {
          tools: f.tools,
          complete: () =>
            ++completions === 1
              ? {
                  kind: "tools",
                  text: "Update",
                  calls: [
                    {
                      id: "write",
                      name: "write_file",
                      args: { path: "README.md", text: "approved" },
                    },
                  ],
                }
              : { kind: "answer", text: "done" },
          requestPermission: (request) => {
            expect(request.toolCall.kind).toBe("edit");
            expect(request.toolCall.locations).toEqual([{ path: join(f.cwd, "README.md") }]);
            return { outcome: { outcome: "selected", optionId } };
          },
        },
      });
      const result = await session.input("write").settled;
      expect(result.kind === "terminal" && result.record.outcome.kind).toBe(
        optionId === "allow-once" ? "completed" : "failed",
      );
      expect(await readFile(join(f.cwd, "README.md"), "utf8")).toBe(
        optionId === "allow-once" ? "approved" : "# workspace 🌍",
      );
      await session.close();
    }
  } finally {
    await f.cleanup();
  }
});

test("workspace example validates environment, enables load and disables self-handoff, and journals no credentials", async () => {
  const f = await fixture();
  try {
    expect(() => workspaceAgent({})).toThrow("LABKIT_ACP_MODEL");
    expect(() => workspaceAgent({ LABKIT_ACP_MODEL: "m" })).toThrow("ANTHROPIC_API_KEY");
    for (const [provider, key] of [
      ["anthropic-messages@3", "ANTHROPIC_API_KEY"],
      ["anthropic-messages@4", "ANTHROPIC_API_KEY"],
      ["openai-chat@2", "OPENAI_API_KEY"],
      ["openai-responses@3", "OPENAI_API_KEY"],
      ["google-generate@3", "GOOGLE_API_KEY"],
    ]) {
      const agent = workspaceAgent({
        LABKIT_ACP_PROVIDER: provider,
        LABKIT_ACP_MODEL: "m",
        LABKIT_ACP_MODELS: "m2, m",
        [key!]: "TEST_SECRET",
      });
      expect(agent.loadSession).toBe(true);
      const options = await agent.sessionOptions({ cwd: f.cwd, signal: signal() });
      expect(options.configuration.agents.get("workspace")?.successors).toEqual([]);
      expect(options.configuration.policy).toMatchObject({
        permissions: "ask",
        stream: true,
        provider,
      });
      expect(
        options.config
          ?.find(
            (binding): binding is AcpSelectBinding =>
              binding.type !== "boolean" && binding.id === "model",
          )
          ?.options.map((option) => option.value),
      ).toEqual(["m", "m2"]);
      expect(
        options.config
          ?.find(
            (binding): binding is AcpSelectBinding =>
              binding.type !== "boolean" && binding.id === "thinking",
          )
          ?.options.map((option) => option.value),
      ).toEqual(
        provider!.startsWith("openai") ? ["off", "low", "medium", "high"] : ["off", "adaptive"],
      );
      expect(JSON.stringify(options.configuration)).not.toContain("TEST_SECRET");
    }
  } finally {
    await f.cleanup();
  }
});

test("workspace terminal tool requires explicit opt-in and client capability and is excluded by read-only mode", async () => {
  const f = await fixture();
  const terminal = {
    run: async () => ({ output: "", truncated: false, exitCode: 0, signal: null }),
  };
  try {
    for (const enabled of [false, true]) {
      const agent = workspaceAgent({
        LABKIT_ACP_MODEL: "m",
        ANTHROPIC_API_KEY: "TEST",
        ...(enabled ? { LABKIT_ACP_TERMINAL: "1" } : {}),
      });
      for (const supported of [false, true]) {
        const options = await agent.sessionOptions({
          cwd: f.cwd,
          signal: signal(),
          ...(supported ? { terminal } : {}),
        });
        expect(options.bindings.tools?.has("run_command")).toBe(enabled && supported);
        const readOnly = options.config
          ?.find(
            (binding): binding is AcpSelectBinding =>
              binding.type !== "boolean" && binding.id === "mode",
          )
          ?.options.find((option) => option.value === "read-only");
        expect(readOnly?.patch.tools?.workspace).not.toContain("run_command");
        expect(options.configuration.policy?.permissions).toBe("ask");
      }
    }
  } finally {
    await f.cleanup();
  }
});

test("additional roots preserve primary relative paths and enforce every root's sandbox", async () => {
  const f = await fixture();
  const extra = join(f.root, "extra");
  try {
    await mkdir(extra);
    await writeFile(join(extra, "README.md"), "extra");
    await mkdir(join(extra, ".labkit"));
    await writeFile(join(extra, ".labkit", "secret"), "private");
    await symlink(join(f.root, "outside.txt"), join(extra, "alias"));
    await link(join(f.root, "outside.txt"), join(extra, "hard"));
    const extraAlias = join(f.root, "extra-alias");
    await symlink(extra, extraAlias);
    const files = await workspaceFiles(f.cwd, [extra, extraAlias, extra]);
    expect(files.roots).toEqual([f.cwd, extra]);
    expect(await files.readText(join(extraAlias, "README.md"), signal())).toBe("extra");
    expect(await files.readText("README.md", signal())).toBe("# workspace 🌍");
    expect(await files.readText(join(extra, "README.md"), signal())).toBe("extra");
    const write = workspaceTools(files).get("write_file")!;
    const input = await write.parseInput({ path: join(extra, "new.txt"), text: "new" });
    expect(write.locations!(input)).toEqual([{ path: join(extra, "new.txt") }]);
    await write.run(input, signal());
    expect(await readFile(join(extra, "new.txt"), "utf8")).toBe("new");
    expect((await files.list(extra, signal())).path).toBe(extra);
    for (const path of [
      join(f.root, "outside.txt"),
      "../extra/README.md",
      join(extra, ".labkit/secret"),
      join(extra, "alias"),
      join(extra, "hard"),
    ])
      await expect(files.readText(path, signal())).rejects.toThrow();
    // An overlapping parent root cannot expose another root's reserved store.
    const overlapping = await workspaceFiles(f.root, [extra]);
    await expect(overlapping.readText(join(extra, ".labkit/secret"), signal())).rejects.toThrow(
      "reserved",
    );
    await expect(workspaceFiles(extra, [join(extra, ".labkit")])).rejects.toThrow("reserved");
  } finally {
    await f.cleanup();
  }
});

test("workspace restores the saved Anthropic wire version after changing the launch default", async () => {
  const f = await fixture();
  try {
    const env = { LABKIT_ACP_MODEL: "claude-sonnet-5", ANTHROPIC_API_KEY: "TEST_SECRET" };
    for (const [saved, current] of [
      ["anthropic-messages@4", "anthropic-messages@3"],
      ["anthropic-messages@3", "anthropic-messages@4"],
    ]) {
      const original = await workspaceAgent({ ...env, LABKIT_ACP_PROVIDER: saved }).sessionOptions({
        cwd: f.cwd,
        signal: signal(),
      });
      const requestPermission = async () => ({ outcome: { outcome: "cancelled" as const } });
      const session = await createSession({
        ...original,
        bindings: { ...original.bindings, requestPermission },
      });
      const id = session.snapshot.durable.conversation.sessionId;
      await session.updatePolicy({ thinking: "adaptive" });
      await session.close();
      const rebound = await workspaceAgent({ ...env, LABKIT_ACP_PROVIDER: current }).sessionOptions(
        { cwd: f.cwd, sessionId: id, signal: signal() },
      );
      let requests = 0;
      const providers = new Map(
        [...rebound.bindings.providers!].map(([key, binding]) => [
          key,
          {
            ...binding,
            transport: {
              ...binding.transport,
              fetch: (async () => {
                requests++;
                throw new Error("Restore must not fetch");
              }) as unknown as typeof fetch,
            },
          },
        ]),
      );
      const restored = await restoreSession(
        { ...rebound, bindings: { ...rebound.bindings, providers, requestPermission } },
        id,
      );
      expect(restored.snapshot.durable.policy).toMatchObject({
        provider: saved,
        thinking: "adaptive",
      });
      expect(requests).toBe(0);
      await restored.close();
    }
  } finally {
    await f.cleanup();
  }
});
