import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, mock, test } from "bun:test";

import { Window } from "happy-dom";

import { fileDiagnostics } from "../utils/file-diagnostics.ts";
import { renderToolContent } from "./tool-content.ts";

mock.module("vscode", () => ({
  window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) },
  workspace: { getConfiguration: () => ({ get: (_name: string, fallback: unknown) => fallback }) },
}));

const { ChatWebviewProvider } = await import("./ChatWebviewProvider.ts");

function view(saved?: unknown) {
  const window = new Window({
    settings: {
      // Execute only our generated script; never load remote scripts in this harness.
      enableJavaScriptEvaluation: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
    },
  });
  let state = saved;
  const posted: unknown[] = [];
  Object.assign(window, {
    acquireVsCodeApi: () => ({
      getState: () => state,
      setState: (next: unknown) => {
        state = structuredClone(next);
      },
      postMessage: (message: unknown) => posted.push(message),
    }),
  });
  const provider = new ChatWebviewProvider(
    {} as any,
    {} as any,
    { addListener() {}, addTerminalListener() {} } as any,
  );
  const html = (provider as any).getHtmlContent({ cspSource: "vscode-webview:" });
  window.document.write(html);

  const send = (data: unknown) =>
    window.dispatchEvent(new window.MessageEvent("message", { data }));

  return { window, send, state: () => state, posted };
}

test("the actual webview script renders and restores tool diffs and preserves status on content-only updates", async () => {
  const v = view();
  try {
    expect(v.posted).toContainEqual({ type: "ready" });
    v.send({
      type: "sessionUpdate",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "write-1",
        title: "Write report",
        status: "in_progress",
      },
    });
    const content = [
      {
        type: "diff",
        path: "/workspace/report.txt",
        oldText: "before <script>bad()</script>",
        newText: "after",
      },
    ];
    v.send({
      type: "sessionUpdate",
      update: { sessionUpdate: "tool_call_update", toolCallId: "write-1", content },
    });
    const card = v.window.document.getElementById("tc-write-1")!;
    expect(card.querySelector(".tc-icon")?.className).toContain("in_progress");
    expect(card.querySelector(".acp-diff-before")?.textContent).toBe(
      "before <script>bad()</script>",
    );
    expect(card.querySelector(".acp-diff-after")?.textContent).toBe("after");
    expect(card.querySelector("script")).toBeNull();
    v.send({
      type: "sessionUpdate",
      update: { sessionUpdate: "tool_call_update", toolCallId: "write-1", status: "completed" },
    });
    expect(card.querySelector(".acp-diff-after")?.textContent).toBe("after");
    const restored = view(v.state());
    try {
      expect(restored.window.document.querySelector(".acp-diff-after")?.textContent).toBe("after");
      expect(restored.posted.some((message: any) => message.type === "sendPrompt")).toBe(false);
    } finally {
      await restored.window.happyDOM.close();
    }
  } finally {
    await v.window.happyDOM.close();
  }
});

test("the webview displays usage and clears it when switching sessions", async () => {
  const v = view();
  try {
    v.send({
      type: "state",
      session: { sessionId: "one", agentName: "Labkit", cwd: "/workspace" },
    });
    v.send({
      type: "sessionUpdate",
      update: {
        sessionUpdate: "usage_update",
        used: 1200,
        size: 32000,
        cost: { amount: 0.25, currency: "EUR" },
      },
    });
    expect(v.window.document.getElementById("sessionUsage")?.textContent).toBe(
      "Context: 1200 / 32000 · Session cost: 0.25 EUR",
    );
    const restored = view(v.state());
    try {
      expect(restored.window.document.getElementById("sessionUsage")?.textContent).toBe(
        "Context: 1200 / 32000 · Session cost: 0.25 EUR",
      );
    } finally {
      await restored.window.happyDOM.close();
    }
    v.send({
      type: "state",
      session: { sessionId: "two", agentName: "Labkit", cwd: "/workspace" },
    });
    expect(v.window.document.getElementById("sessionUsage")?.textContent).toBe("");
  } finally {
    await v.window.happyDOM.close();
  }
});

test("rich tool media and resource links cannot inject markup or script URLs", () => {
  const html = renderToolContent([
    { type: "content", content: { type: "image", mimeType: "image/png", data: "AA==" } },
    { type: "content", content: { type: "audio", mimeType: "audio/wav", data: "AA==" } },
    {
      type: "content",
      content: { type: "resource_link", name: "<img onerror=bad()>", uri: "javascript:bad()" },
    },
    {
      type: "content",
      content: {
        type: "resource",
        resource: { uri: "file:///report", text: "<svg onload=bad()>" },
      },
    },
  ]);
  expect(html).toContain('src="data:image/png;base64,AA=="');
  expect(html).toContain("<audio controls");
  expect(html).not.toContain('href="javascript:');
  expect(html).not.toContain("<svg");
  expect(html).toContain("&lt;svg");
  const standalone = new Function(`return (${renderToolContent.toString()});`)();
  expect(standalone([{ type: "diff", path: "/new", oldText: null, newText: "new" }])).toContain(
    "New file",
  );
});

test("client diagnostics retain failure causes, redact credentials and bound retained files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "labkit-client-log-"));
  try {
    const log = fileDiagnostics(directory, ["PRIVATE_CLIENT_KEY"], 512);
    for (let i = 0; i < 30; i++) log.write("info", "test.progress", { i, detail: "x".repeat(100) });
    log.write("error", "test.failed", {
      sessionId: "session-1",
      toolCallId: "call-1",
      error: new Error("Read failed PRIVATE_CLIENT_KEY", {
        cause: { code: "ENOENT", path: "/workspace/missing" },
      }),
    });
    log.close();
    const files = await readdir(directory);
    expect(files.length).toBeLessThanOrEqual(5);
    const text = await readFile(join(directory, "client.jsonl"), "utf8");
    expect(text).not.toContain("PRIVATE_CLIENT_KEY");
    expect(text).toContain("ENOENT");
    expect(text).toContain("/workspace/missing");
    expect(text).toContain("session-1");
    const artifact = `.session-artifacts/vscode-client/${crypto.randomUUID()}`;
    await mkdir(artifact, { recursive: true });
    await Bun.write(join(artifact, "diagnostics.jsonl"), text);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime protocol diagnostics explain failed tools and preserve response causes", async () => {
  const logger = await import("../utils/Logger.ts");
  const directory = await mkdtemp(join(tmpdir(), "labkit-client-protocol-"));
  try {
    logger.configureDiagnostics(directory, ["PRIVATE_CLIENT_KEY"]);
    logger.registerEnvironmentSecrets({ PROVIDER_API_KEY: "NEW_CLIENT_KEY" });
    logger.logTraffic("recv", {
      jsonrpc: "2.0",
      id: 1,
      result: { sessionId: "session-1" },
    });
    const success = await readFile(join(directory, "client.jsonl"), "utf8");
    expect(success).not.toContain('"level":"warning"');
    expect(success).not.toContain('"level":"error"');
    logger.logTraffic("recv", {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-1",
          title: "Read /workspace/missing",
          status: "failed",
          rawOutput: { code: "ENOENT", path: "/workspace/missing", message: "File does not exist" },
        },
      },
    });
    logger.logError(
      "Agent connection failed",
      new Error("PRIVATE_CLIENT_KEY NEW_CLIENT_KEY", {
        cause: { code: "ECONNRESET" },
      }),
    );
    logger.disposeChannels();
    const text = await readFile(join(directory, "client.jsonl"), "utf8");
    const records = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const warnings = records.filter((record) => record.level === "warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      event: "vscode.protocol.message",
      sessionId: "session-1",
      toolCallId: "call-1",
      title: "Read /workspace/missing",
      error: { code: "ENOENT", path: "/workspace/missing" },
    });
    expect(text).toContain("ECONNRESET");
    expect(text).not.toContain("NEW_CLIENT_KEY");
    expect(text).not.toContain("PRIVATE_CLIENT_KEY");
    const artifact = `.session-artifacts/vscode-client/${crypto.randomUUID()}`;
    await mkdir(artifact, { recursive: true });
    await Bun.write(join(artifact, "diagnostics.jsonl"), text);
  } finally {
    logger.disposeChannels();
    await rm(directory, { recursive: true, force: true });
  }
});

test("embedded terminals show live output and retain final released output after webview restoration", async () => {
  const v = view();
  try {
    v.send({
      type: "state",
      session: { sessionId: "terminal-session", agentName: "Labkit", cwd: "/workspace" },
    });
    v.send({
      type: "terminalOutput",
      update: {
        sessionId: "terminal-session",
        terminalId: "terminal-1",
        output: "early output",
        truncated: false,
      },
    });
    v.send({
      type: "sessionUpdate",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "exec-1",
        title: "Build",
        status: "in_progress",
        content: [{ type: "terminal", terminalId: "terminal-1" }],
      },
    });
    expect(v.window.document.querySelector(".acp-terminal pre")?.textContent).toBe("early output");
    v.send({
      type: "terminalOutput",
      update: {
        sessionId: "terminal-session",
        terminalId: "terminal-1",
        output: "<script>final</script>",
        truncated: true,
        exitStatus: { exitCode: 7 },
        released: true,
      },
    });
    expect(v.window.document.querySelector(".acp-terminal pre")?.textContent).toBe(
      "<script>final</script>",
    );
    expect(v.window.document.querySelector(".acp-terminal summary")?.textContent).toContain(
      "Exited: 7 (released)",
    );
    expect(v.window.document.querySelector(".acp-terminal script")).toBeNull();
    const restored = view(v.state());
    try {
      expect(restored.window.document.querySelector(".acp-terminal pre")?.textContent).toBe(
        "<script>final</script>",
      );
    } finally {
      await restored.window.happyDOM.close();
    }
  } finally {
    await v.window.happyDOM.close();
  }
});

test("tool cards retain partial metadata, raw JSON values and navigable locations through restoration", async () => {
  const v = view();
  try {
    v.send({
      type: "sessionUpdate",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "metadata",
        title: "Inspect file",
        name: "read_file",
        kind: "read",
        status: "in_progress",
        rawInput: { path: '/workspace/<report>".txt' },
        rawOutput: false,
        locations: [{ path: '/workspace/<report>".txt', line: 3 }],
        _meta: { source: "scripted" },
        content: [{ type: "content", content: { type: "text", text: "first output" } }],
      },
    });
    v.send({
      type: "sessionUpdate",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "metadata",
        name: null,
        rawInput: null,
        rawOutput: null,
        status: "failed",
      },
    });
    const card = v.window.document.getElementById("tc-metadata")!;
    expect(card.querySelector(".acp-tool-name")?.textContent).toBe("read_file");
    expect(card.querySelector(".acp-tool-kind")?.textContent).toBe("read");
    expect(card.querySelector(".acp-text")?.textContent).toBe("first output");
    const raw = [...card.querySelectorAll(".acp-tool-raw pre")].map(
      (element) => element.textContent,
    );
    expect(raw).toEqual([
      JSON.stringify({ path: '/workspace/<report>".txt' }, null, 2),
      "false",
      JSON.stringify({ source: "scripted" }, null, 2),
    ]);
    const location = card.querySelector(".acp-tool-location")!;
    expect(location.textContent).toBe('/workspace/<report>".txt:3');
    location.dispatchEvent(new v.window.MouseEvent("click", { bubbles: true }));
    expect(v.posted).toContainEqual({ type: "openToolLocation", toolCallId: "metadata", index: 0 });
    const restored = view(v.state());
    try {
      expect(restored.window.document.querySelector(".acp-tool-name")?.textContent).toBe(
        "read_file",
      );
      expect(restored.window.document.querySelector(".acp-tool-location")?.textContent).toBe(
        '/workspace/<report>".txt:3',
      );
    } finally {
      await restored.window.happyDOM.close();
    }
    v.send({
      type: "sessionUpdate",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "metadata",
        content: [],
        locations: [],
        rawOutput: 0,
      },
    });
    expect(card.querySelector(".acp-text")).toBeNull();
    expect(card.querySelector(".acp-tool-location")).toBeNull();
    expect(
      [...card.querySelectorAll(".acp-tool-raw pre")].map((element) => element.textContent),
    ).toContain("0");
  } finally {
    await v.window.happyDOM.close();
  }
});

test("updates without an initial tool notification still render and opaque IDs cannot overwrite the tool map prototype", async () => {
  const v = view();
  try {
    v.send({
      type: "sessionUpdate",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "__proto__",
        title: "Late initial state",
        status: "failed",
        rawOutput: ["ENOENT", "/missing"],
      },
    });
    expect(v.window.document.getElementById("tc-__proto__")?.textContent).toContain("ENOENT");
    v.send({
      type: "sessionUpdate",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "__proto__",
        title: "Corrected title",
        status: "failed",
      },
    });
    expect(v.window.document.querySelectorAll('[id="tc-__proto__"]')).toHaveLength(1);
    expect(v.window.document.getElementById("tc-__proto__")?.textContent).toContain(
      "Corrected title",
    );
    expect(v.window.document.getElementById("tc-__proto__")?.textContent).toContain("ENOENT");
  } finally {
    await v.window.happyDOM.close();
  }
});

test("location navigation uses the active session's reported path and rejects substituted IDs and indexes", async () => {
  const { SessionUpdateHandler } = await import("../handlers/SessionUpdateHandler.ts");
  const updates = new SessionUpdateHandler();
  updates.handleUpdate({
    sessionId: "s",
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "call",
      title: "Read report",
      locations: [{ path: "/workspace/report.txt", line: 3 }],
    },
  });
  const opened: any[] = [];
  let active = "s";
  const editor = {
    Uri: { file: (path: string) => ({ fsPath: path }) },
    Range: class {
      constructor(
        readonly startLine: number,
        readonly startCharacter: number,
        readonly endLine: number,
        readonly endCharacter: number,
      ) {}
    },
    workspace: { openTextDocument: async (uri: unknown) => ({ uri, lineCount: 8 }) },
    window: {
      showTextDocument: async (document: unknown, options: unknown) => {
        opened.push({ document, options });
      },
    },
  };
  const provider = new ChatWebviewProvider(
    {} as any,
    { getActiveSessionId: () => active } as any,
    updates,
    editor as any,
  );
  const directory = await mkdtemp(join(tmpdir(), "labkit-tool-location-"));
  const logger = await import("../utils/Logger.ts");
  logger.configureDiagnostics(directory, []);
  try {
    await (provider as any).openToolLocation("call", 0);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      document: { uri: { fsPath: "/workspace/report.txt" } },
      options: { selection: { startLine: 2, endLine: 2 } },
    });
    const success = await readFile(join(directory, "client.jsonl"), "utf8");
    expect(success).toContain("vscode.tool.location_opened");
    expect(success).not.toContain('"level":"warning"');
    await (provider as any).openToolLocation("call", -1);
    await (provider as any).openToolLocation("/substituted/path", 0);
    active = "different-session";
    await (provider as any).openToolLocation("call", 0);
    expect(opened).toHaveLength(1);
    const text = await readFile(join(directory, "client.jsonl"), "utf8");
    const rejected = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((record) => record.level === "warning");
    expect(rejected).toHaveLength(3);
    expect(rejected[2]).toMatchObject({
      event: "vscode.tool.location_rejected",
      sessionId: "different-session",
      toolCallId: "call",
      index: 0,
    });
    const artifact = `.session-artifacts/vscode-tool-location/${crypto.randomUUID()}`;
    await mkdir(artifact, { recursive: true });
    await Bun.write(join(artifact, "diagnostics.jsonl"), text);
  } finally {
    provider.dispose();
    updates.dispose();
    logger.disposeChannels();
    await rm(directory, { recursive: true, force: true });
  }
});
