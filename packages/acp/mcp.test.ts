import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { until } from "../core/agent/test-support.ts";
import { mcpConnections, mcpToolName } from "./mcp.ts";

const fixturePath = new URL("./testing/mcp-server.ts", import.meta.url).pathname;
const signal = () => new AbortController().signal;
async function fixture(mode = "normal", additionalDirectories: string[] = []) {
  const cwd = await mkdtemp(join(tmpdir(), "labkit-mcp-"));
  const server = {
    name: "fixture/server",
    command: process.execPath,
    args: [fixturePath],
    env: [
      { name: "MCP_TEST_PID", value: join(cwd, "pid") },
      { name: "MCP_TEST_LOG", value: join(cwd, "log") },
      { name: "MCP_TEST_TOKEN", value: "private-mcp-token" },
      { name: "MCP_TEST_MODE", value: mode },
    ],
  };
  const connection = mcpConnections([server], cwd, additionalDirectories);
  return {
    cwd,
    server,
    connection,
    events: async () =>
      (await readFile(join(cwd, "log"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    cleanup: async () => {
      await connection.close();
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

test("MCP stdio initializes, paginates, namespaces tools, validates before call, and limits inherited env", async () => {
  const f = await fixture();
  try {
    const tools = await f.connection.open(signal());
    expect(tools.size).toBe(2);
    const name = mcpToolName(f.server.name, "echo");
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(name).not.toBe(mcpToolName("fixture_server", "echo"));
    const tool = tools.get(name)!;
    expect(tool.kind).toBe("read");
    await expect(tool.parseInput({ text: "" })).rejects.toThrow("Invalid MCP tool arguments");
    await expect(tool.parseInput({ text: "tuple", pair: [1, "bad"] })).rejects.toThrow(
      "Invalid MCP tool arguments",
    );
    expect((await f.events()).some((e) => e.method === "tools/call")).toBe(false);
    const output = await tool.run(await tool.parseInput({ text: "hello" }), signal());
    expect(output).toMatchObject({
      content: [{ type: "text", text: "hello" }],
      structuredContent: { tokenPresent: true, providerKeyPresent: false },
    });
    await expect(tool.run({ text: "error" }, signal())).rejects.toThrow("fixture tool error");
    await expect(tool.run({ text: "binary" }, signal())).rejects.toThrow("Binary MCP");
    await f.connection.close();
    expect((await f.events()).at(-1).method).toBe("closed");
  } finally {
    await f.cleanup();
  }
});

test("MCP call cancellation reaches the server and close stops its process", async () => {
  const f = await fixture();
  try {
    const tools = await f.connection.open(signal());
    const controller = new AbortController();
    const pending = tools
      .get(mcpToolName(f.server.name, "slow"))!
      .run({ text: "wait" }, controller.signal);
    const rejected = Promise.resolve(pending).then(
      () => null,
      (error) => error,
    );
    let called = false;
    for (let i = 0; i < 100 && !called; i++) {
      called = (await f.events()).some((e) => e.method === "tools/call");
      if (!called) await Bun.sleep(2);
    }
    expect(called).toBe(true);
    controller.abort();
    expect(await rejected).toBeInstanceOf(Error);
    await f.connection.close();
    expect((await f.events()).some((e) => e.method === "notifications/cancelled")).toBe(true);
    const pid = Number(await readFile(join(f.cwd, "pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    await f.cleanup();
  }
});

test("MCP rejects invalid remote URLs, duplicate names, and cycling catalogs; aborted opening cleans up", async () => {
  expect(() =>
    mcpConnections([{ type: "http", name: "remote", url: "file:///invalid", headers: [] }], "/tmp"),
  ).toThrow("HTTP(S)");
  const duplicate = { name: "same", command: "unused", args: [], env: [] };
  expect(() => mcpConnections([duplicate, duplicate], "/tmp")).toThrow("unique");
  const repeated = await fixture("repeat");
  try {
    await expect(repeated.connection.open(signal())).rejects.toThrow("cursor");
    expect((await repeated.events()).at(-1).method).toBe("closed");
  } finally {
    await repeated.cleanup();
  }
  const hanging = await fixture("hang");
  try {
    const controller = new AbortController();
    const pending = hanging.connection.open(controller.signal);
    const rejected = pending.then(
      () => null,
      (error) => error,
    );
    let ready = false;
    void (async () => {
      for (let i = 0; i < 100; i++) {
        try {
          if ((await hanging.events()).some((e) => e.method === "initialize")) {
            ready = true;
            return;
          }
        } catch {}
        await Bun.sleep(1);
      }
    })();
    await until(() => ready);
    controller.abort();
    expect(await rejected).toBeInstanceOf(Error);
    expect((await hanging.events()).at(-1).method).toBe("closed");
  } finally {
    await hanging.cleanup();
  }
});

test("MCP root discovery includes additional workspace roots without changing server cwd", async () => {
  const { pathToFileURL } = await import("node:url");
  const f = await fixture("normal", ["/additional/workspace"]);
  try {
    const tools = await f.connection.open(signal());
    const output = await tools
      .get(mcpToolName(f.server.name, "echo"))!
      .run({ text: "roots" }, signal());
    expect(output).toMatchObject({ structuredContent: { cwd: await realpath(f.cwd) } });
    expect((await f.events()).find((event) => event.method === "roots-result")?.roots).toEqual([
      { uri: pathToFileURL(f.cwd).href, name: "Workspace" },
      { uri: "file:///additional/workspace", name: "Workspace 2" },
    ]);
  } finally {
    await f.cleanup();
  }
});
