import type { ConversationCommand } from "../agent/agent-conversation.ts";
import { ActorIdSchema, failure, type Failure } from "../agent/types.ts";
import type { Decision } from "../fsm/fsm.ts";
import { builtinResolvers, type PolicyResolvers } from "../policy/policy.ts";
import { AppendIdSchema } from "./persistence.ts";
import type { AppendId, AppendRequest, AppendResult, LoadResult, Receipt } from "./persistence.ts";
import { accepts, replay, stage, type JournalState } from "./session-log.ts";
import { SystemVersionSchema, type SessionInput } from "./types.ts";

/**
 * How the session answered one submission.
 *
 * - `accepted`: the staged records committed; `receipt` names the append and the revision it
 *   reached. The input's conversation commands are dispatched before this reply.
 * - `ignored`: the input no longer applies (stale or uncorrelated, see `accepts`); nothing was
 *   written.
 * - `busy`: a `system` or `policy` change arrived while a turn is running or staged, or while
 *   queued inputs wait; nothing was written.
 * - `failed`: staging rejected the input (classification `admission`), or the session has failed;
 *   `error` says which.
 * - `closed`: the session closed before the input committed. An append already dispatched may
 *   still commit.
 */
export type CommandReceipt =
  | Readonly<{ kind: "accepted"; receipt: Receipt }>
  | Readonly<{ kind: "ignored" }>
  | Readonly<{ kind: "busy" }>
  | Readonly<{ kind: "failed"; message: string; error: Failure }>
  | Readonly<{ kind: "closed" }>;

/**
 * One input on its way into the journal. `id` correlates the reply; user input the policy queues
 * also takes it as its queued-input ID. `appendId` is the stable ID of the append that carries the
 * staged records, reused if that append is retried.
 */
export type Submission = Readonly<{ id: string; appendId: AppendId; input: SessionInput }>;

/** The one append in flight: its submission, the proposed state, and what to release on commit. */
type Pending = Readonly<{
  submission: Submission;
  /** Proposed state; it becomes `durable` only when the append commits. */
  next: JournalState;
  request: AppendRequest;
  /** Conversation commands dispatched once the append commits. */
  commands: readonly ConversationCommand[];
  /** Retries of this append after reconciliation found it absent; at most one. */
  attempts: number;
  /** Failure that made the last attempt's outcome unknown. */
  uncertainty?: Failure;
}>;

type Base = Readonly<{ durable: JournalState; queue: readonly Submission[] }>;

/**
 * State of the session's journal writer. `durable` is the committed state, as of the last append
 * receipt. `queue` holds submissions waiting to be staged, in arrival order; it lives in memory
 * only and is not the queued inputs (`JournalState.pendingInputs`). At most one append is in
 * flight.
 *
 * - `ready`: no append in flight.
 * - `committing`: `pending` holds a staged append awaiting its storage receipt.
 * - `reconciling`: the append's outcome is unknown; the journal is being loaded to find out
 *   whether it committed.
 * - `failed`: storage failed, or an input the session generated itself could not be staged. Every
 *   later submission fails with the same `error`.
 * - `closed`: the session closed; later submissions answer `closed`.
 */
export type SessionState = Base &
  (
    | Readonly<{ status: "ready" }>
    | Readonly<{ status: "committing" | "reconciling"; pending: Pending }>
    | Readonly<{ status: "failed"; message: string; error: Failure }>
    | Readonly<{ status: "closed" }>
  );

/**
 * Input to {@link decideSession}. `appended` and `loaded` report the storage operation for
 * `appendId`; they are ignored unless that append is in flight. `drain` stages the next waiting
 * submission, or dequeues the first queued input when no turn is running.
 */
export type SessionEvent =
  | { type: "submit"; submission: Submission }
  | { type: "appended"; appendId: AppendId; result: AppendResult }
  | { type: "loaded"; appendId: AppendId; result: LoadResult }
  | { type: "drain" }
  | { type: "close" };

/**
 * Effect of a session decision.
 *
 * - `append`: write the batch to storage.
 * - `load`: load the journal to learn whether an append with an unknown outcome committed.
 * - `dispatch`: an append committed; release its conversation commands (the turn's next child
 *   operation, or a branch) against the committed state `durable`.
 * - `reply`: answer submission `id`.
 * - `drain`: send a `drain` event.
 * - `stop`: the session failed or closed; stop owned work and storage operations.
 */
export type SessionCommand =
  | { type: "append"; request: AppendRequest }
  | { type: "load"; appendId: AppendId }
  | {
      type: "dispatch";
      commands: readonly ConversationCommand[];
      submission: Submission;
      durable: JournalState;
    }
  | { type: "reply"; id: string; result: CommandReceipt }
  | { type: "drain" }
  | { type: "stop" };

type D = Decision<SessionState, SessionCommand>;

const reply = (id: string, result: CommandReceipt): SessionCommand => ({
  type: "reply",
  id,
  result,
});

function fail(
  state: SessionState,
  reason: unknown,
  phase = "append",
  details?: Failure["details"],
): D {
  const pending = "pending" in state ? state.pending : undefined;
  const original = failure(reason);
  const error = failure({
    ...original,
    classification: original.classification ?? "persistence",
    operation: {
      id: pending?.request.appendId ?? state.durable.conversation.sessionId,
      kind: phase === "load" ? "load" : "append",
      sessionId: state.durable.conversation.sessionId,
      turnId: state.durable.conversation.turnId,
      ...original.operation,
    },
    phase: original.phase ?? phase,
    details: {
      appendId: pending?.request.appendId ?? null,
      expectedRevision: pending?.request.expectedRevision ?? state.durable.revision,
      attempts: pending ? pending.attempts + 1 : 0,
      precedingFailure: pending?.uncertainty ?? null,
      observed: details ?? null,
      originalDetails: original.details ?? null,
    },
  });
  const message = error.message;
  const submissions = [...("pending" in state ? [state.pending.submission] : []), ...state.queue];
  return {
    state: { status: "failed", durable: state.durable, queue: [], message, error },
    commands: [
      { type: "stop" },
      ...submissions.map((s) => reply(s.id, { kind: "failed", message, error })),
    ],
  };
}

function committed(
  state: Extract<SessionState, { status: "committing" | "reconciling" }>,
  receipt: Receipt,
): D {
  const p = state.pending;
  if (
    receipt.sessionId !== p.request.sessionId ||
    receipt.appendId !== p.request.appendId ||
    receipt.revision !== p.next.revision
  )
    return fail(state, "Invalid append receipt", "validate_receipt", {
      received: receipt,
      expectedRevision: p.next.revision,
    });
  return {
    state: { status: "ready", durable: p.next, queue: state.queue },
    commands: [
      { type: "dispatch", commands: p.commands, submission: p.submission, durable: p.next },
      reply(p.submission.id, { kind: "accepted", receipt }),
      { type: "drain" },
    ],
  };
}

/**
 * The session's pure transition function.
 *
 * A submission that arrives while an append is in flight waits in `queue`. A ready session stages
 * it with `stage` under `resolvers` and appends the result. A matching committed receipt makes the
 * staged state durable, dispatches its commands and replies `accepted`. An indeterminate append
 * moves to `reconciling`: the loaded journal shows whether the append committed with the same
 * bytes, and an append absent at the expected revision is retried once. Anything else, and every
 * rejected or conflicting append, fails the session and every waiting submission.
 *
 * A staging failure answers `failed` with classification `admission`. For inputs the session
 * generates itself (tool results, child events, dequeues, recovery, registry adoption) it also
 * fails the session, so no waiting work is released under the old state.
 */
export function decideSession(
  state: SessionState,
  event: SessionEvent,
  resolvers: PolicyResolvers = builtinResolvers,
): D {
  if (event.type === "close") {
    const submissions = [...("pending" in state ? [state.pending.submission] : []), ...state.queue];
    return {
      state: { status: "closed", durable: state.durable, queue: [] },
      commands: [{ type: "stop" }, ...submissions.map((s) => reply(s.id, { kind: "closed" }))],
    };
  }
  if (event.type === "submit") {
    const s = event.submission;
    if (state.status === "closed") return { state, commands: [reply(s.id, { kind: "closed" })] };
    if (state.status === "failed")
      return {
        state,
        commands: [reply(s.id, { kind: "failed", message: state.message, error: state.error })],
      };
    // Busy is evaluated at admission, including a staged active turn.
    if (
      (s.input.kind === "system" || s.input.kind === "policy") &&
      (Boolean(state.durable.pendingInputs?.length) ||
        state.durable.conversation.turn.status !== "idle" ||
        ("pending" in state && state.pending.next.conversation.turn.status !== "idle"))
    )
      return { state, commands: [reply(s.id, { kind: "busy" })] };
    if (state.status !== "ready" || state.queue.length)
      return {
        state: { ...state, queue: [...state.queue, s] },
        commands: state.status === "ready" ? [{ type: "drain" }] : [],
      };
    if (!accepts(state.durable, s.input))
      return { state, commands: [reply(s.id, { kind: "ignored" })] };
    try {
      // Queued updates use the version at their actual idle boundary.
      const input =
        s.input.kind === "system"
          ? { ...s.input, version: SystemVersionSchema.parse(state.durable.systemVersion + 1) }
          : s.input.kind === "event"
            ? { ...s.input, systemVersion: state.durable.systemVersion }
            : s.input;
      const next = stage(state.durable, input, s.appendId, resolvers, ActorIdSchema.parse(s.id));
      const request: AppendRequest = {
        sessionId: state.durable.conversation.sessionId,
        expectedRevision: state.durable.revision,
        appendId: s.appendId,
        records: next.records,
      };
      return {
        state: {
          ...state,
          status: "committing",
          pending: {
            submission: s,
            next: next.state,
            request,
            commands: next.commands,
            attempts: 0,
          },
        },
        commands: [{ type: "append", request }],
      };
    } catch (error) {
      const cause = failure(error, {
        classification: "admission",
        operation: {
          id: s.id,
          kind: "admission",
          sessionId: state.durable.conversation.sessionId,
          turnId: state.durable.conversation.turnId,
        },
        phase: "stage",
        details: { inputKind: s.input.kind, appendId: s.appendId },
      });
      const message = cause.message;
      // Adoption gates queued work: a rejected adoption must not release that work under the old registry.
      if (
        s.input.kind === "tool" ||
        s.input.kind === "dequeued" ||
        s.input.kind === "recovery" ||
        s.input.kind === "configuration" ||
        (s.input.kind === "event" && s.input.event.type === "child")
      ) {
        const failed = fail(state, cause);
        return {
          state: failed.state,
          commands: [...failed.commands, reply(s.id, { kind: "failed", message, error: cause })],
        };
      }
      return { state, commands: [reply(s.id, { kind: "failed", message, error: cause })] };
    }
  }
  if (event.type === "drain") {
    if (state.status !== "ready") return { state, commands: [] };
    const queuedInput = state.durable.pendingInputs?.[0];
    if (queuedInput && state.durable.conversation.turn.status === "idle") {
      return mergeQueue(
        decideSession(
          { ...state, queue: [] },
          {
            type: "submit",
            submission: {
              id: `dequeue/${queuedInput.inputId}`,
              appendId: AppendIdSchema.parse(
                `${state.durable.conversation.sessionId}/dequeue/${queuedInput.inputId}`,
              ),
              input: {
                kind: "dequeued",
                inputId: queuedInput.inputId,
                policyVersion: state.durable.policy!.version,
              },
            },
          },
          resolvers,
        ),
        state.queue,
      );
    }
    if (!state.queue.length) return { state, commands: [] };
    const [submission, ...queue] = state.queue;
    const decision = mergeQueue(
      decideSession(
        { ...state, queue: [] },
        { type: "submit", submission: submission! },
        resolvers,
      ),
      queue,
    );
    return {
      state: decision.state,
      commands:
        decision.state.status === "ready"
          ? [...decision.commands, { type: "drain" }]
          : decision.commands,
    };
  }
  if (
    (state.status !== "committing" && state.status !== "reconciling") ||
    event.appendId !== state.pending.request.appendId
  )
    return { state, commands: [] };
  if (event.type === "appended" && state.status === "committing") {
    if (event.result.kind === "committed") return committed(state, event.result.receipt);
    if (event.result.kind === "indeterminate")
      return {
        state: {
          ...state,
          status: "reconciling",
          pending: {
            ...state.pending,
            uncertainty:
              event.result.error ??
              failure(event.result.message, {
                classification: "persistence",
                operation: {
                  id: event.appendId,
                  kind: "append",
                  sessionId: state.durable.conversation.sessionId,
                },
                phase: "append",
              }),
          },
        },
        commands: [{ type: "load", appendId: event.appendId }],
      };
    return fail(
      state,
      event.result.kind === "conflict"
        ? "Persistence revision conflict"
        : (event.result.error ?? event.result.message),
      "append",
      event.result.kind === "conflict"
        ? { outcome: "conflict", actualRevision: event.result.revision }
        : { outcome: "rejected" },
    );
  }
  if (event.type === "loaded" && state.status === "reconciling") {
    const loaded = event.result;
    if (loaded.kind === "failed") return fail(state, loaded.error ?? loaded.message, "load");
    const p = state.pending;
    if (loaded.kind === "loaded") {
      try {
        if (replay(loaded.batches).revision !== loaded.revision)
          throw new Error("Load revision mismatch");
      } catch (error) {
        return fail(state, error, "reconcile");
      }
      const found = loaded.batches.find((batch) => batch.appendId === p.request.appendId);
      if (found) {
        if (
          found.expectedRevision !== p.request.expectedRevision ||
          JSON.stringify(found.records) !== JSON.stringify(p.request.records) ||
          loaded.revision !== found.revision
        )
          return fail(state, "Reconciliation content or writer conflict", "reconcile", {
            actualRevision: loaded.revision,
          });
        return committed(state, {
          sessionId: found.sessionId,
          appendId: found.appendId,
          revision: found.revision,
        });
      }
    }
    if (
      (loaded.kind === "not_found" ? 0 : loaded.revision) !== p.request.expectedRevision ||
      p.attempts >= 1
    )
      return fail(state, "Unable to reconcile append", "reconcile");
    return {
      state: { ...state, status: "committing", pending: { ...p, attempts: p.attempts + 1 } },
      commands: [{ type: "append", request: p.request }],
    };
  }
  return { state, commands: [] };
}

function mergeQueue(decision: D, queue: readonly Submission[]): D {
  if (decision.state.status === "failed" || decision.state.status === "closed") {
    const result: CommandReceipt =
      decision.state.status === "closed"
        ? { kind: "closed" }
        : { kind: "failed", message: decision.state.message, error: decision.state.error };
    return {
      state: decision.state,
      commands: [...decision.commands, ...queue.map((submission) => reply(submission.id, result))],
    };
  }
  return { ...decision, state: { ...decision.state, queue: [...decision.state.queue, ...queue] } };
}
