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
  const provider = new ChatWebviewProvider({} as any, {} as any, { addListener() {} } as any);
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
