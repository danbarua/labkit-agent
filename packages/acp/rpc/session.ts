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
 * Queue `work` after earlier configuration changes and the active prompt; the returned operation
 * becomes the session's configuration tail. Callers race it against their own cancellation.
 */
export function afterPrompt<T>(
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

/** Wait until no configuration change is queued; rejects when `signal` aborts first. */
export async function awaitConfigurationQuiet(entry: Session, signal: AbortSignal): Promise<void> {
  let barrier: Promise<void>;
  do {
    barrier = entry.configurationTail;
    await waitForBoundary(barrier, signal);
  } while (barrier !== entry.configurationTail);
}
