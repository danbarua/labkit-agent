import * as vscode from "vscode";

import { diagnosticError, redactDiagnostics } from "../../../core/logging/index.ts";
import { fileDiagnostics } from "./file-diagnostics";

let output: vscode.OutputChannel | undefined;

let traffic: vscode.OutputChannel | undefined;

let durable: ReturnType<typeof fileDiagnostics> | undefined;

let secrets: string[] = [];

export function configureDiagnostics(directory: string, configuredSecrets: readonly string[]) {
  secrets = [...configuredSecrets];
  durable = fileDiagnostics(directory, secrets);
  getOutputChannel().appendLine(`Durable diagnostics: ${durable.path} (10 MiB, 4 backups)`);
  durable.write("info", "vscode.client.started", { pid: process.pid, path: durable.path });
}

export function registerEnvironmentSecrets(environment: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(environment)) {
    if (
      value &&
      /API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name) &&
      !secrets.includes(value)
    ) {
      secrets.push(value);
    }
  }
}

export function getOutputChannel(): vscode.OutputChannel {
  return (output ??= vscode.window.createOutputChannel("Labkit ACP Client"));
}

export function getTrafficChannel(): vscode.OutputChannel {
  return (traffic ??= vscode.window.createOutputChannel("Labkit ACP Traffic"));
}

export function log(message: string, ...args: unknown[]): void {
  const fields = { message, details: args };
  const record =
    durable?.write("info", "vscode.client.event", fields) ?? redactDiagnostics(fields, secrets);
  getOutputChannel().appendLine(JSON.stringify(record));
}

export function logError(message: string, error?: unknown): void {
  const fields = { message, error: diagnosticError(error) };
  const record =
    durable?.write("error", "vscode.client.failed", fields) ?? redactDiagnostics(fields, secrets);
  getOutputChannel().appendLine(JSON.stringify(record));
}

export function logTraffic(direction: "send" | "recv", data: unknown): void {
  const message = data as Record<string, any>;
  const update = message?.params?.update;
  durable?.write(
    message?.error || update?.status === "failed" ? "warning" : "debug",
    "vscode.protocol.message",
    {
      direction,
      rpcRequestId: message?.id,
      method: message?.method,
      sessionId:
        message?.params?.sessionId ??
        message?.result?.sessionId ??
        message?.error?.data?.operation?.sessionId,
      sessionUpdate: update?.sessionUpdate,
      toolCallId: update?.toolCallId,
      title: update?.title,
      status: update?.status,
      stopReason: message?.result?.stopReason,
      ...(message?.error ? { error: message.error } : {}),
      ...(update?.status === "failed" ? { error: update.rawOutput } : {}),
      bytes: Buffer.byteLength(JSON.stringify(data)),
    },
  );
  if (!vscode.workspace.getConfiguration("acp").get<boolean>("logTraffic", true)) return;
  const redacted = redactDiagnostics(data, secrets);
  durable?.write("debug", "vscode.protocol.body", { direction, body: redacted });
  getTrafficChannel().appendLine(JSON.stringify({ direction, body: redacted }, null, 2));
}

export function disposeChannels(): void {
  durable?.write("info", "vscode.client.stopped");
  durable?.close();
  durable = undefined;
  output?.dispose();
  traffic?.dispose();
  output = undefined;
  traffic = undefined;
}
