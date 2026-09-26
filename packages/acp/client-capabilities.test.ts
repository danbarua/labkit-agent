/**
 * The agent calls a client method only when the client advertised it in `initialize`. Positive
 * paths already covered in adapter.test.ts are not repeated here; these cases close the gaps
 * (partial fs capabilities, launcher terminal gating, boolean options in later updates, and
 * absent elicitation).
 */
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ClientCapabilities } from "@agentclientprotocol/sdk";
import { defineTool, type CompletionPortRequest } from "@labkit-agent/core";
import { expect, test } from "@logtape/testing-bun/autoload";
import { z } from "zod";

import type { ClientElicitation } from "./client-elicitation.ts";
import { workspaceAgent } from "./examples/vscode-workspace.ts";
import { harness, setup, type Message } from "./testing/harness.ts";
import { workspaceFiles } from "./workspace-files.ts";
import { workspaceTools } from "./workspace-tools.ts";

// Keep launcher tests off any real local model server.
const offline = (async () => {
  throw new Error("offline");
}) as unknown as typeof fetch;

type Answers = (message: Message) => { result: unknown } | undefined;

/** Answer each client request as the adapter writes it; unanswered requests stay pending. */
function answering(h: { messages: Message[]; send: (value: unknown) => unknown }, answer: Answers) {
  const push = h.messages.push.bind(h.messages);
  h.messages.push = (...frames: Message[]) => {
    for (const frame of frames) {
      const reply = frame.method && frame.id != null ? answer(frame) : undefined;
      if (reply) void h.send({ jsonrpc: "2.0", id: frame.id, ...reply });
    }
    return push(...frames);
  };
}

const clientMethods = (messages: readonly Message[], prefix: string) =>
  messages.filter((message) => message.id != null && message.method?.startsWith(prefix));

for (const fs of [
  { readTextFile: true, writeTextFile: false },
  { readTextFile: false, writeTextFile: true },
] as const)
  test(`fs readTextFile=${fs.readTextFile} writeTextFile=${fs.writeTextFile}: each fs method is used only when advertised, otherwise workspace files are used`, async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "labkit-client-fs-caps-")));
    await writeFile(join(cwd, "README.md"), "disk contents");
    const files = await workspaceFiles(cwd);
    const readme = join(files.root, "README.md");
    const requests: CompletionPortRequest[] = [];
    const base = setup();
    const h = harness({
      ...base.options,
      sessionOptions: async (context) => {
        const original = await base.options.sessionOptions(context);
        expect(Boolean(context.clientFiles?.readText)).toBe(fs.readTextFile);
        expect(Boolean(context.clientFiles?.write)).toBe(fs.writeTextFile);
        const tools = workspaceTools(files, context.clientFiles);
        return {
          ...original,
          configuration: {
            ...original.configuration,
            agents: new Map([["a", { model: "m", tools: [...tools.keys()], successors: [] }]]),
            policy: { permissions: "off" },
          },
          bindings: {
            ...original.bindings,
            tools,
            complete: (request) => {
              requests.push(request);
              if (requests.length === 1)
                return {
                  kind: "tools",
                  text: "Read",
                  calls: [{ id: "read", name: "read_file", args: { path: "README.md" } }],
                };
              if (requests.length === 2)
                return {
                  kind: "tools",
                  text: "Write",
                  calls: [
                    { id: "write", name: "write_file", args: { path: "README.md", text: "agent" } },
                  ],
                };
              return { kind: "answer", text: "Done" };
            },
          },
        };
      },
    });
    answering(h, (message) =>
      message.method === "fs/read_text_file"
        ? { result: { content: "editor buffer" } }
        : message.method === "fs/write_text_file"
          ? { result: {} }
          : undefined,
    );
    try {
      await h.request("initialize", { protocolVersion: 1, clientCapabilities: { fs } });
      const sessionId = (await h.request("session/new", { cwd, mcpServers: [] })).result.sessionId;
      const turn = await h.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "Edit README" }],
      });
      expect(turn.result.stopReason).toBe("end_turn");
      const read = requests[1]?.messages.find(
        (message) => message.role === "tool" && message.tool_call_id === "read",
      );
      const reads = clientMethods(h.messages, "fs/read_text_file");
      const writes = clientMethods(h.messages, "fs/write_text_file");
      if (fs.readTextFile) {
        expect(read?.content).toContain("editor buffer");
        expect(reads.map((message) => message.params)).toEqual([{ sessionId, path: readme }]);
        expect(writes).toEqual([]);
        expect(await readFile(readme, "utf8")).toBe("agent");
      } else {
        expect(read?.content).toContain("disk contents");
        expect(reads).toEqual([]);
        expect(writes.map((message) => message.params)).toEqual([
          { sessionId, path: readme, content: "agent" },
        ]);
        expect(await readFile(readme, "utf8")).toBe("disk contents");
      }
    } finally {
      await h.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });

for (const variant of [
  { terminal: true, env: "1", offered: true },
  { terminal: false, env: "1", offered: false },
  { terminal: true, env: undefined, offered: false },
] as const)
  test(`launcher terminal=${variant.terminal} LABKIT_ACP_TERMINAL=${variant.env}: run_command is ${variant.offered ? "offered and routed to terminal/*" : "not offered and no terminal/* request is sent"}`, async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "labkit-terminal-caps-")));
    const launcher = workspaceAgent(
      {
        ANTHROPIC_API_KEY: "fixture",
        ...(variant.env ? { LABKIT_ACP_TERMINAL: variant.env } : {}),
      },
      undefined,
      { fetch: offline },
    );
    const offered: string[][] = [];
    const results: string[] = [];
    const h = harness({
      ...launcher,
      sessionOptions: async (context) => {
        expect(Boolean(context.terminal)).toBe(variant.terminal);
        const options = await launcher.sessionOptions(context);
        return {
          ...options,
          config: undefined,
          configuration: {
            ...options.configuration,
            policy: { permissions: "ask", toolFailure: "fail-turn" },
          },
          bindings: {
            ...options.bindings,
            providers: undefined,
            complete: (request) => {
              offered.push((request.tools ?? []).map((tool) => tool.function.name));
              results.push(
                ...request.messages.flatMap((message) =>
                  message.role === "tool" ? [String(message.content)] : [],
                ),
              );
              return offered.length === 1 && variant.offered
                ? {
                    kind: "tools",
                    text: "Run tests",
                    calls: [
                      { id: "cmd", name: "run_command", args: { command: "bun", args: ["test"] } },
                    ],
                  }
                : { kind: "answer", text: "Done" };
            },
          },
        };
      },
    });
    answering(h, (message) => {
      if (message.method === "session/request_permission")
        return { result: { outcome: { outcome: "selected", optionId: "allow-once" } } };
      if (message.method === "terminal/create") return { result: { terminalId: "term-1" } };
      if (message.method === "terminal/wait_for_exit") return { result: { exitCode: 0 } };
      if (message.method === "terminal/output")
        return { result: { output: "3 pass", truncated: false } };
      if (message.method === "terminal/release") return { result: {} };
      return undefined;
    });
    try {
      await h.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { terminal: variant.terminal },
      });
      const sessionId = (await h.request("session/new", { cwd, mcpServers: [] })).result.sessionId;
      const turn = await h.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "Run the tests" }],
      });
      expect(turn.error).toBeUndefined();
      expect(turn.result.stopReason).toBe("end_turn");
      expect(offered[0]?.includes("run_command")).toBe(variant.offered);
      const terminal = clientMethods(h.messages, "terminal/");
      if (variant.offered) {
        expect(terminal.map((message) => message.method)).toEqual([
          "terminal/create",
          "terminal/wait_for_exit",
          "terminal/output",
          "terminal/release",
        ]);
        expect(terminal[0]?.params).toMatchObject({
          sessionId,
          command: "bun",
          args: ["test"],
          cwd,
        });
        expect(results.join("\n")).toContain("3 pass");
      } else expect(terminal).toEqual([]);
    } finally {
      await h.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });

for (const booleans of [undefined, {}] as const)
  test(`launcher boolean config options ${booleans ? "reach" : "never reach"} a client ${booleans ? "advertising" : "without"} session.configOptions.boolean, including later config_option_update`, async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "labkit-boolean-caps-")));
    const h = harness(
      workspaceAgent({ ANTHROPIC_API_KEY: "fixture" }, undefined, { fetch: offline }),
    );
    try {
      await h.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: booleans ? { session: { configOptions: { boolean: booleans } } } : {},
      });
      const opened = await h.request("session/new", { cwd, mcpServers: [] });
      const changed = await h.request("session/set_config_option", {
        sessionId: opened.result.sessionId,
        configId: "permissions",
        value: "off",
      });
      expect(changed.error).toBeUndefined();
      const update = h
        .updates()
        .find(({ update }) => update.sessionUpdate === "config_option_update")?.update;
      expect(update).toBeDefined();
      const stream = { id: "stream", type: "boolean", currentValue: true };
      for (const options of [
        opened.result.configOptions,
        changed.result.configOptions,
        update?.sessionUpdate === "config_option_update" ? update.configOptions : undefined,
      ])
        if (booleans) expect(options).toContainEqual(expect.objectContaining(stream));
        else expect(options).not.toContainEqual(expect.objectContaining({ id: "stream" }));
      if (!booleans) expect(JSON.stringify(h.messages)).not.toContain('"type":"boolean"');
    } finally {
      await h.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });

for (const capabilities of [
  {},
  { elicitation: null },
  { elicitation: { form: null, url: null } },
  { elicitation: { url: {} } },
] satisfies ClientCapabilities[])
  test(`elicitation ${JSON.stringify(capabilities)}: unadvertised modes are absent from session and auth ports and elicitation/create is never sent`, async () => {
    const url = capabilities.elicitation?.url != null;
    const ports: ClientElicitation[] = [];
    const results: string[] = [];
    const base = setup();
    const h = harness({
      ...base.options,
      auth: {
        methods: [{ id: "browser", name: "Browser login" }],
        isAuthenticated: () => true,
        authenticate: async (_method, _signal, context) => {
          ports.push(context.elicitation);
          throw new Error("Browser login requires form elicitation, which this client lacks");
        },
      },
      sessionOptions: async (context) => {
        const original = await base.options.sessionOptions(context);
        const elicitation = context.elicitation ?? {};
        ports.push(elicitation);
        return {
          ...original,
          configuration: {
            ...original.configuration,
            agents: new Map([["a", { model: "m", tools: ["ask"], successors: [] }]]),
            policy: { permissions: "off" },
          },
          bindings: {
            ...original.bindings,
            complete: (request) => {
              const answered = request.messages.filter((message) => message.role === "tool");
              results.push(...answered.map((message) => String(message.content)));
              return answered.length
                ? { kind: "answer", text: "Done" }
                : { kind: "tools", text: "Ask", calls: [{ id: "ask", name: "ask", args: {} }] };
            },
            tools: new Map([
              [
                "ask",
                defineTool({
                  input: z.object({}),
                  run: async (_input, signal, operation) =>
                    elicitation.form
                      ? JSON.stringify(
                          await elicitation.form(
                            { message: "Pick", requestedSchema: { properties: {} } },
                            signal,
                            operation,
                          ),
                        )
                      : "form elicitation unavailable",
                }),
              ],
            ]),
          },
        };
      },
    });
    try {
      await h.request("initialize", { protocolVersion: 1, clientCapabilities: capabilities });
      const sessionId = await h.newSession();
      const turn = await h.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "Ask me" }],
      });
      expect(turn.result.stopReason).toBe("end_turn");
      expect(results).toEqual(["form elicitation unavailable"]);
      expect((await h.request("authenticate", { methodId: "browser" })).error).toBeDefined();
      expect(ports).toHaveLength(2);
      for (const port of ports) {
        expect(port.form).toBeUndefined();
        expect(Boolean(port.url)).toBe(url);
      }
      expect(h.messages.some((message) => message.method?.startsWith("elicitation/"))).toBe(false);
    } finally {
      await h.close();
    }
  });
