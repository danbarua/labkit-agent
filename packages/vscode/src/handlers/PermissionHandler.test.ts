import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, mock, test } from "bun:test";

import { agent, type RequestPermissionRequest } from "@agentclientprotocol/sdk";

mock.module("vscode", () => ({
  window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) },
  workspace: { getConfiguration: () => ({ get: (_name: string, fallback: unknown) => fallback }) },
}));

const { PermissionHandler } = await import("./PermissionHandler.ts");

const { clientApp } = await import("../core/client-app.ts");

const { SessionManager } = await import("../core/SessionManager.ts");

const logger = await import("../utils/Logger.ts");

function request(sessionId = "s", callId = "tool-1"): RequestPermissionRequest {
  return {
    sessionId,
    toolCall: { toolCallId: callId, title: "Read /workspace/report.txt" },
    options: [
      { kind: "allow_once", optionId: "once", name: "Allow once" },
      { kind: "allow_always", optionId: "always", name: "Allow for this session" },
      { kind: "reject_once", optionId: "reject", name: "Reject" },
      { kind: "reject_always", optionId: "never", name: "Reject for this session" },
    ],
  };
}

function fixture() {
  const pickers: any[] = [];
  const settings = { autoApprove: "none", throwOnShow: false };
  const editor = {
    workspace: { getConfiguration: () => ({ get: () => settings.autoApprove }) },
    window: {
      createQuickPick() {
        const accepts = new Set<() => void>();
        const hides = new Set<() => void>();
        const picker = {
          items: [] as any[],
          selectedItems: [] as any[],
          disposed: false,
          shown: false,
          onDidAccept(listener: () => void) {
            accepts.add(listener);
            return { dispose: () => accepts.delete(listener) };
          },
          onDidHide(listener: () => void) {
            hides.add(listener);
            return { dispose: () => hides.delete(listener) };
          },
          show() {
            if (settings.throwOnShow) throw new Error("Editor picker unavailable");
            this.shown = true;
          },
          hide() {
            this.shown = false;
            for (const listener of hides) listener();
          },
          dispose() {
            this.disposed = true;
          },
          select(index: number) {
            this.selectedItems = [this.items[index]];
            for (const listener of accepts) listener();
          },
        };
        pickers.push(picker);
        return picker;
      },
    },
  };
  return { handler: new PermissionHandler(editor as any), pickers, settings };
}

async function until(predicate: () => boolean) {
  const deadline = performance.now() + 2000;
  while (!predicate()) {
    if (performance.now() > deadline)
      throw new Error("Permission test did not reach expected state");
    await Bun.sleep(1);
  }
}

test("all advertised permission choices return their exact IDs without inventing a grant scope", async () => {
  const f = fixture();
  for (let i = 0; i < 4; i++) {
    const result = f.handler.requestPermission(request());
    f.pickers[i].select(i);
    expect(await result).toEqual({
      outcome: { outcome: "selected", optionId: request().options[i]!.optionId },
    });
    expect(f.pickers[i].disposed).toBe(true);
  }
  f.handler.dispose();
});

test("turn cancellation settles visible and queued permissions and rejects late requests until the next explicit turn", async () => {
  const f = fixture();
  const first = f.handler.requestPermission(request("s", "first"));
  const second = f.handler.requestPermission(request("s", "second"));
  const unrelated = f.handler.requestPermission(request("other"));
  expect(f.pickers).toHaveLength(1);
  f.handler.cancelSession("s");
  expect(await first).toEqual({ outcome: { outcome: "cancelled" } });
  expect(await second).toEqual({ outcome: { outcome: "cancelled" } });
  expect(await f.handler.requestPermission(request())).toEqual({
    outcome: { outcome: "cancelled" },
  });
  await until(() => f.pickers.length === 2);
  f.pickers[1].select(0);
  expect(await unrelated).toEqual({ outcome: { outcome: "selected", optionId: "once" } });
  f.handler.beginTurn("s");
  const next = f.handler.requestPermission(request());
  f.pickers[2].select(0);
  expect(await next).toEqual({ outcome: { outcome: "selected", optionId: "once" } });
  f.handler.dispose();
});

test("request abort, dismissal and connection closure dispose prompts and never authorize execution", async () => {
  const f = fixture();
  const abort = new AbortController();
  const first = f.handler.requestPermission(request(), abort.signal);
  abort.abort();
  expect(await first).toEqual({ outcome: { outcome: "cancelled" } });
  const second = f.handler.requestPermission(request());
  f.pickers[1].hide();
  expect(await second).toEqual({ outcome: { outcome: "cancelled" } });
  const third = f.handler.requestPermission(request());
  f.handler.dispose();
  expect(await third).toEqual({ outcome: { outcome: "cancelled" } });
  expect(await f.handler.requestPermission(request())).toEqual({
    outcome: { outcome: "cancelled" },
  });
  expect(f.pickers.every((picker) => picker.disposed)).toBe(true);
});

test("configured auto approval cannot override a cancelled turn and does not convert reject options into approval", async () => {
  const f = fixture();
  f.settings.autoApprove = "allowAll";
  expect(await f.handler.requestPermission(request())).toEqual({
    outcome: { outcome: "selected", optionId: "once" },
  });
  f.handler.cancelSession("s");
  expect(await f.handler.requestPermission(request())).toEqual({
    outcome: { outcome: "cancelled" },
  });
  f.handler.beginTurn("s");
  const params = request();
  params.options = params.options.filter((option) => option.kind.startsWith("reject"));
  const result = f.handler.requestPermission(params);
  f.pickers[0].select(0);
  expect(await result).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
  f.handler.dispose();
});

test("the real SDK delivers cancel_request to the permission UI and receives a cancelled outcome", async () => {
  const f = fixture();
  const abort = new AbortController();
  let outcome: unknown;
  const server = agent().onRequest("session/prompt", async ({ client }) => {
    outcome = await client.request("session/request_permission", request(), {
      cancellationSignal: abort.signal,
    });
    return { stopReason: "cancelled" };
  });
  const connection = clientApp({ permissions: f.handler } as any).connect(server);
  try {
    const prompt = connection.agent.request("session/prompt", {
      sessionId: "s",
      prompt: [{ type: "text", text: "Read report" }],
    });
    await until(() => f.pickers.length === 1);
    abort.abort();
    expect(await prompt).toEqual({ stopReason: "cancelled" });
    expect(outcome).toEqual({ outcome: { outcome: "cancelled" } });
    expect(f.pickers[0].disposed).toBe(true);
  } finally {
    f.handler.dispose();
    connection.close();
  }
});

test("SessionManager stop dismisses permission before sending session/cancel and a new prompt can ask again", async () => {
  const directory = await mkdtemp(join(tmpdir(), "labkit-turn-cancel-"));
  logger.configureDiagnostics(directory, []);
  const f = fixture();
  let cancelled = false;
  const server = agent()
    .onRequest("session/prompt", async ({ client }) => {
      const response = await client.request("session/request_permission", request());
      return { stopReason: response.outcome.outcome === "cancelled" ? "cancelled" : "end_turn" };
    })
    .onNotification("session/cancel", () => {
      cancelled = true;
    });
  const connection = clientApp({ permissions: f.handler } as any).connect(server);
  const manager = new SessionManager(
    {} as any,
    { getConnection: () => ({ connection, permissions: f.handler }) } as any,
    {} as any,
  );
  (manager as any).sessions.set("s", { agentId: "agent" });
  try {
    const first = manager.sendPrompt("s", "Read report");
    await until(() => f.pickers.length === 1);
    await expect(manager.sendPrompt("s", "overlapping request")).rejects.toThrow(
      "already has an active prompt",
    );
    expect(f.pickers[0].disposed).toBe(false);
    await manager.cancelTurn("s");
    expect(await first).toEqual({ stopReason: "cancelled" });
    await until(() => cancelled);
    expect(f.pickers[0].disposed).toBe(true);
    const second = manager.sendPrompt("s", "Try again");
    await until(() => f.pickers.length === 2);
    f.pickers[1].select(0);
    expect(await second).toEqual({ stopReason: "end_turn" });
    const text = await readFile(join(directory, "client.jsonl"), "utf8");
    const records = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.find((record) => record.event === "vscode.prompt.rejected")).toMatchObject({
      level: "warning",
      sessionId: "s",
      reason: "active_prompt",
    });
    expect(records.find((record) => record.event === "vscode.permission.cancelled")).toMatchObject({
      level: "info",
      sessionId: "s",
      toolCallId: "tool-1",
      reason: "turn_cancelled",
    });
    const artifact = `.session-artifacts/vscode-permission/${crypto.randomUUID()}`;
    await mkdir(artifact, { recursive: true });
    await Bun.write(join(artifact, "diagnostics.jsonl"), text);
  } finally {
    f.handler.dispose();
    connection.close();
    logger.disposeChannels();
    await rm(directory, { recursive: true, force: true });
  }
});

test("permission logs identify refusal consequences and preserve editor failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "labkit-permissions-"));
  const f = fixture();
  logger.configureDiagnostics(directory, []);
  try {
    const allowed = f.handler.requestPermission(request());
    f.pickers[0].select(0);
    await allowed;
    const success = await readFile(join(directory, "client.jsonl"), "utf8");
    expect(success).not.toContain('"level":"warning"');
    expect(success).not.toContain('"level":"error"');
    const denied = f.handler.requestPermission(request(), undefined, "permission-rpc");
    f.pickers[1].select(2);
    await denied;
    f.settings.throwOnShow = true;
    await expect(f.handler.requestPermission(request())).rejects.toMatchObject({
      data: { cause: { message: "Editor picker unavailable" } },
    });
    const text = await readFile(join(directory, "client.jsonl"), "utf8");
    const records = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.find((record) => record.level === "warning")).toMatchObject({
      event: "vscode.permission.selected",
      sessionId: "s",
      toolCallId: "tool-1",
      kind: "reject_once",
      optionId: "reject",
      rpcRequestId: "permission-rpc",
    });
    expect(text).toContain("does not authorize execution");
    expect(text).toContain("Editor picker unavailable");
    const artifact = `.session-artifacts/vscode-permission/${crypto.randomUUID()}`;
    await mkdir(artifact, { recursive: true });
    await Bun.write(join(artifact, "diagnostics.jsonl"), text);
  } finally {
    f.handler.dispose();
    logger.disposeChannels();
    await rm(directory, { recursive: true, force: true });
  }
});
