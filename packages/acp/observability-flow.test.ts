import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@logtape/testing-bun/autoload";

// Verify the operator's artifact, through the actual CLI, rather than a mock logging sink.
test("persisted CLI trace joins ACP, permission, tool and provider failure across restart", async () => {
  const retain = process.env.LABKIT_ACP_KEEP_TRACE === "1";
  const parent = retain
    ? new URL("../../.session-artifacts/acp-debug/", import.meta.url).pathname
    : tmpdir();
  await mkdir(parent, { recursive: true });
  const root = await realpath(await mkdtemp(join(parent, "labkit-trace-flow-")));
  if (retain) console.error(`ACP debug evidence: ${root}`);
  const logs = join(root, "logs");
  const secret = "test-provider-credential-9ad0c2";
  const config = join(root, "config.ts");
  const workspace = new URL(
    process.env.LABKIT_ACP_TEST_BUILT
      ? "./dist/examples/vscode-workspace.js"
      : "./examples/vscode-workspace.ts",
    import.meta.url,
  ).href;
  await writeFile(join(root, "README.md"), "A local file read for the trace test.");
  await Bun.write(
    config,
    `
    import { workspaceAgent } from ${JSON.stringify(workspace)};
    let calls = 0;
    const base = workspaceAgent({ LABKIT_ACP_MODEL: "test-model", LABKIT_ACP_PROVIDER: "anthropic", ANTHROPIC_API_KEY: ${JSON.stringify(secret)} });
    export default { ...base, async sessionOptions(context) {
      const options = await base.sessionOptions(context);
      return { ...options, configuration: { ...options.configuration, policy: { ...options.configuration.policy, stream: false } },
        bindings: { ...options.bindings, providers: new Map([...options.bindings.providers].map(([id, binding]) => [id, { ...binding, transport: { ...binding.transport, fetch: async () => {
          calls++;
          if (calls === 3) return Response.json({error: {type: "invalid_request_error", message: "Unsupported max_tokens; supplied key " + ${JSON.stringify(secret)}}}, {status: 400, headers: {"request-id": "req-provider-failure-123"}});
          return Response.json({role: "assistant", stop_reason: calls === 1 ? "tool_use" : "end_turn", content: calls === 1 ? [{type: "tool_use", id: "read-1", name: "read_file", input: {path: "README.md"}}] : [{type: "text", text: "Read complete"}], usage: {input_tokens: 32, output_tokens: 16}});
        } } }])) }
      };
    } };
  `,
  );
  const launches: ReturnType<typeof launch>[] = [];
  function launch() {
    const child = Bun.spawn(
      [
        process.execPath,
        new URL(process.env.LABKIT_ACP_TEST_BUILT ? "./dist/cli.js" : "./cli.ts", import.meta.url)
          .pathname,
        "--config",
        config,
      ],
      {
        cwd: root,
        env: { ...process.env, LABKIT_ACP_LOG_DIR: logs, LABKIT_ACP_LOG_LEVEL: "debug" },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const messages: any[] = [];
    const stderr = new Response(child.stderr).text();
    const reading = (async () => {
      let buffer = "";
      const decoder = new TextDecoder();
      for await (const bytes of child.stdout) {
        buffer += decoder.decode(bytes, { stream: true });
        let end = buffer.indexOf("\n");
        while (end >= 0) {
          messages.push(JSON.parse(buffer.slice(0, end)));
          buffer = buffer.slice(end + 1);
          end = buffer.indexOf("\n");
        }
      }
      expect(buffer).toBe("");
    })();
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const wait = async (predicate: () => boolean) => {
      const deadline = Date.now() + 5_000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error("Timed out waiting for ACP trace probe");
        await Bun.sleep(5);
      }
    };
    const response = async (id: number) => {
      await wait(() => messages.some((m) => m.id === id && !m.method));
      return messages.find((m) => m.id === id && !m.method);
    };
    return {
      child,
      stderr,
      messages,
      send,
      wait,
      response,
      async stop() {
        child.stdin.end();
        expect(await child.exited).toBe(0);
        await reading;
        expect(await stderr).toContain(logs);
      },
    };
  }
  try {
    const first = launch();
    launches.push(first);
    first.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: {} },
    });
    await first.response(1);
    first.send({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: root, mcpServers: [] },
    });
    const sessionId = (await first.response(2)).result.sessionId;
    first.send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "Read README.md" }] },
    });
    await first.wait(() => first.messages.some((m) => m.method === "session/request_permission"));
    const permission = first.messages.find((m) => m.method === "session/request_permission");
    first.send({
      jsonrpc: "2.0",
      id: permission.id,
      result: { outcome: { outcome: "selected", optionId: "allow-once" } },
    });
    expect((await first.response(3)).result.stopReason).toBe("end_turn");
    first.send({
      jsonrpc: "2.0",
      id: 4,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "Trigger provider failure" }] },
    });
    expect((await first.response(4)).error).toBeDefined();
    await first.stop();

    const second = launch();
    launches.push(second);
    second.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: {} },
    });
    await second.response(1);
    second.send({
      jsonrpc: "2.0",
      id: 2,
      method: "session/load",
      params: { sessionId, cwd: root, mcpServers: [] },
    });
    expect((await second.response(2)).error).toBeUndefined();
    expect(
      second.messages.some(
        (m) => m.method === "session/update" && m.params.update.content?.text === "Read complete",
      ),
    ).toBe(true);
    await second.stop();

    const paths = (await readdir(logs)).filter((name) => name.endsWith(".jsonl"));
    expect(paths).toHaveLength(2);
    const files = await Promise.all(paths.map((name) => Bun.file(join(logs, name)).text()));
    const records = files.flatMap((file) =>
      file
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    );
    const trace = records.filter((record) => record.sessionId === sessionId);
    expect(trace.length).toBeGreaterThan(10);
    const instructions = trace.filter((record) => record.event === "completion.system_prompt");
    expect(instructions).toHaveLength(3);
    expect(instructions[0].level).toBe("info");
    expect(instructions[0].systemMessages[0].content).toContain(`rooted at ${root}`);
    expect(instructions[0].systemMessages[0].content).toContain("Do not claim to have read a file");
    expect(instructions[0].childId).toBeDefined();
    expect(instructions[0].turnId).toBeDefined();
    const failure = trace.find((record) => record.event === "provider.http.rejected");
    expect(failure).toBeDefined();
    expect(JSON.stringify(failure)).toContain("req-provider-failure-123");
    expect(JSON.stringify(failure)).toContain("Unsupported max_tokens");
    expect(failure.childId).toBeDefined();
    expect(failure.turnId).toBeDefined();
    const approval = trace.find((record) => record.event === "acp.permission.waiting");
    expect(approval.rpcRequestId).toBe("3");
    expect(approval.toolCallId).toBe(permission.params.toolCall.toolCallId);
    expect(
      records.some(
        (record) =>
          record.event === "workspace.file.completed" &&
          record.toolCallId === approval.toolCallId &&
          record.path === join(root, "README.md"),
      ),
    ).toBe(true);
    expect(
      trace.some(
        (record) =>
          record.event.includes("permission") && JSON.stringify(record).includes("README.md"),
      ),
    ).toBe(true);
    expect(trace.some((record) => record.appendId)).toBe(true);
    expect(new Set(records.map((record) => record.launcherId)).size).toBe(2);
    expect(files.join("\n")).not.toContain(secret);
    expect(JSON.stringify(first.messages)).not.toContain(secret);
  } finally {
    for (const { child } of launches) {
      child.kill();
      await child.exited;
    }
    if (retain) {
      for (const [index, launch] of launches.entries()) {
        await Bun.write(
          join(root, `launch-${index + 1}-messages.json`),
          JSON.stringify(launch.messages, null, 2),
        );
        await Bun.write(join(root, `launch-${index + 1}-stderr.log`), await launch.stderr);
      }
      await Bun.write(
        join(root, "README.md"),
        [
          "# ACP debug evidence",
          "",
          "This run exercised the stdio CLI with scripted HTTP responses; no live provider was called.",
          "The test runner reports pass/fail. These files are retained even when assertions fail.",
          "",
          "- logs/: actual rotating launcher diagnostics, including the deliberately triggered HTTP 400.",
          "- launch-N-messages.json: received ACP replies, updates, and permission requests.",
          "- launch-N-stderr.log: launcher messages and diagnostic file locations.",
          "- .labkit/: workspace journals and blobs used by the restore check.",
          "",
          "Expected failure: req-provider-failure-123, Unsupported max_tokens; credentials must be redacted.",
          "Remove this run directory when finished; retained debug runs are not pruned automatically.",
        ].join("\n"),
      );
    } else await rm(root, { recursive: true, force: true });
  }
}, 20_000);
