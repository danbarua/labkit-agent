import type { SessionNotification, ToolCall } from "@agentclientprotocol/sdk";

import { mergeToolCall } from "../tool-call";
import { log, logDiagnostic, logError } from "../utils/Logger";
import type { TerminalDisplay } from "./TerminalHandler";

export type SessionUpdateListener = (update: SessionNotification) => void;

/**
 * Routes session/update notifications to registered listeners.
 * The ChatWebviewProvider registers as a listener to forward updates to the webview.
 */
export class SessionUpdateHandler {
  private listeners: Set<SessionUpdateListener> = new Set();

  private terminalListeners = new Set<(update: TerminalDisplay) => void>();
  private tools = new Map<string, Map<string, ToolCall>>();
  private terminalDisplays = new Map<string, TerminalDisplay>();

  addTerminalListener(listener: (update: TerminalDisplay) => void) {
    this.terminalListeners.add(listener);
  }

  removeTerminalListener(listener: (update: TerminalDisplay) => void) {
    this.terminalListeners.delete(listener);
  }

  terminalSnapshots(sessionId: string) {
    return [...this.terminalDisplays.values()].filter((update) => update.sessionId === sessionId);
  }

  terminalOutput(update: TerminalDisplay) {
    this.terminalDisplays.set(update.terminalId, update);
    for (const listener of this.terminalListeners) {
      try {
        listener(update);
      } catch (error) {
        logError("Terminal display listener failed", error);
      }
    }
  }

  getToolCall(sessionId: string, toolCallId: string) {
    return this.tools.get(sessionId)?.get(toolCallId);
  }

  addListener(listener: SessionUpdateListener): void {
    this.listeners.add(listener);
  }

  removeListener(listener: SessionUpdateListener): void {
    this.listeners.delete(listener);
  }

  handleUpdate(update: SessionNotification): void {
    if (
      update.update.sessionUpdate === "tool_call" ||
      update.update.sessionUpdate === "tool_call_update"
    ) {
      let session = this.tools.get(update.sessionId);
      if (!session) {
        session = new Map();
        this.tools.set(update.sessionId, session);
      }
      const tool = mergeToolCall(session.get(update.update.toolCallId), update.update);
      session.set(tool.toolCallId, tool);
      const failed = update.update.status === "failed";
      logDiagnostic(
        failed ? "warning" : "debug",
        failed ? "vscode.tool.failed" : "vscode.tool.updated",
        {
          sessionId: update.sessionId,
          toolCallId: tool.toolCallId,
          title: tool.title,
          name: tool.name,
          kind: tool.kind,
          status: tool.status,
          changedFields: Object.keys(update.update).filter((field) => field !== "sessionUpdate"),
          contentCount: tool.content?.length ?? 0,
          locationCount: tool.locations?.length ?? 0,
          hasInput: tool.rawInput != null,
          hasOutput: tool.rawOutput != null,
          ...(failed
            ? {
                message: `Agent reported that ${tool.title} failed${tool.rawOutput == null ? "; no raw diagnostic output was provided" : "; latest reported output is attached"}`,
                reportedOutput: tool.rawOutput,
              }
            : {}),
        },
      );
    }
    const updateType = (update.update as any)?.sessionUpdate || "unknown";
    log(`sessionUpdate: type=${updateType}, sessionId=${update.sessionId}`);

    for (const listener of this.listeners) {
      try {
        listener(update);
      } catch (e) {
        logError(`Session update listener failed for ${update.sessionId} (${updateType})`, e);
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
    this.terminalListeners.clear();
    this.terminalDisplays.clear();
    this.tools.clear();
  }
}
