import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, mock, test } from "bun:test";

mock.module("vscode", () => ({
  window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) },
  workspace: { getConfiguration: () => ({ get: (_name: string, fallback: unknown) => fallback }) },
}));

const { TerminalHandler } = await import("./TerminalHandler.ts");

const logger = await import("../utils/Logger.ts");

function fixture() {
  const updates: import("./TerminalHandler.ts").TerminalDisplay[] = [];
  const resources = { terminals: 0, writers: 0 };
  const closePanels: Array<() => void> = [];

  class Emitter {
    event = () => ({ dispose() {} });
    constructor() {
      resources.writers++;
    }
    fire() {}
    dispose() {
      resources.writers--;
    }
  }

  const editor = {
    EventEmitter: Emitter,
    window: {
      createTerminal(options: { pty: { close(): void } }) {
        closePanels.push(() => options.pty.close());
        resources.terminals++;
        return {
          dispose() {
            resources.terminals--;
          },
        };
      },
    },
  };
  const handler = new TerminalHandler(
    editor as any,
    (update) => updates.push(update),
    process.cwd(),
  );
  return { handler, updates, resources, closePanels };
}

async function until(predicate: () => boolean) {
  const deadline = performance.now() + 3000;
  while (!predicate()) {
    if (performance.now() > deadline)
      throw new Error("Terminal did not reach the expected state within 3000 ms");
    await Bun.sleep(5);
  }
}

test("terminal output preserves split UTF-8 and truncates at character boundaries", async () => {
  const f = fixture();
  try {
    const { terminalId } = await f.handler.createTerminal({
      sessionId: "unicode",
      command: process.execPath,
      args: [
        "-e",
        'const b=Buffer.from("🌍");process.stdout.write("prefix");process.stdout.write(b.subarray(0,2));setTimeout(()=>process.stdout.write(b.subarray(2)),15);',
      ],
      outputByteLimit: 4,
    });
    const params = { sessionId: "unicode", terminalId };
    expect(await f.handler.waitForTerminalExit(params)).toMatchObject({ exitCode: 0 });
    expect(await f.handler.terminalOutput(params)).toMatchObject({ output: "🌍", truncated: true });
    await f.handler.releaseTerminal(params);
    expect(f.updates.at(-1)).toMatchObject({
      output: "🌍",
      released: true,
      exitStatus: { exitCode: 0 },
    });
    await expect(f.handler.terminalOutput(params)).rejects.toMatchObject({ code: -32602 });
    expect(f.resources).toEqual({ terminals: 0, writers: 0 });
  } finally {
    await f.handler.dispose();
  }
});

test("arguments remain literal and output is available before exit", async () => {
  const f = fixture();
  try {
    const argument = "literal; $(echo should-not-run) ' quoted";
    const { terminalId } = await f.handler.createTerminal({
      sessionId: "live",
      command: process.execPath,
      args: ["-e", "console.log(process.argv.at(-1));setInterval(()=>{},1000)", argument],
    });
    await until(() => f.updates.some((update) => update.output.includes(argument)));
    const params = { sessionId: "live", terminalId };
    expect(await f.handler.terminalOutput(params)).toMatchObject({
      output: `${argument}\n`,
      truncated: false,
    });
    await expect(
      f.handler.terminalOutput({ ...params, sessionId: "different" }),
    ).rejects.toMatchObject({ code: -32602 });
    await f.handler.killTerminal(params);
    expect(await f.handler.waitForTerminalExit(params)).toMatchObject({ signal: "SIGKILL" });
    expect((await f.handler.terminalOutput(params)).output).toContain(argument);
    await f.handler.releaseTerminal(params);
    expect(f.resources).toEqual({ terminals: 0, writers: 0 });
  } finally {
    await f.handler.dispose();
  }
});

test("spawn failure is a structured failure and closes display resources", async () => {
  const f = fixture();
  try {
    await expect(
      f.handler.createTerminal({ sessionId: "missing", command: "/no/such/labkit-executable" }),
    ).rejects.toMatchObject({
      code: -32603,
      data: {
        sessionId: "missing",
        command: "/no/such/labkit-executable",
        cause: { code: "ENOENT" },
      },
    });
    expect(f.resources).toEqual({ terminals: 0, writers: 0 });
  } finally {
    await f.handler.dispose();
  }
});

test("zero-byte retention and connection disposal terminate running commands without losing final display state", async () => {
  const f = fixture();
  const { terminalId } = await f.handler.createTerminal({
    sessionId: "dispose",
    command: process.execPath,
    args: ["-e", 'console.log("ready");setInterval(()=>{},1000)'],
    outputByteLimit: 0,
  });
  await until(() => f.updates.some((update) => update.truncated));
  const waiting = f.handler.waitForTerminalExit({ sessionId: "dispose", terminalId });
  await f.handler.dispose();
  expect(await waiting).toMatchObject({ signal: "SIGKILL" });
  expect(f.updates.at(-1)).toMatchObject({ output: "", truncated: true, released: true });
  expect(f.resources).toEqual({ terminals: 0, writers: 0 });
  await expect(
    f.handler.createTerminal({ sessionId: "dispose", command: process.execPath }),
  ).rejects.toMatchObject({ code: -32600 });
});

test("terminal diagnostics retain command failure context without recording output or credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "labkit-terminal-"));
  const f = fixture();
  logger.configureDiagnostics(directory, []);
  try {
    const success = await f.handler.createTerminal({
      sessionId: "success",
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
    });
    await f.handler.waitForTerminalExit({ sessionId: "success", ...success });
    await f.handler.releaseTerminal({ sessionId: "success", ...success });
    const successfulLog = await readFile(join(directory, "client.jsonl"), "utf8");
    expect(successfulLog).not.toContain('"level":"warning"');
    expect(successfulLog).not.toContain('"level":"error"');
    await expect(
      f.handler.createTerminal({ sessionId: "missing", command: "/no/such/labkit-executable" }),
    ).rejects.toMatchObject({ data: { cause: { code: "ENOENT" } } });
    const { terminalId } = await f.handler.createTerminal({
      sessionId: "logged",
      command: process.execPath,
      args: ["-e", "console.log(process.env.SESSION_SECRET);process.exit(7)"],
      env: [{ name: "SESSION_SECRET", value: "SECRET_OUTPUT" }],
    });
    await f.handler.waitForTerminalExit({ sessionId: "logged", terminalId });
    await f.handler.releaseTerminal({ sessionId: "logged", terminalId });
    const text = await readFile(join(directory, "client.jsonl"), "utf8");
    const warnings = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((record) => record.level === "warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      event: "vscode.terminal.exited",
      sessionId: "logged",
      terminalId,
      exitCode: 7,
      command: process.execPath,
    });
    expect(warnings[0].message).toContain("code 7");
    expect(text).not.toContain("SECRET_OUTPUT");
    expect(text).toContain("ENOENT");
    const artifact = `.session-artifacts/vscode-terminal/${crypto.randomUUID()}`;
    await mkdir(artifact, { recursive: true });
    await Bun.write(join(artifact, "diagnostics.jsonl"), text);
  } finally {
    await f.handler.dispose();
    logger.disposeChannels();
    await rm(directory, { recursive: true, force: true });
  }
});

test("connection removal closes terminal resources even when shutdown is requested twice", async () => {
  const { ConnectionManager } = await import("../core/ConnectionManager.ts");
  const { SessionUpdateHandler } = await import("./SessionUpdateHandler.ts");
  const f = fixture();
  const manager = new ConnectionManager(new SessionUpdateHandler());
  const { terminalId } = await f.handler.createTerminal({
    sessionId: "disconnect",
    command: process.execPath,
    args: ["-e", 'console.log("ready");setInterval(()=>{},1000)'],
  });
  await until(() => f.updates.some((update) => update.output.includes("ready")));
  (manager as any).connections.set("agent", {
    terminalHandler: f.handler,
    permissions: { dispose() {} },
    connection: { close() {} },
  });
  manager.removeConnection("agent");
  await f.handler.dispose();
  expect(f.resources).toEqual({ terminals: 0, writers: 0 });
  expect(
    f.updates.filter((update) => update.terminalId === terminalId && update.released),
  ).toHaveLength(1);
});

test.skipIf(process.platform === "win32")(
  "killing a Unix terminal also closes inherited streams held by child commands",
  async () => {
    const f = fixture();
    try {
      const { terminalId } = await f.handler.createTerminal({
        sessionId: "tree",
        command: process.execPath,
        args: [
          "-e",
          'const {spawn}=require("node:child_process");spawn(process.execPath,["-e", "console.log(\\\"child ready\\\");setInterval(()=>{},1000)"],{stdio:["ignore","inherit","inherit"]});setInterval(()=>{},1000)',
        ],
      });
      await until(() => f.updates.some((update) => update.output.includes("child ready")));
      await f.handler.killTerminal({ sessionId: "tree", terminalId });
      expect(await f.handler.waitForTerminalExit({ sessionId: "tree", terminalId })).toMatchObject({
        signal: "SIGKILL",
      });
    } finally {
      await f.handler.dispose();
    }
  },
);

test("closing the editor terminal stops its command and leaves the ACP exit status queryable", async () => {
  const f = fixture();
  try {
    const { terminalId } = await f.handler.createTerminal({
      sessionId: "close-panel",
      command: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
    });
    f.closePanels[0]!();
    expect(
      await f.handler.waitForTerminalExit({ sessionId: "close-panel", terminalId }),
    ).toMatchObject({ signal: "SIGKILL" });
  } finally {
    await f.handler.dispose();
  }
});

test("SDK cancellation settles an exit wait without killing or releasing the command", async () => {
  const { agent } = await import("@agentclientprotocol/sdk");
  const { clientApp } = await import("../core/client-app.ts");
  const f = fixture();
  const abort = new AbortController();
  let waiting = false;
  const terminal = await f.handler.createTerminal({
    sessionId: "cancel-wait",
    command: process.execPath,
    args: ["-e", 'console.log("ready");setInterval(()=>{},1000)'],
  });
  await until(() => f.updates.some((update) => update.output.includes("ready")));
  const server = agent().onRequest("session/prompt", async ({ client }) => {
    waiting = true;
    await client.request(
      "terminal/wait_for_exit",
      { sessionId: "cancel-wait", ...terminal },
      { cancellationSignal: abort.signal },
    );
    return { stopReason: "end_turn" };
  });
  const connection = clientApp({ terminals: f.handler } as any).connect(server);
  try {
    const prompt = connection.agent.request("session/prompt", {
      sessionId: "cancel-wait",
      prompt: [],
    });
    const result = prompt.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await until(() => waiting);
    abort.abort();
    expect(await result).toMatchObject({ error: { code: -32800 } });
    const output = await f.handler.terminalOutput({ sessionId: "cancel-wait", ...terminal });
    expect(output.exitStatus).toBeUndefined();
    expect(output.output).toBe("ready\n");
  } finally {
    connection.close();
    await f.handler.dispose();
  }
});
