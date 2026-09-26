import { expect, test } from "@logtape/testing-bun/autoload";

import { until } from "../core/agent/test-support.ts";
import type { AcpOptions } from "./adapter.ts";
import { workspaceAgent } from "./examples/vscode-workspace.ts";
import { answer, offline, prompt } from "./testing/fixtures.ts";
import { harness, setup } from "./testing/harness.ts";

for (const scenario of [
  "read",
  "write",
  "reject",
  "cancel",
  "error",
  "oversize",
  "unsupported",
] as const) {
  test(`client filesystem ${scenario} stays on the permission and session path`, async () => {
    const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { workspaceFiles, MAX_FILE_BYTES } = await import("./workspace-files.ts");
    const { workspaceTools } = await import("./workspace-tools.ts");
    const { workspaceToolContent } = await import("./file-write.ts");
    const cwd = await mkdtemp(join(tmpdir(), "labkit-client-fs-"));
    await writeFile(join(cwd, "README.md"), "disk contents");
    const files = await workspaceFiles(cwd);
    let completions = 0;
    const writing = scenario === "write" || scenario === "reject";
    const base = setup({
      complete: (request) => {
        if (++completions === 1)
          return {
            kind: "tools",
            text: "Access file",
            calls: [
              {
                id: "file",
                name: writing ? "write_file" : "read_file",
                args: writing ? { path: "README.md", text: "editor write" } : { path: "README.md" },
              },
            ],
          };
        expect(JSON.stringify(request.messages)).toContain(
          writing
            ? "README.md"
            : scenario === "unsupported"
              ? "disk contents"
              : "unsaved editor contents",
        );
        return answer;
      },
    });
    const options: AcpOptions = {
      ...base.options,
      sessionOptions: async (context) => {
        const original = await base.options.sessionOptions(context);
        expect(Boolean(context.clientFiles?.readText)).toBe(scenario !== "unsupported");
        expect(Boolean(context.clientFiles?.write)).toBe(writing);
        const tools = workspaceTools(files, context.clientFiles);
        return {
          ...original,
          configuration: {
            ...original.configuration,
            agents: new Map([["a", { model: "m", tools: [...tools.keys()] }]]),
          },
          bindings: { ...original.bindings, tools },
          toolContent: workspaceToolContent,
        };
      },
    };
    let h = harness(options);
    try {
      await h.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: scenario !== "unsupported", writeTextFile: writing },
        },
      });
      const id = (await h.request("session/new", { cwd, mcpServers: [] })).result.sessionId;
      const turn = await h.start("session/prompt", prompt(id));
      await until(() =>
        h.messages.some((message) => message.method === "session/request_permission"),
      );
      const permission = h.messages.find(
        (message) => message.method === "session/request_permission",
      )!;
      expect(permission.params.toolCall.locations).toEqual([
        { path: join(files.root, "README.md") },
      ]);
      expect(h.messages.some((message) => message.method?.startsWith("fs/"))).toBe(false);
      const option = permission.params.options.find(
        (value: any) => value.kind === (scenario === "reject" ? "reject_once" : "allow_once"),
      );
      await h.send({
        jsonrpc: "2.0",
        id: permission.id,
        result: { outcome: { outcome: "selected", optionId: option.optionId } },
      });
      if (scenario !== "reject" && scenario !== "unsupported") {
        await until(() => h.messages.some((message) => message.method?.startsWith("fs/")));
        if (writing) {
          const baseline = h.messages.find((message) => message.method === "fs/read_text_file")!;
          expect(baseline.params.path).toBe(join(files.root, "README.md"));
          await h.send({
            jsonrpc: "2.0",
            id: baseline.id,
            result: { content: "unsaved editor contents" },
          });
          await until(() => h.messages.some((message) => message.method === "fs/write_text_file"));
        }
        const file = h.messages.find(
          (message) => message.method === (writing ? "fs/write_text_file" : "fs/read_text_file"),
        )!;
        expect(file.method).toBe(writing ? "fs/write_text_file" : "fs/read_text_file");
        expect(file.params).toEqual({
          sessionId: id,
          path: join(files.root, "README.md"),
          ...(writing ? { content: "editor write" } : {}),
        });
        if (scenario === "cancel")
          await h.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: id } });
        else
          await h.send({
            jsonrpc: "2.0",
            id: file.id,
            ...(scenario === "error"
              ? { error: { code: -32000, message: "Editor unavailable" } }
              : {
                  result: writing
                    ? {}
                    : {
                        content:
                          scenario === "oversize"
                            ? "x".repeat(MAX_FILE_BYTES + 1)
                            : "unsaved editor contents",
                      },
                }),
          });
      }
      const response = await h.response(turn);
      if (scenario === "error" || scenario === "oversize")
        expect(response.error?.code).toBe(-32000);
      else
        expect(response.result.stopReason).toBe(
          scenario === "reject" ? "refusal" : scenario === "cancel" ? "cancelled" : "end_turn",
        );
      if (scenario === "reject" || scenario === "unsupported")
        expect(h.messages.some((message) => message.method?.startsWith("fs/"))).toBe(false);
      expect(await readFile(join(cwd, "README.md"), "utf8")).toBe("disk contents");
      if (scenario === "write") {
        const expected = {
          type: "diff",
          path: join(files.root, "README.md"),
          oldText: "unsaved editor contents",
          newText: "editor write",
        };
        expect(
          h
            .updates()
            .map(({ update }) => update)
            .find(
              (update) =>
                update.sessionUpdate === "tool_call_update" && update.status === "completed",
            ),
        ).toMatchObject({ content: [expected] });
        await h.close();
        await writeFile(join(cwd, "README.md"), "later disk edit");
        h = harness(options);
        await h.request("initialize", {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
          },
        });
        expect(
          (await h.request("session/load", { cwd, sessionId: id, mcpServers: [] })).error,
        ).toBeUndefined();
        expect(
          h
            .updates()
            .map(({ update }) => update)
            .find(
              (update) =>
                update.sessionUpdate === "tool_call_update" && update.status === "completed",
            ),
        ).toMatchObject({ content: [expected], _meta: { "labkit.dev/reconstructed": true } });
        expect(
          h.messages.some(
            (message) =>
              message.method?.startsWith("fs/") || message.method === "session/request_permission",
          ),
        ).toBe(false);
        expect(completions).toBe(2);
        expect(await readFile(join(cwd, "README.md"), "utf8")).toBe("later disk edit");
      }
    } finally {
      await h.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

test("workspace ACP reports missing-file errors to the model, completes sibling reads, and supplies recovery instructions to the next completion", async () => {
  const { mkdir, realpath } = await import("node:fs/promises");
  const { resolve, join } = await import("node:path");
  const { withFixtureDiagnostics } = await import("../core/logging/fixture-capture.ts");
  const directory = resolve(`.session-artifacts/acp-tool-recovery/${crypto.randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const cwd = await realpath(directory);
  await withFixtureDiagnostics(directory, {}, async () => {
    const workspace = workspaceAgent({ ANTHROPIC_API_KEY: "scripted-credential" }, undefined, {
      fetch: offline,
    });
    let completions = 0;
    const modelRequests: unknown[] = [];
    const h = harness({
      ...workspace,
      sessionOptions: async (context) => {
        const options = await workspace.sessionOptions(context);
        expect(options.configuration.policy?.toolFailure).toBe("return-error-and-continue");
        return {
          ...options,
          config: undefined,
          configuration: {
            ...options.configuration,
            policy: {
              permissions: options.configuration.policy!.permissions,
              toolFailure: options.configuration.policy!.toolFailure,
            },
          },
          bindings: {
            ...options.bindings,
            providers: undefined,
            complete: (request) => {
              modelRequests.push(request);
              completions++;
              if (completions === 1)
                return {
                  kind: "tools",
                  text: "Read the documentation",
                  calls: [
                    {
                      id: "missing",
                      name: "read_file",
                      args: { path: "packages/core/agent/README.md" },
                    },
                    {
                      id: "existing",
                      name: "read_file",
                      args: { path: "packages/acp/protocol-reference.md" },
                    },
                  ],
                };
              const results = request.messages.filter((message) => message.role === "tool");
              if (completions === 2) {
                expect(results).toHaveLength(2);
                expect(JSON.stringify(results)).toContain("ENOENT");
                expect(JSON.stringify(results)).toContain("list_dir");
                expect(JSON.stringify(results)).toContain("discover existing names");
                expect(JSON.stringify(results)).toContain("packages/core/agent/README.md");
                expect(JSON.stringify(results)).toContain("Protocol documentation contents");
                return {
                  kind: "tools",
                  text: "The requested README is absent; read the agent implementation instead",
                  calls: [
                    {
                      id: "recovery",
                      name: "read_file",
                      args: { path: "packages/core/agent/agent.ts" },
                    },
                  ],
                };
              }
              expect(JSON.stringify(results)).toContain("Agent implementation contents");
              return {
                kind: "answer",
                text: "Review completed using the implementation and protocol reference; the agent README does not exist.",
              };
            },
          },
        };
      },
    });
    try {
      await h.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true } },
      });
      const opened = await h.request("session/new", { cwd, mcpServers: [] });
      expect(opened.error).toBeUndefined();
      const sessionId = opened.result.sessionId;
      const turn = await h.start("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "Review this project's documentation" }],
      });
      await until(() =>
        h.messages.some((message) => message.method === "session/request_permission"),
      );
      const permission = h.messages.find(
        (message) => message.method === "session/request_permission",
      )!;
      await h.send({
        jsonrpc: "2.0",
        id: permission.id,
        result: { outcome: { outcome: "selected", optionId: "allow-session" } },
      });
      await until(
        () => h.messages.filter((message) => message.method === "fs/read_text_file").length === 2,
      );
      const reads = h.messages.filter((message) => message.method === "fs/read_text_file");
      for (const read of reads) {
        if (read.params.path.endsWith("README.md"))
          await h.send({
            jsonrpc: "2.0",
            id: read.id,
            error: {
              code: -32603,
              message: "Internal error",
              data: {
                details: `Error: ENOENT: no such file or directory, open '${read.params.path}'`,
              },
            },
          });
        else
          await h.send({
            jsonrpc: "2.0",
            id: read.id,
            result: { content: "Protocol documentation contents" },
          });
      }
      await until(
        () => h.messages.filter((message) => message.method === "fs/read_text_file").length === 3,
      );
      const recovery = h.messages.filter((message) => message.method === "fs/read_text_file")[2]!;
      expect(recovery.params.path).toBe(join(cwd, "packages/core/agent/agent.ts"));
      await h.send({
        jsonrpc: "2.0",
        id: recovery.id,
        result: { content: "Agent implementation contents" },
      });
      expect((await h.response(turn)).result.stopReason).toBe("end_turn");
      expect(completions).toBe(3);
      expect(
        h.messages.filter((message) => message.method === "session/request_permission"),
      ).toHaveLength(1);
      const updates = h.updates().map((message) => message.update);
      expect(
        updates.some(
          (update) =>
            update.sessionUpdate === "tool_call_update" &&
            update.toolCallId.endsWith("/missing") &&
            update.status === "failed",
        ),
      ).toBe(true);
      expect(
        updates.some(
          (update) =>
            update.sessionUpdate === "tool_call_update" &&
            update.toolCallId.endsWith("/existing") &&
            update.status === "completed",
        ),
      ).toBe(true);
    } finally {
      await h.close();
      await Bun.write(join(directory, "protocol.json"), JSON.stringify(h.messages, null, 2));
      await Bun.write(
        join(directory, "model-requests.json"),
        JSON.stringify(modelRequests, null, 2),
      );
    }
  });
  const records = (await Bun.file(join(directory, "diagnostics.jsonl")).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const failure = records.find((record) => record.event === "client_file.failed");
  expect(failure).toMatchObject({ level: "warning", operation: "fs/read_text_file" });
  expect(failure.path).toContain("packages/core/agent/README.md");
  expect(JSON.stringify(failure.error)).toContain("ENOENT");
  expect(failure.toolCallId).toEndWith("/missing");
  expect(
    records.some(
      (record) =>
        record.event === "client_file.completed" && record.path.endsWith("protocol-reference.md"),
    ),
  ).toBe(true);
});

test("read_file forwards line ranges to the ACP client and retains range diagnostics", async () => {
  const { workspaceFiles } = await import("./workspace-files.ts");
  const { workspaceTools } = await import("./workspace-tools.ts");
  const { withFixtureDiagnostics } = await import("../core/logging/fixture-capture.ts");
  const directory = `.session-artifacts/acp-file-range/${crypto.randomUUID()}`;
  await withFixtureDiagnostics(directory, {}, async () => {
    let completions = 0;
    const base = setup({
      complete: (request) => {
        if (++completions === 1)
          return {
            kind: "tools",
            text: "Read the relevant lines",
            calls: [
              { id: "range", name: "read_file", args: { path: "note.txt", line: 10, limit: 3 } },
            ],
          };
        expect(request.messages.find((message) => message.role === "tool")!.content).toContain(
          "Unsaved editor lines",
        );
        return answer;
      },
    });
    const h = harness({
      ...base.options,
      sessionOptions: async (context) => {
        const options = await base.options.sessionOptions(context);
        return {
          ...options,
          configuration: {
            ...options.configuration,
            policy: { permissions: "off" },
            agents: new Map([["a", { model: "m", tools: ["read_file"] }]]),
          },
          bindings: {
            ...options.bindings,
            tools: workspaceTools(await workspaceFiles(context.cwd), context.clientFiles),
          },
        };
      },
    });
    try {
      await h.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true } },
      });
      const sessionId = await h.newSession();
      const turn = await h.start("session/prompt", prompt(sessionId));
      await until(() => h.messages.some((message) => message.method === "fs/read_text_file"));
      const request = h.messages.find((message) => message.method === "fs/read_text_file")!;
      expect(request.params).toMatchObject({ sessionId, line: 10, limit: 3 });
      expect(request.params.path).toEndWith("/note.txt");
      await h.send({ jsonrpc: "2.0", id: request.id, result: { content: "Unsaved editor lines" } });
      expect((await h.response(turn)).result.stopReason).toBe("end_turn");
    } finally {
      await h.close();
    }
  });
  const records = (await Bun.file(`${directory}/diagnostics.jsonl`).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(records.find((record) => record.event === "client_file.completed")).toMatchObject({
    line: 10,
    limit: 3,
  });
  expect(records.filter((record) => ["warning", "error"].includes(record.level))).toHaveLength(0);
});
