import { diagnostic, diagnosticError } from "@labkit-agent/core/logging";

/**
 * The lifecycle request that claims a session. A claim whose `signal` aborted while it waited for
 * earlier claims takes nothing over.
 */
export type LeaseClaim = Readonly<{ method: string; rpcRequestId: string; signal: AbortSignal }>;

/** What evicting the previous holder closed. */
export type Eviction = Readonly<{
  /** A prompt was running on the previous holder and now ends with stop reason `cancelled`. */
  promptCancelled: boolean;
  /** The evicted session's workspace, when it was open there. */
  cwd?: string;
}>;

/** One connection's side of the lease. */
export type LeaseHolder = Readonly<{
  connectionId: string;
  /** Called synchronously when this holder's claim on `sessionId` lands, before later claims run. */
  claimed(sessionId: string): void;
  /**
   * Let go of `sessionId` because `claimant` took it over: close it as `session/close` does, or
   * abort the open, fork or delete in flight. Resolves once no runtime remains on this connection.
   */
  evict(sessionId: string, claimant: string, claim: LeaseClaim): Promise<Eviction>;
}>;

/**
 * Process-wide record of which connection holds each session, so one process runs at most one
 * live runtime per session. The newest claim wins; claims on one session run one at a time.
 */
export type SessionLease = Readonly<{
  /**
   * Take `sessionId` for `holder` before opening or removing its runtime. Another connection
   * holding it is evicted first; resolves after its runtime closed. Rejects if the claim was
   * cancelled before its turn or that close failed.
   */
  claim(sessionId: string, holder: LeaseHolder, claim: LeaseClaim): Promise<Eviction | undefined>;
  /** Drop `holder`'s claim after its runtime closed or its open failed; a no-op otherwise. */
  release(sessionId: string, holder: LeaseHolder): void;
}>;

/** Creates an empty lease. Share one per process; stdio uses one per connection. */
export function sessionLease(): SessionLease {
  const holders = new Map<string, LeaseHolder>();
  const tails = new Map<string, Promise<void>>();

  async function take(sessionId: string, holder: LeaseHolder, claim: LeaseClaim) {
    claim.signal.throwIfAborted();
    const previous = holders.get(sessionId);
    if (!previous || previous === holder) {
      holders.set(sessionId, holder);
      holder.claimed(sessionId);
      return undefined;
    }
    const trace = {
      sessionId,
      connectionId: holder.connectionId,
      previousConnectionId: previous.connectionId,
      method: claim.method,
      rpcRequestId: claim.rpcRequestId,
    };
    let eviction: Eviction;
    try {
      eviction = await previous.evict(sessionId, holder.connectionId, claim);
    } catch (error) {
      if (holders.get(sessionId) === previous) holders.delete(sessionId);
      diagnostic("acp", "error", "acp.session.takeover.failed", {
        ...trace,
        error: diagnosticError(error),
        consequence: `${claim.method} was refused: the runtime on connection ${previous.connectionId} did not close cleanly, so opening another could run two runtimes on one journal`,
      });
      throw error;
    }
    holders.set(sessionId, holder);
    holder.claimed(sessionId);
    diagnostic("acp", eviction.promptCancelled ? "warning" : "info", "acp.session.taken_over", {
      ...trace,
      promptCancelled: eviction.promptCancelled,
      ...(eviction.promptCancelled
        ? {
            consequence: `The prompt running on connection ${previous.connectionId} ended with stop reason cancelled; that connection must send session/load to continue the session`,
          }
        : {}),
    });
    return eviction;
  }

  return {
    claim(sessionId, holder, claim) {
      const result = (tails.get(sessionId) ?? Promise.resolve()).then(() =>
        take(sessionId, holder, claim),
      );
      const tail = result.then(
        () => {},
        () => {},
      );
      tails.set(sessionId, tail);
      void tail.then(() => {
        if (tails.get(sessionId) === tail) tails.delete(sessionId);
      });
      return result;
    },
    release(sessionId, holder) {
      if (holders.get(sessionId) === holder) holders.delete(sessionId);
    },
  };
}
