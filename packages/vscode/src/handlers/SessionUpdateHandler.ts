import type { SessionNotification } from "@agentclientprotocol/sdk";

import { log, logError } from "../utils/Logger";
import type { TerminalDisplay } from "./TerminalHandler";

export type SessionUpdateListener = (update: SessionNotification) => void;

/**
 * Routes session/update notifications to registered listeners.
 * The ChatWebviewProvider registers as a listener to forward updates to the webview.
 */
export class SessionUpdateHandler {
  private listeners: Set<SessionUpdateListener> = new Set();

  private terminalListeners = new Set<(update: TerminalDisplay) => void>();
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

  addListener(listener: SessionUpdateListener): void {
    this.listeners.add(listener);
  }

  removeListener(listener: SessionUpdateListener): void {
    this.listeners.delete(listener);
  }

  handleUpdate(update: SessionNotification): void {
    const updateType = (update.update as any)?.sessionUpdate || "unknown";
    log(`sessionUpdate: type=${updateType}, sessionId=${update.sessionId}`);

    for (const listener of this.listeners) {
      try {
        listener(update);
      } catch (e) {
        log(`Error in session update listener: ${e}`);
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
    this.terminalListeners.clear();
    this.terminalDisplays.clear();
  }
}
