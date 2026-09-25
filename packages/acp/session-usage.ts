import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { ResolvedModel, SessionState } from "@labkit-agent/core";
import { diagnostic, diagnosticError } from "@labkit-agent/core/logging";
import { z } from "zod";

export const AcpUsageSchema = z
  .strictObject({
    used: z.number().finite().nonnegative(),
    size: z.number().finite().positive(),
    cost: z
      .strictObject({
        amount: z.number().finite().nonnegative(),
        currency: z.string().regex(/^[A-Z]{3}$/, "Use an ISO 4217 currency code"),
        _meta: z.record(z.string(), z.json()).nullable().optional(),
      })
      .nullable()
      .optional(),
    _meta: z.record(z.string(), z.json()).nullable().optional(),
  })
  .readonly();

export type AcpUsage = z.infer<typeof AcpUsageSchema>;

export type AcpUsageContext = Readonly<{
  sessionId: string;
  cwd: string;
  snapshot: SessionState;
  model?: ResolvedModel;
}>;

/** Read current context occupancy and optional cumulative cost from the owning environment. */
export type AcpUsageBinding = Readonly<{
  read: (
    context: AcpUsageContext,
    signal: AbortSignal,
  ) => AcpUsage | undefined | Promise<AcpUsage | undefined>;
  /** Notify when external accounting changes without a session journal commit. */
  subscribe?: (changed: () => void, signal: AbortSignal) => void | (() => void);
}>;

export function usageReporter(
  binding: AcpUsageBinding,
  context: () => AcpUsageContext,
  publish: (update: SessionUpdate) => void,
  connectionId: string,
) {
  const read = binding.read;
  const subscribe = binding.subscribe;
  const lifetime = new AbortController();
  let pending:
    { controller: AbortController; trace: Readonly<Record<string, unknown>> } | undefined;
  let epoch = 0;
  let lastRevision: number | undefined;
  let signature: string | undefined;
  let unsubscribe: (() => void) | undefined;

  const cancelPending = (reason: string) => {
    if (!pending) return;
    diagnostic("acp", "debug", "acp.usage.cancelled", { ...pending.trace, reason });
    pending.controller.abort();
    pending = undefined;
  };

  const refresh = (force = false) => {
    if (lifetime.signal.aborted) return;
    const captured = context();
    const revision = captured.snapshot.durable.revision;
    if (!force && revision === lastRevision) return;
    lastRevision = revision;
    cancelPending("A newer session state or accounting notification superseded this usage read");
    const controller = new AbortController();
    const generation = ++epoch;
    const signal = AbortSignal.any([lifetime.signal, controller.signal]);
    const trace = {
      connectionId,
      sessionId: captured.sessionId,
      revision,
      usageRequestId: crypto.randomUUID(),
    };
    pending = { controller, trace };
    const started = performance.now();
    let reportedUsage: Readonly<Record<string, unknown>> | undefined;
    diagnostic("acp", "debug", "acp.usage.read", trace);
    void Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return read(captured, signal);
      })
      .then((value) => {
        if (
          signal.aborted ||
          generation !== epoch ||
          context().snapshot.durable.revision !== revision
        ) {
          diagnostic("acp", "debug", "acp.usage.stale", {
            ...trace,
            reason:
              "Usage source completed after cancellation or a newer session state; update discarded",
          });
          return;
        }
        if (value === undefined) {
          diagnostic("acp", "debug", "acp.usage.unavailable", {
            ...trace,
            reason:
              "Usage source has no current context measurement and capacity; no usage update sent",
          });
          return;
        }
        reportedUsage = {
          used: value?.used,
          size: value?.size,
          amount: value?.cost?.amount,
          currency: value?.cost?.currency,
        };
        const usage = AcpUsageSchema.parse(value);
        const next = JSON.stringify(usage);
        if (next === signature) return;
        signature = next;
        // The schema creates a detached value; callers cannot mutate an enqueued notification.
        publish({ sessionUpdate: "usage_update", ...usage });
        diagnostic("acp", "info", "acp.usage.updated", {
          ...trace,
          durationMs: performance.now() - started,
          used: usage.used,
          size: usage.size,
          cost: usage.cost
            ? { amount: usage.cost.amount, currency: usage.cost.currency }
            : usage.cost,
          reason:
            "Published current context occupancy and optional cumulative session cost from the environment source",
        });
      })
      .catch((error) => {
        if (signal.aborted) return;
        diagnostic("acp", "warning", "acp.usage.failed", {
          ...trace,
          durationMs: performance.now() - started,
          error: diagnosticError(error),
          reportedUsage,
          reason:
            "Could not read valid session usage; no replacement update sent; agent execution continues",
        });
      })
      .finally(() => {
        if (pending?.controller === controller) pending = undefined;
      });
  };

  const close = () => {
    if (lifetime.signal.aborted) return;
    lifetime.abort();
    cancelPending("Session closed; usage reads can no longer publish updates");
    diagnostic("acp", "debug", "acp.usage.closed", {
      connectionId,
      sessionId: context().sessionId,
    });
    try {
      unsubscribe?.();
    } catch (error) {
      diagnostic("acp", "warning", "acp.usage.unsubscribe_failed", {
        connectionId,
        sessionId: context().sessionId,
        error: diagnosticError(error),
        reason: "Usage subscription cleanup failed; its callbacks can no longer publish updates",
      });
    }
  };

  try {
    unsubscribe = subscribe?.(() => refresh(true), lifetime.signal) ?? undefined;
  } catch (error) {
    diagnostic("acp", "warning", "acp.usage.subscribe_failed", {
      connectionId,
      sessionId: context().sessionId,
      error: diagnosticError(error),
      reason: "External usage-change subscription failed; journal commits still refresh usage",
    });
  }
  refresh();
  return { refresh, close };
}
