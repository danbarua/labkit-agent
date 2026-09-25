import { readdirSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decodeRecord } from "@labkit-agent/core/session";
import { SessionIdSchema, type SessionId } from "@labkit-agent/core/types";
import { expect, test } from "@logtape/testing-bun/autoload";

import { workspacePersistence } from "./workspace-persistence.ts";

type Update = Readonly<{
  sessionUpdate?: string;
  status?: string;
  content?: Readonly<{ text?: string }>;
}>;

type Rpc = Readonly<{
  id?: number;
  method?: string;
  params?: Readonly<{ sessionId?: string; update?: Update }>;
  result?: Readonly<Record<string, unknown>>;
  error?: Readonly<{ code: number; message: string }>;
}>;

type LogLine = Readonly<{ level: string; event: string; [field: string]: unknown }>;

type ChatRequest = Readonly<{
  messages: readonly Readonly<{
    role: string;
    tool_call_id?: string;
    tool_calls?: readonly Readonly<{ id: string }>[];
  }>[];
}>;

type Fixture = Readonly<{
  directory: string;
  cwd: string;
  config: string;
  /** Every provider request body, one per line. */
  requests: string;
  logs: string;
}>;

const cli = new URL(
  process.env.LABKIT_ACP_TEST_BUILT ? "./dist/cli.js" : "./cli.ts",
  import.meta.url,
).pathname;

/**
 * A launcher config with durable workspace storage and a scripted OpenAI Chat stream. The last user
 * message chooses the script: STREAM_HANG streams one delta and then waits for abort; TOOL_HANG
 * calls the `hang` tool, which waits for abort; anything else streams a complete answer. Every
 * request body is appended to requests.jsonl so the test can read what the provider was sent.
 */
async function fixture(): Promise<Fixture> {
  const directory = realpathSync(await mkdtemp(join(tmpdir(), "labkit-acp-reload-")));
  const cwd = join(directory, "workspace");
  await Bun.write(join(cwd, "README.md"), "workspace\n");
  const config = join(directory, "config.ts");
  const requests = join(directory, "requests.jsonl");
  const module = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
  await Bun.write(
    config,
    `import { appendFileSync } from "node:fs";
import { z } from ${JSON.stringify(Bun.resolveSync("zod", import.meta.dir))};
import { defineTool } from ${module("../core/index.ts")};
import { openaiChatV2 } from ${module("../core/providers/index.ts")};
import { workspacePersistence } from ${module("./workspace-persistence.ts")};

const encoder = new TextEncoder();
const frame = (delta: unknown, finish: string | null = null) =>
  "data: " + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] }) + "\\n\\n";
const stream = (start: (controller: ReadableStreamDefaultController<Uint8Array>) => void) =>
  new Response(new ReadableStream<Uint8Array>({ start }), {
    headers: { "content-type": "text/event-stream" },
  });
const complete = (frames: readonly string[]) =>
  stream((controller) => {
    controller.enqueue(encoder.encode(frames.join("") + "data: [DONE]\\n\\n"));
    controller.close();
  });
const untilAborted = (signal: AbortSignal | null | undefined) =>
  new Promise<never>((_, reject) =>
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true }),
  );

const fetch = (async (_url: unknown, init?: RequestInit) => {
  const body = String(init?.body);
  appendFileSync(${JSON.stringify(requests)}, body + "\\n");
  const messages: { role: string }[] = JSON.parse(body).messages;
  const last = JSON.stringify(messages.at(-1));
  if (last.includes("STREAM_HANG"))
    return stream((controller) => {
      controller.enqueue(encoder.encode(frame({ role: "assistant", content: "Partial answer" })));
      untilAborted(init?.signal).catch((reason) => controller.error(reason));
    });
  if (last.includes("TOOL_HANG") && messages.at(-1)?.role === "user")
    return complete([
      frame({ role: "assistant", content: "Waiting" }),
      frame({
        tool_calls: [
          { index: 0, id: "hang-1", type: "function", function: { name: "hang", arguments: "{}" } },
        ],
      }),
      frame({}, "tool_calls"),
    ]);
  return complete([frame({ role: "assistant", content: "Resumed answer" }), frame({}, "stop")]);
}) as typeof globalThis.fetch;

const hang = defineTool({
  input: z.object({}),
  kind: "read",
  run: (_input, signal) => untilAborted(signal),
});

export default {
  loadSession: true,
  sessionOptions: () => ({
    persistence: workspacePersistence(${JSON.stringify(cwd)}),
    configuration: {
      agent: "a",
      agents: new Map([["a", { model: "m", tools: ["hang"], successors: [] }]]),
      steps: 4,
      policy: { provider: openaiChatV2.id, stream: true, maxOutputTokens: 1024, permissions: "off" },
    },
    bindings: {
      tools: new Map([["hang", hang]]),
      providers: new Map([
        [openaiChatV2.id, { profile: openaiChatV2, transport: { baseUrl: "https://test.invalid", fetch } }],
      ]),
    },
  }),
};
`,
  );
  return { directory, cwd, config, requests, logs: join(directory, "logs") };
}

/** The provider requests the launchers sent, oldest first. */
async function sentRequests(f: Fixture): Promise<ChatRequest[]> {
  const text = await Bun.file(f.requests).text();
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as ChatRequest);
}

/** Journal records as `kind`, or the wire event type for event records, in revision order. */
async function journal(f: Fixture, sessionId: SessionId): Promise<string[]> {
  const loaded = await workspacePersistence(f.cwd).load(sessionId, new AbortController().signal);
  if (loaded.kind !== "loaded") throw new Error(`Session ${sessionId} is ${loaded.kind}`);
  return loaded.batches.flatMap((batch) =>
    batch.records.map((raw) => {
      const body = decodeRecord(raw).body;
      if (body.kind !== "event") return body.kind;
      return body.event.type === "child" ? body.event.event.type : body.event.type;
    }),
  );
}

/** One launcher process speaking ACP over stdio, as the editor runs it. */
class Launcher {
  readonly child;
  readonly messages: Rpc[] = [];
  readonly #stderr: Promise<string>;
  readonly #reading: Promise<void>;
  readonly #logs: string;
  #id = 0;

  constructor(f: Fixture) {
    this.#logs = f.logs;
    const child = Bun.spawn([process.execPath, cli, "--config", f.config], {
      cwd: f.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, LABKIT_ACP_LOG_DIR: f.logs },
    });
    this.child = child;
    this.#stderr = new Response(child.stderr).text();
    this.#reading = (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of child.stdout) {
        buffer += decoder.decode(chunk, { stream: true });
        for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
          this.messages.push(JSON.parse(buffer.slice(0, newline)) as Rpc);
          buffer = buffer.slice(newline + 1);
        }
      }
    })();
  }

  /** Poll for output of another process; fail fast if it exits and bound the wait. */
  async until(predicate: () => boolean, what: string, ms = 10_000) {
    const deadline = performance.now() + ms;
    while (!predicate()) {
      if (this.child.exitCode !== null)
        throw new Error(
          `Launcher exited (${this.child.exitCode}) before ${what}: ${await this.#stderr}`,
        );
      if (performance.now() >= deadline)
        throw new Error(`No ${what} within ${ms} ms; received ${JSON.stringify(this.messages)}`);
      await Bun.sleep(10);
    }
  }

  send(method: string, params: unknown) {
    const id = ++this.#id;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return id;
  }

  async request(method: string, params: unknown) {
    const id = this.send(method, params);
    await this.until(() => this.messages.some((m) => m.id === id), `response to ${method}`);
    return this.messages.find((m) => m.id === id)!;
  }

  updates(from = 0): Update[] {
    return this.messages
      .slice(from)
      .flatMap((m) => (m.method === "session/update" && m.params?.update ? [m.params.update] : []));
  }

  async initialize() {
    const response = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    expect(response.result).toMatchObject({ protocolVersion: 1 });
  }

  /** This launch's diagnostics file, one JSON record per line. */
  async log(): Promise<LogLine[]> {
    const prefix = `acp-${this.child.pid}-`;
    const name = readdirSync(this.#logs).find((file) => file.startsWith(prefix));
    if (!name) throw new Error(`No diagnostics file for launcher ${this.child.pid}`);
    const text = await Bun.file(join(this.#logs, name)).text();
    return text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as LogLine);
  }

  /** Disconnect as an editor does: close stdin and wait for the launcher to exit. */
  async disconnect() {
    this.child.stdin.end();
    const code = await this.child.exited;
    await this.#reading;
    return code;
  }
}

const streaming = (update: Update) => update.content?.text === "Partial answer";

const scenarios: readonly (readonly [
  name: string,
  prompt: string,
  started: (update: Update) => boolean,
  interruption: "disconnect" | "kill",
])[] = [
  [
    "closing stdin while the completion streams",
    "Interrupted: STREAM_HANG",
    streaming,
    "disconnect",
  ],
  ["SIGKILL while the completion streams", "Interrupted: STREAM_HANG", streaming, "kill"],
  [
    "SIGKILL while a tool runs",
    "Interrupted: TOOL_HANG",
    (update) => update.sessionUpdate === "tool_call_update" && update.status === "in_progress",
    "kill",
  ],
];

for (const [name, prompt, started, interruption] of scenarios)
  test(`a session interrupted by ${name} reloads in a new launcher and takes a new prompt`, async () => {
    const f = await fixture();
    const first = new Launcher(f);
    let second: Launcher | undefined;
    try {
      await first.initialize();
      const opened = await first.request("session/new", { cwd: f.cwd, mcpServers: [] });
      const sessionId = SessionIdSchema.parse(opened.result?.sessionId);
      first.send("session/prompt", { sessionId, prompt: [{ type: "text", text: prompt }] });
      await first.until(() => first.updates().some(started), "the interrupted work to start");

      let before: string[];
      if (interruption === "disconnect") {
        expect(await first.disconnect()).toBe(0);
        const events = (await first.log()).map((line) => line.event);
        expect(events).toContain("acp.connection.closing");
        expect(events).toContain("session.stopped");
        before = await journal(f, sessionId);
        expect(before.slice(before.indexOf("abort"))).toEqual(["abort", "terminal"]);
      } else {
        first.child.kill("SIGKILL");
        expect(await first.child.exited).not.toBe(0);
        before = await journal(f, sessionId);
        expect(before).toContain("user");
        expect(before).not.toContain("abort");
        expect(before).not.toContain("terminal");
      }

      second = new Launcher(f);
      await second.initialize();
      const replayFrom = second.messages.length;
      const loaded = await second.request("session/load", {
        sessionId,
        cwd: f.cwd,
        mcpServers: [],
      });
      expect(loaded.error).toBeUndefined();
      const replayed = second.updates(replayFrom);
      expect(replayed).toContainEqual(
        expect.objectContaining({
          sessionUpdate: "user_message_chunk",
          content: expect.objectContaining({ text: prompt }),
        }),
      );
      // A partial stream is never admitted to history, so reload does not replay it.
      expect(JSON.stringify(replayed)).not.toContain("Partial answer");
      // A cleanly aborted turn loads as written; a killed one is recovered exactly once.
      expect(await journal(f, sessionId)).toEqual(
        interruption === "disconnect" ? before : [...before, "recovery", "terminal"],
      );

      const next = await second.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "Continue after reload" }],
      });
      expect(next.result).toEqual({ stopReason: "end_turn" });
      const sent = (await sentRequests(f)).at(-1)!.messages;
      const users = JSON.stringify(sent.filter((message) => message.role === "user"));
      expect(users).toContain(prompt);
      expect(users).toContain("Continue after reload");
      // A provider rejects a request that replays a tool call without its result.
      const answered = new Set(sent.map((message) => message.tool_call_id));
      for (const call of sent.flatMap((message) => message.tool_calls ?? []))
        expect(answered).toContain(call.id);

      expect(await second.disconnect()).toBe(0);
      const log = await second.log();
      const events = log.map((line) => line.event);
      expect(events).toContain("session.restored");
      if (interruption === "kill") expect(events).toContain("session.recovering");
      else expect(events).not.toContain("session.recovering");
      expect(log.filter((line) => line.level === "error")).toEqual([]);
    } finally {
      for (const launched of [first, second]) {
        launched?.child.kill("SIGKILL");
        await launched?.child.exited;
      }
      await rm(f.directory, { recursive: true, force: true });
    }
  }, 30_000);
