import { SessionIdSchema } from "../../agent/types.ts";
import { freeze } from "../../fsm/fsm.ts";
import { diagnostic, diagnosticError } from "../../logging/index.ts";
import { AppendIdSchema } from "../persistence.ts";
import { JournalIntegrityError, replay } from "../session-log.ts";
import { loadSession } from "../session-operation.ts";
import type { SessionOptions, SessionRuntime } from "../session-runtime.ts";
import { SeedSchema } from "../types.ts";
import { configureSession } from "./configure.ts";
import { initializeSession, openInstance } from "./instance.ts";
import { planAdoption, type Adoption } from "./registry-adoption.ts";

/**
 * Creates a new root session and commits its creation record (append ID
 * `initialize/<sessionId>`), which holds the registry, standing instructions and initial policy.
 * Resolves once that record is committed.
 * @throws (rejects) when the bindings or configuration are invalid: not exactly one of
 * `complete`/`providers`, a provider-bound session without `policy.provider`, an unknown `agent`,
 * or a policy the bindings reject; or when the creation record does not commit.
 */
export async function createSession(options: SessionOptions): Promise<SessionRuntime> {
  const configured = configureSession(options);
  const sessionId = SessionIdSchema.parse(configured.options.sessionId ?? configured.id());
  return initializeSession(
    configured,
    SeedSchema.parse({
      sessionId,
      origin: { kind: "root" },
      context: [],
      log: [],
      agent: configured.agentId,
      allowance: configured.steps,
      sequence: 1,
      systemInputs: configured.options.systemInputs ?? [],
      ...(configured.initialPolicy ? { policy: configured.initialPolicy } : {}),
      systemVersion: 0,
      configuration: configured.configuration,
    }),
  );
}

/** {@link restoreSession} found no saved journal for this session ID (never saved, or deleted). */
export class SessionNotFoundError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super("Session not found");
    this.name = "SessionNotFoundError";
    this.sessionId = sessionId;
  }
}

/**
 * Reopens a saved session with the live configuration and bindings. Load checks journal integrity
 * only; a changed registry, model or policy never prevents reopening. Invokes no completion, tool
 * or permission callback.
 *
 * A turn interrupted by process exit is recovered: a recovery record ends it as failed
 * (`interrupted`) without repeating external effects, and accepted queued inputs are cancelled.
 * Fork and compaction requests that were waiting for that turn are dropped. Other differences
 * from the live bindings are not written yet: {@link SessionRuntime.registry} reports
 * `pending_adoption` and {@link SessionRuntime.policy} shows the reconciled policy until the first
 * new work commits them in a `configuration` record.
 * @param rawSessionId ID of the saved session; `options.sessionId` is ignored.
 * @throws (rejects) {@link SessionNotFoundError} when no journal is saved under the ID, and
 * otherwise when loading fails, the journal fails an integrity
 * rule ({@link JournalIntegrityError}), the recovery record does not commit, no live provider
 * selection can replace the saved one, or the bindings are invalid. `session.restore_failed`
 * logs the stage.
 */
export async function restoreSession(
  options: SessionOptions,
  rawSessionId: string,
): Promise<SessionRuntime> {
  const sessionId = SessionIdSchema.parse(rawSessionId);
  const startedAt = performance.now();
  let stage = "configure_bindings";
  try {
    const configured = configureSession(options, true);
    diagnostic("session", "info", "session.restoring", { sessionId });
    stage = "load_journal";
    const loaded = await loadSession(options.persistence, sessionId);
    if (loaded.kind === "not_found") throw new SessionNotFoundError(sessionId);
    if (loaded.kind !== "loaded") throw new Error(loaded.message, { cause: loaded.error });
    stage = "replay_journal";
    const journal = replay(loaded.batches);
    if (journal.conversation.sessionId !== sessionId || journal.revision !== loaded.revision) {
      const last = journal.records.at(-1);
      throw new JournalIntegrityError(
        journal.conversation.sessionId !== sessionId ? "session_identity" : "revision_sequence",
        `The stream of session ${sessionId} at revision ${loaded.revision} holds session ${journal.conversation.sessionId} at revision ${journal.revision}`,
        { revision: last?.revision, appendId: last?.appendId, entryId: last?.entryId },
      );
    }
    stage = "open_session";
    const built = openInstance(
      configured,
      freeze({ ...journal, conversation: { ...journal.conversation, pending: [] } }),
      true,
    );
    if (journal.conversation.turn.status !== "idle" || journal.pendingInputs?.length) {
      stage = "recover_interrupted_turn";
      diagnostic("session", "warning", "session.recovering", {
        sessionId,
        turnId: journal.conversation.turnId,
        phase: journal.conversation.turn.status,
        revision: journal.revision,
        reason: "Interrupted operation; external effects will not be replayed",
      });
      const receipt = await built.submit(
        {
          kind: "recovery",
          turnId: journal.conversation.turnId,
          reason: "Interrupted session; external effects were not replayed",
        },
        undefined,
        undefined,
        AppendIdSchema.parse(`recovery/${sessionId}/${journal.conversation.turnId}`),
      );
      if (receipt.kind !== "accepted") {
        await built.runtime.close();
        throw new Error(receipt.kind === "failed" ? receipt.message : `Recovery ${receipt.kind}`, {
          cause: receipt.kind === "failed" ? receipt.error : undefined,
        });
      }
    }
    const durable = built.runtime.snapshot.durable;
    stage = "plan_registry_adoption";
    let plan: Adoption | undefined;
    try {
      plan = planAdoption(durable, {
        live: configured.configuration,
        defaultAgent: configured.agentId,
        patchTools: configured.options.policy?.tools,
        resolvers: configured.resolvers,
        livePolicy: configured.livePolicy,
      });
    } catch (error) {
      await built.runtime.close();
      throw error;
    }
    if (plan) {
      diagnostic("session", "info", "session.registry.mismatch", {
        sessionId,
        revision: durable.revision,
        differences: plan.differences,
        adoption: "pending",
        message:
          "Persisted registry or provider selection differs from the live bindings; the live one is journaled before the next new work",
      });
      for (const reconciliation of plan.reconciliations)
        diagnostic("session", reconciliation.level, "session.registry.reconciled", {
          sessionId,
          revision: durable.revision,
          adoption: "pending",
          ...reconciliation.fields,
        });
      built.pend(plan);
    }
    diagnostic("session", "info", "session.restored", {
      sessionId,
      revision: durable.revision,
      durationMs: Math.round(performance.now() - startedAt),
      provider: durable.policy?.provider,
      model: durable.policy?.model,
      registry: built.runtime.registry.kind,
    });
    return built.runtime;
  } catch (error) {
    diagnostic("session", "error", "session.restore_failed", {
      sessionId,
      stage,
      durationMs: Math.round(performance.now() - startedAt),
      ...(error instanceof JournalIntegrityError
        ? {
            rule: error.rule,
            revision: error.revision,
            appendId: error.appendId,
            entryId: error.entryId,
          }
        : {}),
      error: diagnosticError(error),
    });
    throw error;
  }
}
