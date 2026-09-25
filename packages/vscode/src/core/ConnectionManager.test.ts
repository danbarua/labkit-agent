import { spawn } from "node:child_process";
import { expect, mock, test } from "bun:test";

mock.module("vscode", () => ({
  window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) },
  workspace: { getConfiguration: () => ({ get: (_name: string, fallback: unknown) => fallback }) },
}));

const { ConnectionManager } = await import("./ConnectionManager.ts");

const { SessionUpdateHandler } = await import("../handlers/SessionUpdateHandler.ts");

test("the real stdio client initializes and returns cancelled permission through JSON-RPC", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
    const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
    require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
      const message = JSON.parse(line);
      if (message.method === "initialize") {
        send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [], agentInfo: { name: "scripted-stdio", version: "1" } } });
        send({ jsonrpc: "2.0", id: 101, method: "session/request_permission", params: { sessionId: "stdio-session", toolCall: { toolCallId: "read", title: "Read report" }, options: [{ optionId: "once", kind: "allow_once", name: "Allow once" }] } });
      } else if (message.id === 101) {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "stdio-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(message.result) } } } });
      }
    });
  `,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const exited = new Promise((resolve) => child.once("close", resolve));
  const events = new SessionUpdateHandler();
  const notifications: any[] = [];
  events.addListener((update) => notifications.push(update));
  let shown = false;
  let disposed = false;
  const editor = {
    workspace: { getConfiguration: () => ({ get: () => "none" }) },
    window: {
      createQuickPick: () => ({
        onDidAccept: () => ({ dispose() {} }),
        onDidHide: () => ({ dispose() {} }),
        show() {
          shown = true;
        },
        hide() {},
        dispose() {
          disposed = true;
        },
      }),
    },
  };
  const manager = new ConnectionManager(events, editor as any);

  const until = async (predicate: () => boolean) => {
    const deadline = performance.now() + 5000;
    while (!predicate()) {
      if (performance.now() > deadline)
        throw new Error("The scripted stdio exchange did not reach its expected state");
      await Bun.sleep(5);
    }
  };

  try {
    const connection = await manager.connect("scripted", child, process.cwd());
    expect(connection.initResponse.agentInfo?.name).toBe("scripted-stdio");
    await until(() => shown);
    connection.permissions.cancelSession("stdio-session");
    await until(() => notifications.length === 1);
    expect(JSON.parse(notifications[0].update.content.text)).toEqual({
      outcome: { outcome: "cancelled" },
    });
    expect(disposed).toBe(true);
    manager.removeConnection("scripted");
    expect(connection.connection.signal.aborted).toBe(true);
  } finally {
    manager.dispose();
    child.kill();
    await exited;
  }
}, 10_000);
