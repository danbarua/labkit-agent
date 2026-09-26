import type { AgentContext, SessionUpdate } from "@agentclientprotocol/sdk";
import { diagnostic, diagnosticError } from "@labkit-agent/core/logging";

export type AdapterCore = Readonly<{
  connectionId: string;
  signal: () => AbortSignal;
  isClosing: () => boolean;
  send: (client: AgentContext, sessionId: string, update: SessionUpdate) => void;
  flushed: () => Promise<void>;
}>;

export function adapterCore(deps: {
  connectionId: string;
  signal: () => AbortSignal;
  isClosing: () => boolean;
  close: (error?: Error) => void;
}): AdapterCore {
  let writes: Promise<void> = Promise.resolve();

  const send = (client: AgentContext, sessionId: string, update: SessionUpdate) => {
    if (deps.isClosing()) return;
    writes = writes
      .then(() => client.notify("session/update", { sessionId, update }))
      .catch((error) => {
        diagnostic("acp", "error", "acp.notification.failed", {
          connectionId: deps.connectionId,
          sessionId,
          method: "session/update",
          error: diagnosticError(error),
        });
        deps.close(error);
      });
  };

  return {
    connectionId: deps.connectionId,
    signal: deps.signal,
    isClosing: deps.isClosing,
    send,
    flushed: () => writes,
  };
}
