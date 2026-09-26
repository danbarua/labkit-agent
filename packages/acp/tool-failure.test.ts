/**
 * Rule 3: a non-MCP tool failure on the ACP path is a tool result unless core policy fails the
 * turn, and it never ends the JSON-RPC connection. Each scenario runs the real adapter handlers
 * through the in-process harness under both tool-failure policies.
 */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ClientCapabilities } from "@agentclientprotocol/sdk";
import { defineTool, type CompletionPortRequest, type Tool } from "@labkit-agent/core";
import { getLogger } from "@logtape/logtape";
import { expect, spyOn, test } from "@logtape/testing-bun/autoload";
import { z } from "zod";

import { terminalTool } from "./client-terminal.ts";
import { harness, setup, type Message } from "./testing/harness.ts";
import { workspaceFiles } from "./workspace-files.ts";
import { workspaceTools } from "./workspace-tools.ts";

type Reply =
  { result: unknown } | { error: { code: number; message: string; data?: unknown } } | undefined;

type Policy = "return-error-and-continue" | "fail-turn";

type Scenario = Readonly<{
  name: string;
  call: { name: string; args: Record<string, unknown> };
  capabilities?: ClientCapabilities;
  /** Client answers to outbound requests; unanswered permission requests allow once. */
  reply?: (message: Message) => Reply;
  toolTimeoutMs?: number;
  classification: string;
  /** Operation that failed; permission failures name the permission child, not the tool. */
  operation?: "tool" | "permission";
  /** Evidence on the failed tool card; undefined when core only reports a generic message. */
  card?: string;
  /** Evidence in the tool result the model receives, and in the JSON-RPC failure message. */
  detail: string;
  /** Core fails the turn even under return-error-and-continue. */
  failsTurn?: boolean;
  /** Diagnostic event the failure must emit, with fields it must carry. */
  event?: { event: string } & Record<string, unknown>;
}>;

const throwing = (name: string, value: () => unknown): [string, Tool] => [
  name,
  defineTool({
    input: z.object({}),
    run: () => {
      throw value();
    },
  }),
];

const circular = () => {
  const value: Record<string, unknown> = { reason: "circular failure" };
  value.self = value;
  return value;
};

const localTools = new Map<string, Tool>([
  ["echo", defineTool({ input: z.object({ text: z.string() }), run: ({ text }) => text })],
  throwing("throw_string", () => "plain string failure"),
  throwing("throw_undefined", () => undefined),
  throwing("throw_object", () => ({ code: 7, reason: "object failure" })),
  throwing("throw_bigint", () => 12n),
  throwing("throw_circular", circular),
  [
    "hang",
    defineTool({
      input: z.object({}),
      run: (_, signal) =>
        new Promise<never>((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        ),
    }),
  ],
]);

const command = { name: "run_command", args: { command: "bun", args: ["test"] } };

const clientError = (message: string) => ({ error: { code: -32000, message } });

/** Terminal client whose `failing` method answers with `answer`; others succeed. */
const terminal =
  (failing: string, answer: Reply) =>
  (message: Message): Reply => {
    if (message.method === failing) return answer;
    if (message.method === "terminal/create") return { result: { terminalId: "term-1" } };
    if (message.method === "terminal/wait_for_exit") return { result: { exitCode: 0 } };
    if (message.method === "terminal/output")
      return { result: { output: "test output", truncated: false } };
    if (message.method?.startsWith("terminal/")) return { result: {} };
    return undefined;
  };

const scenarios: Scenario[] = [
  {
    name: "a workspace read of a missing file",
    call: { name: "read_file", args: { path: "missing.txt" } },
    classification: "execution",
    card: "ENOENT",
    detail: "list_dir",
  },
  {
    name: "a workspace path reserved for session storage",
    call: { name: "read_file", args: { path: ".labkit/store" } },
    classification: "invalid_input",
    detail: "reserved for session storage",
  },
  {
    name: "a workspace file over the read limit",
    call: { name: "read_file", args: { path: "big.txt" } },
    classification: "execution",
    card: "File exceeds 262144 bytes",
    detail: "select fewer lines",
  },
  {
    name: "invalid tool arguments",
    call: { name: "echo", args: { text: 5 } },
    classification: "invalid_input",
    detail: "expected string, received number",
  },
  {
    name: "a client error on fs/read_text_file",
    call: { name: "read_file", args: { path: "README.md" } },
    capabilities: { fs: { readTextFile: true } },
    reply: (m) =>
      m.method === "fs/read_text_file" ? clientError("Editor buffer unavailable") : undefined,
    classification: "execution",
    card: "Editor buffer unavailable",
    detail: "fs/read_text_file failed",
    event: { event: "client_file.failed", operation: "fs/read_text_file", outcome: "failed" },
  },
  {
    name: "an invalid fs/read_text_file result",
    call: { name: "read_file", args: { path: "README.md" } },
    capabilities: { fs: { readTextFile: true } },
    reply: (m) => (m.method === "fs/read_text_file" ? { result: {} } : undefined),
    classification: "execution",
    card: "content must be a string",
    detail: "invalid result",
    event: { event: "client_file.failed", operation: "fs/read_text_file", outcome: "failed" },
  },
  {
    name: "a client error on fs/write_text_file",
    call: { name: "write_file", args: { path: "README.md", text: "editor write" } },
    capabilities: { fs: { readTextFile: true, writeTextFile: true } },
    reply: (m) =>
      m.method === "fs/read_text_file"
        ? { result: { content: "unsaved" } }
        : m.method === "fs/write_text_file"
          ? clientError("Editor save failed")
          : undefined,
    classification: "execution",
    card: "Editor save failed",
    detail: "fs/write_text_file failed",
    event: { event: "client_file.failed", operation: "fs/write_text_file", outcome: "failed" },
  },
  {
    name: "a client error on terminal/create",
    call: command,
    capabilities: { terminal: true },
    reply: terminal("terminal/create", clientError("Terminal spawn failed")),
    classification: "execution",
    card: "Terminal spawn failed",
    detail: "Terminal spawn failed",
    event: { event: "client_terminal.failed", outcome: "failed" },
  },
  {
    name: "an invalid terminal/create result",
    call: command,
    capabilities: { terminal: true },
    reply: terminal("terminal/create", { result: {} }),
    classification: "execution",
    card: "terminalId must be a non-empty string",
    detail: "invalid result",
    event: { event: "client_terminal.failed", outcome: "failed" },
  },
  {
    name: "a client error on terminal/wait_for_exit",
    call: command,
    capabilities: { terminal: true },
    reply: terminal("terminal/wait_for_exit", clientError("Terminal wait failed")),
    classification: "execution",
    card: "Terminal wait failed",
    detail: "Terminal wait failed",
    event: { event: "client_terminal.failed", terminalId: "term-1", outcome: "failed" },
  },
  {
    name: "an invalid terminal/wait_for_exit result",
    call: command,
    capabilities: { terminal: true },
    reply: terminal("terminal/wait_for_exit", { result: null }),
    classification: "execution",
    card: "the result must be an object",
    detail: "invalid result",
    event: { event: "client_terminal.failed", terminalId: "term-1", outcome: "failed" },
  },
  {
    name: "a client error on terminal/output",
    call: command,
    capabilities: { terminal: true },
    reply: terminal("terminal/output", clientError("Terminal output failed")),
    classification: "execution",
    card: "Terminal output failed",
    detail: "Terminal output failed",
    event: { event: "client_terminal.failed", terminalId: "term-1", outcome: "failed" },
  },
  {
    name: "an invalid terminal/output result",
    call: command,
    capabilities: { terminal: true },
    reply: terminal("terminal/output", { result: { output: 3 } }),
    classification: "execution",
    card: "output must be a string and truncated must be a boolean",
    detail: "invalid result",
    event: { event: "client_terminal.failed", terminalId: "term-1", outcome: "failed" },
  },
  {
    name: "a client error on terminal/kill after a failed wait",
    call: command,
    capabilities: { terminal: true },
    reply: (m) =>
      m.method === "terminal/kill"
        ? clientError("Terminal kill failed")
        : terminal("terminal/wait_for_exit", clientError("Terminal wait failed"))(m),
    classification: "execution",
    card: "Terminal wait failed",
    detail: "Terminal wait failed",
    event: { event: "client_terminal.kill_failed", terminalId: "term-1" },
  },
  {
    name: "a client error on terminal/release",
    call: command,
    capabilities: { terminal: true },
    reply: terminal("terminal/release", clientError("Terminal release failed")),
    classification: "execution",
    card: "Terminal release failed",
    detail: "Terminal release failed",
    event: { event: "client_terminal.release_failed", terminalId: "term-1" },
  },
  {
    name: "a thrown string",
    call: { name: "throw_string", args: {} },
    classification: "execution",
    card: "plain string failure",
    detail: "plain string failure",
  },
  {
    name: "a thrown bigint",
    call: { name: "throw_bigint", args: {} },
    classification: "execution",
    card: "12",
    detail: "12",
  },
  {
    name: "thrown undefined",
    call: { name: "throw_undefined", args: {} },
    classification: "execution",
    detail: "Unknown failure",
  },
  {
    name: "a thrown plain object",
    call: { name: "throw_object", args: {} },
    classification: "execution",
    detail: "object failure",
  },
  {
    name: "a thrown circular object",
    call: { name: "throw_circular", args: {} },
    classification: "execution",
    detail: "circular failure",
  },
  {
    name: "a tool deadline",
    call: { name: "hang", args: {} },
    // A real deadline: the core tool timeout is an AbortSignal timer, not a fake clock.
    toolTimeoutMs: 20,
    classification: "timeout",
    card: "exceeded its 20 ms deadline",
    detail: "exceeded its 20 ms deadline",
    failsTurn: true,
  },
  {
    name: "a client error on session/request_permission",
    call: { name: "echo", args: { text: "x" } },
    reply: (m) =>
      m.method === "session/request_permission" ? clientError("Permission UI crashed") : undefined,
    classification: "execution",
    operation: "permission",
    detail: "Permission UI crashed",
    failsTurn: true,
    event: { event: "acp.permission.failed", toolName: "echo", rpcRequestId: "3" },
  },
  {
    name: "an invalid session/request_permission result",
    call: { name: "echo", args: { text: "x" } },
    reply: (m) =>
      m.method === "session/request_permission"
        ? { result: { outcome: { outcome: "selected" } } }
        : undefined,
    classification: "execution",
    operation: "permission",
    detail: "a selected outcome must name an optionId",
    failsTurn: true,
    event: {
      event: "acp.permission.invalid_response",
      rpcRequestId: "3",
      toolName: "echo",
      consequence: "Tool does not run; the turn fails",
      reason: expect.stringContaining("a selected outcome must name an optionId"),
    },
  },
];

/** One scenario run: the first prompt's response and what the client and model observed. */
type Run = Readonly<{
  cwd: string;
  sessionId: string;
  first: Message;
  /** Text of the failed tool card for `call1`; undefined when no failed card was published. */
  cardText: string | undefined;
  requests: readonly CompletionPortRequest[];
  messages: readonly Message[];
  closed: Promise<unknown>;
  prompt: (text: string) => Promise<Message>;
  cleanup: () => Promise<void>;
}>;

async function exercise(scenario: Scenario, policy: Policy): Promise<Run> {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "labkit-tool-failure-")));
  await writeFile(join(cwd, "README.md"), "disk contents");
  await writeFile(join(cwd, "big.txt"), "x".repeat(300 * 1024));
  await mkdir(join(cwd, ".labkit"));
  const requests: CompletionPortRequest[] = [];
  const base = setup();
  const h = harness({
    ...base.options,
    sessionOptions: async (context) => {
      const original = await base.options.sessionOptions(context);
      const tools = new Map<string, Tool>([
        ...localTools,
        ...workspaceTools(await workspaceFiles(cwd), context.clientFiles),
      ]);
      if (context.terminal) tools.set("run_command", terminalTool(context.terminal, cwd));
      return {
        ...original,
        configuration: {
          ...original.configuration,
          agents: new Map([["a", { model: "m", tools: [...tools.keys()], successors: [] }]]),
          policy: {
            permissions: "ask",
            toolFailure: policy,
            ...(scenario.toolTimeoutMs ? { toolTimeoutMs: scenario.toolTimeoutMs } : {}),
          },
        },
        bindings: {
          ...original.bindings,
          tools,
          // Odd steps call the scenario tool; even steps answer. A failed turn consumes one step.
          complete: (request) => {
            requests.push(request);
            return requests.length % 2
              ? { kind: "tools", text: "Using a tool", calls: [{ id: "call1", ...scenario.call }] }
              : { kind: "answer", text: "Recovered" };
          },
        },
      };
    },
  });
  // Answer each client request as the adapter writes it.
  const push = h.messages.push.bind(h.messages);
  h.messages.push = (...frames: Message[]) => {
    for (const frame of frames) {
      if (!frame.method || frame.id == null) continue;
      const reply =
        scenario.reply?.(frame) ??
        (frame.method === "session/request_permission"
          ? { result: { outcome: { outcome: "selected", optionId: "allow-once" } } }
          : undefined);
      if (reply) void h.send({ jsonrpc: "2.0", id: frame.id, ...reply });
    }
    return push(...frames);
  };
  await h.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: scenario.capabilities ?? {},
  });
  const sessionId = (await h.request("session/new", { cwd, mcpServers: [] })).result
    .sessionId as string;
  const first = await h.request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "Go" }],
  });
  const card = h
    .updates()
    .map(({ update }) => update)
    .find(
      (update) =>
        update.sessionUpdate === "tool_call_update" &&
        update.status === "failed" &&
        update.toolCallId.endsWith("/call1"),
    );
  return {
    cwd,
    sessionId,
    first,
    cardText:
      card?.sessionUpdate === "tool_call_update"
        ? (card.content ?? [])
            .map((item) =>
              item.type === "content" && item.content.type === "text" ? item.content.text : "",
            )
            .join("\n")
        : undefined,
    requests,
    messages: h.messages,
    closed: h.server.closed,
    prompt: (text) => h.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }),
    cleanup: async () => {
      await h.close();
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

async function guarded(body: (records: () => Record<string, unknown>[]) => Promise<void>) {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  const emitted = spyOn(getLogger(["labkit", "acp"]), "emit");
  try {
    await body(() => emitted.mock.calls.map((call) => call[0].properties));
    expect(rejections).toEqual([]);
  } finally {
    emitted.mockRestore();
    process.off("unhandledRejection", onRejection);
  }
}

async function expectTurnFailure(
  run: Run,
  scenario: Scenario,
  records: () => Record<string, unknown>[],
) {
  const { first, sessionId } = run;
  expect(first.result).toBeUndefined();
  expect(first.error?.code).toBe(-32000);
  expect(first.error?.message).toStartWith(
    `Agent turn failed in ${scenario.operation === "permission" ? "the permission request for " : ""}tool ${scenario.call.name} (call call1) [${scenario.classification}]: `,
  );
  // The message names the failure; structured causes of thrown non-Error values travel in data.
  expect(JSON.stringify(first.error)).toContain(scenario.detail);
  expect(first.error?.data).toMatchObject({
    classification: scenario.classification,
    operation: {
      kind: scenario.operation ?? "tool",
      sessionId,
      toolName: scenario.call.name,
      callId: "call1",
    },
  });
  expect(run.cardText).toBeDefined();
  // The failed card names the actual cause, never a generic "not granted" placeholder.
  expect(run.cardText).not.toContain("Tool permission not granted or cancelled");
  if (scenario.operation === "permission") expect(run.cardText).toContain(scenario.detail);
  expect(records()).toContainEqual(
    expect.objectContaining({
      event: "acp.prompt.failed",
      method: "session/prompt",
      sessionId,
      outcome: "failed",
      error: expect.objectContaining({ data: first.error?.data }),
    }),
  );
  // The connection and the session both survive: the next prompt completes normally.
  expect(await Promise.race([run.closed.then(() => "closed"), "open"])).toBe("open");
  const next = await run.prompt("Continue");
  expect(next.error).toBeUndefined();
  expect(next.result.stopReason).toBe("end_turn");
}

for (const scenario of scenarios) {
  test(`return-error-and-continue: ${scenario.name} ${scenario.failsTurn ? "fails the turn by core policy" : "is a tool result"} and keeps the connection`, async () => {
    await guarded(async (records) => {
      const run = await exercise(scenario, "return-error-and-continue");
      try {
        if (scenario.event)
          expect(records()).toContainEqual(expect.objectContaining(scenario.event));
        if (scenario.failsTurn) {
          await expectTurnFailure(run, scenario, records);
          return;
        }
        expect(run.first.error).toBeUndefined();
        expect(run.first.result.stopReason).toBe("end_turn");
        expect(run.cardText).toContain('"error"');
        if (scenario.card) expect(run.cardText).toContain(scenario.card);
        const result = run.requests[1]?.messages.find(
          (message) => message.role === "tool" && message.tool_call_id === "call1",
        );
        expect(result?.content).toContain(scenario.detail);
        expect(JSON.parse(String(result?.content))).toMatchObject({
          failure: {
            classification: scenario.classification,
            operation: { kind: "tool", toolName: scenario.call.name, callId: "call1" },
          },
        });
        expect(run.requests).toHaveLength(2);
      } finally {
        await run.cleanup();
      }
    });
  });

  test(`fail-turn: ${scenario.name} returns a structured prompt error and the session continues`, async () => {
    await guarded(async (records) => {
      const run = await exercise(scenario, "fail-turn");
      try {
        if (scenario.event)
          expect(records()).toContainEqual(expect.objectContaining(scenario.event));
        await expectTurnFailure(run, scenario, records);
      } finally {
        await run.cleanup();
      }
    });
  });
}

test("a failed client write leaves the workspace file untouched and never falls back to disk", async () => {
  const scenario = scenarios.find(
    (entry) => entry.name === "a client error on fs/write_text_file",
  )!;
  const run = await exercise(scenario, "return-error-and-continue");
  try {
    expect(run.first.result.stopReason).toBe("end_turn");
    expect(await readFile(join(run.cwd, "README.md"), "utf8")).toBe("disk contents");
  } finally {
    await run.cleanup();
  }
});

test("a terminal whose kill fails is still released exactly once", async () => {
  const scenario = scenarios.find((entry) => entry.name.includes("terminal/kill"))!;
  const run = await exercise(scenario, "return-error-and-continue");
  try {
    expect(run.messages.filter((m) => m.method === "terminal/kill")).toHaveLength(1);
    expect(run.messages.filter((m) => m.method === "terminal/release")).toHaveLength(1);
  } finally {
    await run.cleanup();
  }
});
