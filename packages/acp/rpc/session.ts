import type { McpServer, ToolCallStatus } from "@agentclientprotocol/sdk";
import type { SessionPersistence, SessionRuntime } from "@labkit-agent/core";

import type { AcpCommand } from "../commands.ts";
import type { AcpConfigBinding } from "../session-config.ts";
import { waitForBoundary } from "../session-config.ts";
import type { usageReporter } from "../session-usage.ts";

/** Session entry in the RPC adapter's active sessions map. */
export type Session = {
  runtime: SessionRuntime;
  usage?: ReturnType<typeof usageReporter>;
  dispose: () => Promise<void>;
  persistence: SessionPersistence;
  promptController?: AbortController;
  promptRpcRequestId?: string;
  cwd: string;
  additionalDirectories: readonly string[];
  mcpServers: readonly McpServer[];
  busy: boolean;
  promptDone: Promise<void>;
  configurationTail: Promise<void>;
  config: readonly AcpConfigBinding[];
  commands: readonly AcpCommand[];
  configSignature: string;
  infoSignature: string;
  infoEpoch: number;
  modeId?: string;
  acceptingUpdates: boolean;
  revision: number;
  streamed: Map<string, string>;
  terminals: Map<string, string[]>;
  toolCards: Map<string, { baseTitle: string; title: string; status: ToolCallStatus }>;
};

/**
 * Queue work until the prompt completes, maintaining the configuration boundary chain.
 * Ensures configuration changes complete before new work begins.
 */
export async function afterPrompt<T>(
  entry: Session,
  cancellation: AbortSignal,
  work: () => Promise<T>,
): Promise<T> {
  const operation = entry.configurationTail.then(async () => {
    await waitForBoundary(entry.promptDone, cancellation);
    cancellation.throwIfAborted();
    return work();
  });
  entry.configurationTail = operation.then(
    () => {},
    () => {},
  );
  return operation;
}

/**
 * Wait for configuration to stabilize without failing on cancellation.
 * Returns when the configuration boundary has settled, even if cancelled.
 */
export async function awaitConfigurationQuiet(entry: Session, signal: AbortSignal): Promise<void> {
  try {
    await waitForBoundary(entry.configurationTail, signal);
  } catch {
    // Cancelled during configuration; configuration work may still be in progress.
  }
}
