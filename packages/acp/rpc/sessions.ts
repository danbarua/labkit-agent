import { isAbsolute, resolve } from "node:path";

import { RequestError, type AgentApp } from "@agentclientprotocol/sdk";
import { diagnostic, diagnosticError } from "@labkit-agent/core/logging";

import type { AcpOptions } from "../adapter.ts";
import { waitForBoundary } from "../session-config.ts";
import type { ConnectionGate } from "./connection.ts";
import type { AdapterCore } from "./core.ts";
import type { Eviction, LeaseClaim, LeaseHolder, SessionLease } from "./lease.ts";
import { opener, requireRootsAdvertised, type OpenDeps } from "./open.ts";
import { afterPrompt, type Session } from "./session.ts";

/** Sessions open on one connection and the IDs with a lifecycle operation in flight. */
export type RegistryState = {
  readonly sessions: Map<string, Session>;
  readonly opening: Set<string>;
  readonly deleting: Set<string>;
  readonly borrowedParents: Set<string>;
  /** Cleanup for every opened session's MCP and client resources, run on disconnect. */
  readonly resources: Set<() => Promise<void>>;
  /** Aborted when credentials change, cancelling opens started under the old credentials. */
  authLifetime: AbortController;
};

/** Which sessions are open on this connection; lifecycle handlers own every transition. */
export type SessionRegistry = Readonly<{
  state: RegistryState;
  /** An open session, after the initialize and (unless `cleanup`) auth checks. */
  lookup(id: string, cleanup?: boolean): Session;
  current(id: string): Session | undefined;
  isCurrent(id: string, entry: Session): boolean;
  /**
   * Register this connection's open, fork or delete of `id`, so that another connection claiming
   * `id` aborts `controller` and waits. Call the returned function once the operation settled.
   */
  hold(id: string, controller: AbortController): () => void;
  /**
   * Claim `id` in the session lease before a runtime opens or is removed. Another connection
   * holding it closes it first (see `SessionLease`).
   */
  claim(id: string, claim: LeaseClaim): Promise<Eviction | undefined>;
  /** Give up the lease on `id` after its runtime closed or its open failed. */
  release(id: string): void;
  /**
   * Close an open session as `session/close` does. Idempotent. The lease stays with this
   * connection until `release`, so a delete can close and remove the journal under one claim.
   */
  close(id: string, entry: Session): Promise<void>;
  /** Close every session because credentials changed. */
  revokeAll(): Promise<void>;
  /** Close every session because the connection closed. */
  shutdown(): Promise<void>;
  size(): number;
}>;

/** A request for a session another connection took over names that connection and the way back. */
function takenOverError(id: string, by: Readonly<{ connectionId: string; method: string }>) {
  return RequestError.invalidParams(
    { sessionId: id, takenOverBy: by.connectionId, method: by.method },
    by.method === "session/delete"
      ? `Session ${id} is no longer open on this connection: connection ${by.connectionId} deleted it with session/delete`
      : `Session ${id} is no longer open on this connection: connection ${by.connectionId} took it over with ${by.method}; send session/load to continue it on this connection`,
  );
}

/** Creates the empty session registry for one connection, holding sessions in `lease`. */
export function sessionRegistry(
  core: Pick<AdapterCore, "connectionId">,
  gate: Pick<ConnectionGate, "requireInitialized" | "requireAccess">,
  lease: SessionLease,
): SessionRegistry {
  const { connectionId } = core;
  const state: RegistryState = {
    sessions: new Map(),
    opening: new Set(),
    deleting: new Set(),
    borrowedParents: new Set(),
    resources: new Set(),
    authLifetime: new AbortController(),
  };
  const { sessions, deleting, borrowedParents, resources } = state;
  /** In-flight open, fork or delete per session; `claimed` once its lease claim has landed. */
  const operations = new Map<
    string,
    { controller: AbortController; settled: Promise<void>; claimed: boolean }
  >();
  const takenOver = new Map<string, { connectionId: string; method: string }>();
  const closing = new WeakMap<Session, Promise<void>>();
  let stopping: Promise<void> | undefined;
  const holder: LeaseHolder = {
    connectionId,
    claimed(id) {
      takenOver.delete(id);
      const operation = operations.get(id);
      if (operation) operation.claimed = true;
    },
    async evict(id, claimant, claim) {
      const by = { connectionId: claimant, method: claim.method };
      takenOver.set(id, by);
      // A closing connection closes its sessions itself; an open it aborted still has to let go.
      if (stopping) await stopping;
      // An operation still queued for its own claim is newer than this one and will evict it.
      const operation = operations.get(id);
      if (operation?.claimed) {
        operation.controller.abort(takenOverError(id, by));
        await operation.settled;
      }
      const entry = sessions.get(id);
      if (!entry) return { promptCancelled: false };
      const promptCancelled = entry.busy;
      await close(id, entry);
      return { promptCancelled, cwd: entry.cwd };
    },
  };

  function close(id: string, entry: Session) {
    let closed = closing.get(entry);
    if (closed) return closed;
    entry.usage?.close();
    entry.acceptingUpdates = false;
    entry.promptController?.abort();
    closed = (async () => {
      try {
        await entry.runtime.close();
      } finally {
        await entry.dispose();
        if (sessions.get(id) === entry) sessions.delete(id);
      }
    })();
    closing.set(entry, closed);
    return closed;
  }

  return {
    state,
    lookup(id, cleanup = false) {
      gate.requireInitialized();
      if (!cleanup) gate.requireAccess();
      if (deleting.has(id)) throw RequestError.invalidParams(undefined, "Session is being deleted");
      if (borrowedParents.has(id))
        throw RequestError.invalidParams(undefined, "Session is being forked privately");
      const session = sessions.get(id);
      if (!session) {
        const by = takenOver.get(id);
        diagnostic("acp", "warning", "acp.session.not_open", {
          connectionId,
          sessionId: id,
          ...(by ? { takenOverBy: by.connectionId, takeoverMethod: by.method } : {}),
        });
        if (by) throw takenOverError(id, by);
        throw RequestError.invalidParams(
          { sessionId: id },
          `Session ${id} is not open on this connection (never opened, closed or deleted); open it with session/load or session/resume before using it`,
        );
      }
      return session;
    },
    current: (id) => sessions.get(id),
    isCurrent: (id, entry) => sessions.get(id) === entry,
    hold(id, controller) {
      const { promise: settled, resolve: settle } = Promise.withResolvers<void>();
      const operation = { controller, settled, claimed: false };
      operations.set(id, operation);
      return () => {
        if (operations.get(id) === operation) operations.delete(id);
        settle();
      };
    },
    claim: (id, claim) => lease.claim(id, holder, claim),
    release: (id) => lease.release(id, holder),
    close,
    async revokeAll() {
      state.authLifetime.abort();
      state.authLifetime = new AbortController();
      await Promise.allSettled(
        [...sessions.entries()].map(async ([id, entry]) => {
          try {
            await close(id, entry);
          } finally {
            lease.release(id, holder);
          }
        }),
      );
    },
    shutdown() {
      stopping ??= (async () => {
        for (const entry of sessions.values()) {
          entry.usage?.close();
          entry.acceptingUpdates = false;
        }
        await Promise.allSettled([...sessions.values()].map((entry) => entry.runtime.close()));
        await Promise.allSettled([...resources].map((dispose) => dispose()));
        for (const id of sessions.keys()) lease.release(id, holder);
        sessions.clear();
      })();
      return stopping;
    },
    size: () => sessions.size,
  };
}

/** Registers session/new, load, resume, fork, delete, list and close. */
export function registerSessionLifecycle(
  app: AgentApp,
  deps: OpenDeps &
    Readonly<{
      deleteSession: AcpOptions["deleteSession"];
      listSessions: AcpOptions["listSessions"];
    }>,
): readonly string[] {
  const { core, gate, registry, updates } = deps;
  const { connectionId } = core;
  const { sessions, opening, deleting, borrowedParents } = registry.state;
  const open = opener(deps);
  app
    .onRequest("session/new", ({ params, client, signal }) => open(params, client, signal))
    .onRequest("session/load", async ({ params, client, signal }) => {
      const { sessionId: _, ...configuration } = await open(params, client, signal);
      return configuration;
    })
    .onRequest("session/resume", async ({ params, client, signal }) => {
      const { sessionId: _, ...configuration } = await open(
        { ...params, mcpServers: params.mcpServers ?? [] },
        client,
        signal,
        false,
      );
      return configuration;
    })
    .onRequest("session/fork", async ({ params, client, signal }) => {
      gate.requireAccess();
      if (deleting.has(params.sessionId))
        throw RequestError.invalidParams(undefined, "Session is being deleted");
      if (borrowedParents.has(params.sessionId))
        throw RequestError.invalidParams(undefined, "Session is already being forked privately");
      if (!isAbsolute(params.cwd))
        throw RequestError.invalidParams(undefined, "cwd must be absolute");
      requireRootsAdvertised(deps.additionalDirectories, params.additionalDirectories, {
        connectionId,
        rpcRequestId: String(client.requestId),
        method: "session/fork",
        sessionId: params.sessionId,
      });
      if (
        (params.additionalDirectories?.length ?? 0) > 32 ||
        params.additionalDirectories?.some((path) => !isAbsolute(path) || path.includes("\0"))
      )
        throw RequestError.invalidParams(
          undefined,
          "Additional directories must be absolute (at most 32)",
        );
      const takeover = new AbortController();
      const cancellation = AbortSignal.any([signal, core.signal(), takeover.signal]);
      const borrowed = !sessions.has(params.sessionId);
      let entry: Session | undefined;
      let settled: (() => void) | undefined;
      if (borrowed) {
        borrowedParents.add(params.sessionId);
        settled = registry.hold(params.sessionId, takeover);
      }
      try {
        if (borrowed) {
          // Another connection holding the parent closes it before this one restores it.
          await registry.claim(params.sessionId, {
            method: "session/fork",
            rpcRequestId: String(client.requestId),
            signal: cancellation,
          });
          cancellation.throwIfAborted();
          await waitForBoundary(
            open(
              { ...params, mcpServers: params.mcpServers ?? [] },
              client,
              cancellation,
              false,
              false,
            ),
            cancellation,
          );
        }
        entry = sessions.get(params.sessionId);
        if (!entry) throw RequestError.invalidParams(undefined, "Unknown parent session");
        const parent = entry;
        if (resolve(params.cwd) !== resolve(parent.cwd))
          throw RequestError.invalidParams(undefined, "Fork cwd must match the parent workspace");
        const mcpServers = params.mcpServers ?? [...parent.mcpServers];
        if (JSON.stringify(mcpServers) !== JSON.stringify(parent.mcpServers))
          throw RequestError.invalidParams(
            undefined,
            "Fork must retain the parent's MCP server bindings",
          );
        const operation = afterPrompt(parent, cancellation, async () => {
          if (sessions.get(params.sessionId) !== parent || (!borrowed && !parent.acceptingUpdates))
            throw new RequestError(-32000, "Parent session closed");
          const child = await parent.runtime.fork();
          const childId = child.snapshot.durable.conversation.sessionId;
          diagnostic("acp", "info", "acp.fork.committed", {
            connectionId,
            rpcRequestId: String(client.requestId),
            parentSessionId: params.sessionId,
            sessionId: childId,
            revision: child.snapshot.durable.revision,
          });
          // Fork inherits core bindings. Rebind ACP resources before allowing any child input.
          await child.close();
          updates.refreshInfo(parent, client);
          try {
            cancellation.throwIfAborted();
            return await open(
              {
                cwd: parent.cwd,
                sessionId: childId,
                mcpServers,
                additionalDirectories: params.additionalDirectories ?? [],
              },
              client,
              cancellation,
              false,
            );
          } catch (error) {
            diagnostic("acp", "error", "acp.fork.rebind.failed", {
              connectionId,
              rpcRequestId: String(client.requestId),
              parentSessionId: params.sessionId,
              sessionId: childId,
              error: diagnosticError(error),
            });
            throw new RequestError(-32000, "Fork was committed but could not be opened", {
              sessionId: childId,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        });
        return await waitForBoundary(operation, cancellation);
      } finally {
        if (borrowed) {
          try {
            // A cancelled private open may have published just before cancellation won the race.
            const parent = entry ?? sessions.get(params.sessionId);
            if (parent) await registry.close(params.sessionId, parent);
          } finally {
            borrowedParents.delete(params.sessionId);
            registry.release(params.sessionId);
            settled?.();
          }
        }
      }
    })
    .onRequest("session/delete", async ({ params, signal, client }) => {
      const started = performance.now();
      const trace = {
        connectionId,
        rpcRequestId: String(client.requestId),
        sessionId: params.sessionId,
        method: "session/delete",
      };
      diagnostic("acp", "info", "acp.session.delete.started", trace);
      gate.requireAccess();
      if (
        opening.has(params.sessionId) ||
        borrowedParents.has(params.sessionId) ||
        deleting.has(params.sessionId)
      )
        throw RequestError.invalidParams(
          undefined,
          "Session lifecycle operation is already pending",
        );
      const takeover = new AbortController();
      const cancellation = AbortSignal.any([signal, core.signal(), takeover.signal]);
      cancellation.throwIfAborted();
      deleting.add(params.sessionId);
      const settled = registry.hold(params.sessionId, takeover);
      const remove = deps.deleteSession!; // Unadvertised delete never reaches this handler.
      const operation = (async () => {
        // Another connection holding the session closes it first: never delete under a runtime.
        const evicted = await registry.claim(params.sessionId, {
          method: "session/delete",
          rpcRequestId: trace.rpcRequestId,
          signal: cancellation,
        });
        const entry = sessions.get(params.sessionId);
        if (entry) await registry.close(params.sessionId, entry);
        cancellation.throwIfAborted();
        const cwd = entry?.cwd ?? evicted?.cwd;
        await remove({ sessionId: params.sessionId, ...(cwd ? { cwd } : {}) }, cancellation);
        return {};
      })()
        .then(
          (result) => {
            diagnostic("acp", "info", "acp.session.delete.completed", {
              ...trace,
              durationMs: performance.now() - started,
            });
            return result;
          },
          (error) => {
            diagnostic("acp", "error", "acp.session.delete.failed", {
              ...trace,
              durationMs: performance.now() - started,
              error: diagnosticError(error),
            });
            throw error;
          },
        )
        .finally(() => {
          deleting.delete(params.sessionId);
          registry.release(params.sessionId);
          settled();
        });
      return waitForBoundary(operation, cancellation);
    })
    .onRequest("session/list", async ({ params, signal, client }) => {
      gate.requireAccess();
      if (params.cwd != null && !isAbsolute(params.cwd))
        throw RequestError.invalidParams(undefined, "cwd must be absolute");
      const started = performance.now();
      const trace = {
        connectionId,
        rpcRequestId: String(client.requestId),
        method: "session/list",
        cwd: params.cwd,
      };
      try {
        // Unadvertised list never reaches this handler.
        const result = await deps.listSessions!(params, signal);
        diagnostic("acp", "debug", "acp.session.list.completed", {
          ...trace,
          count: result.sessions.length,
          durationMs: performance.now() - started,
        });
        return result;
      } catch (error) {
        diagnostic("acp", "error", "acp.session.list.failed", {
          ...trace,
          durationMs: performance.now() - started,
          error: diagnosticError(error),
        });
        throw error;
      }
    })
    .onRequest("session/close", async ({ params }) => {
      const entry = registry.lookup(params.sessionId, true);
      // Close is terminal for this runtime, even if the client never answers permission requests.
      try {
        await registry.close(params.sessionId, entry);
      } finally {
        registry.release(params.sessionId);
      }
      await core.flushed();
      return {};
    });
  return [
    "session/new",
    "session/load",
    "session/resume",
    "session/fork",
    "session/delete",
    "session/list",
    "session/close",
  ];
}
