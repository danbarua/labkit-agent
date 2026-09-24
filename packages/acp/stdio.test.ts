import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@logtape/testing-bun/autoload";

import { until } from "../core/agent/test-support.ts";

test("Bun stdio launcher exchanges ACP JSON lines and exits on EOF with stdout reserved", async () => {
  const directory = await mkdtemp(join(tmpdir(), "labkit-acp-"));
  const config = join(directory, "config.ts");
  const core = new URL("../core/index.ts", import.meta.url).href;
  const memory = new URL("../core/session/testing/memory-persistence.ts", import.meta.url).href;
  await Bun.write(
    config,
    `import { createMemoryPersistence } from ${JSON.stringify(memory)};
    import { defineTool } from ${JSON.stringify(core)};
    const persistence = createMemoryPersistence();
    export default { sessionOptions: ({ cwd }) => ({ persistence,
      configuration: { agent: "a", agents: new Map([["a", { model: "m" }]]), steps: 2 },
      bindings: { complete: () => ({ kind: "answer", text: "hello 🌍 from " + cwd }) },
    }) };`,
  );
  const child = Bun.spawn(
    [
      process.execPath,
      new URL(process.env.LABKIT_ACP_TEST_BUILT ? "./dist/cli.js" : "./cli.ts", import.meta.url)
        .pathname,
      "--config",
      config,
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, LABKIT_ACP_LOG_DIR: join(directory, "logs") },
    },
  );
  const messages: any[] = [];
  const errors = new Response(child.stderr).text();
  const reading = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        messages.push(JSON.parse(buffer.slice(0, newline)));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    }
    expect(buffer).toBe("");
  })();
  const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
  try {
    // Split a JSON frame across writes to exercise the actual stdio reader.
    child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"init');
    child.stdin.write('ialize","params":{"protocolVersion":1,"clientCapabilities":{}}}\n');
    await until(() => messages.some((m) => m.id === 1));
    expect(messages.find((m) => m.id === 1).result.protocolVersion).toBe(1);
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: directory, mcpServers: [] },
    });
    await until(() => messages.some((m) => m.id === 2));
    const sessionId = messages.find((m) => m.id === 2).result.sessionId;
    send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "Hello 🌍" }] },
    });
    await until(() => messages.some((m) => m.id === 3));
    expect(messages.find((m) => m.method === "session/update").params.update.content.text).toBe(
      `hello 🌍 from ${directory}`,
    );
    expect(messages.find((m) => m.id === 3).result.stopReason).toBe("end_turn");
    child.stdin.end();
    expect(await child.exited).toBe(0);
    await reading;
    expect(await errors).toContain("Labkit diagnostics:");
  } finally {
    child.kill();
    await child.exited;
    await rm(directory, { recursive: true, force: true });
  }
});
