import type { ConversationCommand } from "../agent/agent-conversation.ts";
import { ActorIdSchema, failure, type Failure } from "../agent/types.ts";
import type { Decision } from "../fsm/fsm.ts";
import {
  builtinResolvers,
  changedPolicyFields,
  patchPolicy,
  PolicyVersionSchema,
  type Policy,
  type PolicyPatch,
  type PolicyResolvers,
} from "../policy/policy.ts";
import { AppendIdSchema } from "./persistence.ts";
import type { AppendId, AppendRequest, AppendResult, LoadResult, Receipt } from "./persistence.ts";
import { accepts, replay, stage, type JournalState } from "./session-log.ts";
import { SystemVersionSchema, type SessionInput } from "./types.ts";

/**
 * How the session answered one submission.
 *
 * - `accepted`: the staged records committed; `receipt` names the append and the revision it
 *   reached. The input's conversation commands are dispatched before this reply.
 * - `selected`: a configuration selection is stored and pending because a turn is running or
 *   starting, or a later selection superseded it; `id` correlates it with the
 *   `configuration.selected`/`configuration.applied` diagnostics. It applies as a "configuration
 *   applied" record at the next boundary between turns.
 * - `ignored`: the input no longer applies (stale or uncorrelated, see `accepts`), or a selection
 *   matches the configuration in force; nothing was written.
 * - `busy`: a `system` change arrived while a turn is running or staged, or while queued inputs
 *   wait; nothing was written. Configuration selections are never `busy`.
 * - `failed`: staging rejected the input (classification `admission`), or the session has failed;
 *   `error` says which.
 * - `closed`: the session closed before the input committed. An append already dispatched may
 *   still commit.
 */
export type CommandReceipt =
  | Readonly<{ kind: "accepted"; receipt: Receipt }>
  | Readonly<{ kind: "selected"; id: string; policy: Policy }>
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

/**
 * A configuration the user selected and not yet applied. `id` correlates the selection's reply,
 * its diagnostics and the append that applies it. `stored` turns true once the configuration store
 * holds it; the boundary waits for that. `revokesGrants` records that a superseded selection
 * changed permissions or tools. `fallback` is the last stored selection this one superseded, kept
 * pending again if storing this one fails.
 */
type Selection = Readonly<{
  id: string;
  policy: Policy;
  stored: boolean;
  revokesGrants: boolean;
  fallback?: Selection | undefined;
}>;

type Base = Readonly<{
  durable: JournalState;
  queue: readonly Submission[];
  selection?: Selection;
}>;

/**
 * State of the session's journal writer. `durable` is the committed state, as of the last append
 * receipt. `queue` holds submissions waiting to be staged, in arrival order; it lives in memory
 * only and is not the queued inputs (`JournalState.pendingInputs`). `selection` is the pending
 * configuration selection; it is not journaled until it applies. At most one append is in
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
 * `appendId`; they are ignored unless that append is in flight. `select` patches the pending
 * selection (or the configuration the next boundary applies) and holds it until `stored` reports
 * its write to the configuration store. `reselect` holds a selection the store already had when
 * the session was restored. `drain` applies a stored selection at an idle boundary, then stages
 * the next waiting submission or dequeues the first queued input when no turn is running.
 */
export type SessionEvent =
  | { type: "submit"; submission: Submission }
  | { type: "select"; id: string; patch: PolicyPatch }
  | { type: "reselect"; id: string; policy: Policy }
  | { type: "stored"; id: string; policy: Policy; error?: Failure }
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
 * - `selected`: a selection was registered; when `persist`, write it to the configuration store
 *   and report the outcome as a `stored` event.
 * - `unchanged`: a selection matched the policy in force and was dropped; revoke remembered tool
 *   approvals when `revokesGrants`.
 * - `revokeGrants`: revoke remembered tool approvals before a record that does not itself change
 *   permissions or tools applies.
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
  | { type: "stop" }
  | { type: "selected"; id: string; policy: Policy; persist: boolean }
  | { type: "unchanged"; id: string; policy: Policy; revokesGrants: boolean }
  | { type: "revokeGrants"; id: string; policyVersion: number };

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
  const waiting = [
    ...("pending" in state ? [state.pending.submission.id] : []),
    ...state.queue.map((s) => s.id),
    ...(state.selection?.stored ? [state.selection.id] : []),
  ];
  return {
    state: { status: "failed", durable: state.durable, queue: [], message, error },
    commands: [
      { type: "stop" },
      ...waiting.map((id) => reply(id, { kind: "failed", message, error })),
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
    state: {
      status: "ready",
      durable: p.next,
      queue: state.queue,
      ...(state.selection ? { selection: state.selection } : {}),
    },
    commands: [
      { type: "dispatch", commands: p.commands, submission: p.submission, durable: p.next },
      reply(p.submission.id, { kind: "accepted", receipt }),
      { type: "drain" },
    ],
  };
}

/**
 * The configuration the next turn runs under when it differs from the committed policy: a pending
 * selection, else one being applied by the append in flight; otherwise `undefined`.
 */
export function pendingSelection(state: SessionState): Policy | undefined {
  if (state.selection) return state.selection.policy;
  return "pending" in state && state.pending.submission.input.kind === "policy"
    ? state.pending.submission.input.policy
    : undefined;
}

/**
 * Policy and registry the next boundary applies: the committed ones, as changed by the append in
 * flight and the submissions waiting behind it (an applied configuration or a registry adoption).
 */
function nextConfiguration(state: SessionState) {
  let { policy, configuration } = state.durable;
  const inputs = [
    ...("pending" in state ? [state.pending.submission.input] : []),
    ...state.queue.map((submission) => submission.input),
  ];
  for (const input of inputs) {
    if (input.kind === "policy") policy = input.policy;
    if (input.kind === "configuration") {
      configuration = input.configuration;
      policy = input.policy ?? policy;
    }
  }
  return { policy, configuration };
}

/** Whether applying `next` over `previous` must revoke remembered tool approvals. */
function changesGrants(previous: Policy, next: Policy) {
  return changedPolicyFields(previous, next).some(
    (field) => field === "permissions" || field === "tools",
  );
}

/**
 * Whether `input` must wait for a pending selection to apply first. The session's own boundary
 * records (creation, recovery, registry adoption, and the applied configuration itself) do not.
 */
function awaitsSelection(state: SessionState, input: SessionInput) {
  return (
    state.selection !== undefined &&
    state.durable.conversation.turn.status === "idle" &&
    input.kind !== "created" &&
    input.kind !== "recovery" &&
    input.kind !== "configuration" &&
    input.kind !== "policy"
  );
}

/**
 * A stored selection: applied at once when the session is ready and idle, otherwise answered
 * `selected` while a turn runs or starts; an idle append in flight applies it on the next drain.
 */
function settleStored(
  state: SessionState,
  commands: readonly SessionCommand[],
  resolvers: PolicyResolvers,
): D {
  if (state.status === "ready") {
    const applied = applySelection(state, resolvers);
    if (applied) return { ...applied, commands: [...commands, ...applied.commands] };
  }
  const { selection } = state;
  const running =
    state.durable.conversation.turn.status !== "idle" ||
    ("pending" in state && state.pending.next.conversation.turn.status !== "idle");
  return {
    state,
    commands: [
      ...commands,
      ...(selection && running
        ? [reply(selection.id, { kind: "selected", id: selection.id, policy: selection.policy })]
        : []),
    ],
  };
}

/**
 * At an idle boundary, applies the pending selection: stages a "configuration applied" record
 * stamped with the next policy version, or answers `ignored` when it matches the policy in force.
 * Holds the boundary (no commands) until the selection is stored, and leaves it pending (returns
 * `undefined`) while a turn is running. A selection that no longer validates is dropped with a
 * `failed` reply; either way the drain continues. A selection that superseded a permission or tool
 * change revokes remembered approvals even when the record itself does not change them.
 */
function applySelection(
  state: Extract<SessionState, { status: "ready" }>,
  resolvers: PolicyResolvers,
): D | undefined {
  const { selection, ...cleared } = state;
  if (!selection || state.durable.conversation.turn.status !== "idle") return undefined;
  if (!selection.stored) return { state, commands: [] };
  const inForce = state.durable.policy;
  if (inForce && !changedPolicyFields(inForce, selection.policy).length)
    return {
      state: cleared,
      commands: [
        reply(selection.id, { kind: "ignored" }),
        {
          type: "unchanged",
          id: selection.id,
          policy: inForce,
          revokesGrants: selection.revokesGrants,
        },
        { type: "drain" },
      ],
    };
  const version = PolicyVersionSchema.parse((inForce?.version ?? -1) + 1);
  const revoke: SessionCommand[] =
    selection.revokesGrants && (!inForce || !changesGrants(inForce, selection.policy))
      ? [{ type: "revokeGrants", id: selection.id, policyVersion: version }]
      : [];
  const decision = mergeQueue(
    decideSession(
      { ...cleared, queue: [] },
      {
        type: "submit",
        submission: {
          id: selection.id,
          appendId: AppendIdSchema.parse(
            `${state.durable.conversation.sessionId}/configuration/${selection.id}`,
          ),
          input: { kind: "policy", policy: { ...selection.policy, version } },
        },
      },
      resolvers,
    ),
    state.queue,
  );
  return {
    ...decision,
    commands: [
      ...revoke,
      ...decision.commands,
      ...(decision.state.status === "ready" ? [{ type: "drain" } as const] : []),
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
 *
 * A configuration selection (`select`) is held in `selection` from the moment it arrives, so later
 * input at an idle boundary waits for it; it is never answered `busy`. The `selected` command
 * stores it and a `stored` event reports the write. A stored selection is staged as a `policy`
 * record whenever the session is ready and the conversation idle, before a queued input dequeues or
 * new input is admitted; while a turn runs or starts, the caller is answered `selected`.
 */
export function decideSession(
  state: SessionState,
  event: SessionEvent,
  resolvers: PolicyResolvers = builtinResolvers,
): D {
  if (event.type === "close") {
    const waiting = [
      ...("pending" in state ? [state.pending.submission.id] : []),
      ...state.queue.map((s) => s.id),
      ...(state.selection?.stored ? [state.selection.id] : []),
    ];
    return {
      state: { status: "closed", durable: state.durable, queue: [] },
      commands: [{ type: "stop" }, ...waiting.map((id) => reply(id, { kind: "closed" }))],
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
    // Busy is evaluated at admission, including a staged active turn. Configuration selections are
    // never busy (see `select`).
    if (
      s.input.kind === "system" &&
      (Boolean(state.durable.pendingInputs?.length) ||
        state.durable.conversation.turn.status !== "idle" ||
        ("pending" in state && state.pending.next.conversation.turn.status !== "idle"))
    )
      return { state, commands: [reply(s.id, { kind: "busy" })] };
    if (state.status !== "ready" || state.queue.length || awaitsSelection(state, s.input))
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
  if (event.type === "select" || event.type === "reselect") {
    if (state.status === "closed")
      return { state, commands: [reply(event.id, { kind: "closed" })] };
    if (state.status === "failed")
      return {
        state,
        commands: [reply(event.id, { kind: "failed", message: state.message, error: state.error })],
      };
    const next = nextConfiguration(state);
    let policy: Policy;
    if (event.type === "reselect") policy = event.policy;
    else
      try {
        const base = state.selection?.policy ?? next.policy;
        if (!base) throw new Error("Session has no configuration to select against");
        policy = patchPolicy(base, event.patch, next.configuration, resolvers);
      } catch (error) {
        const cause = failure(error, {
          classification: "admission",
          operation: {
            id: event.id,
            kind: "admission",
            sessionId: state.durable.conversation.sessionId,
            turnId: state.durable.conversation.turnId,
          },
          phase: "stage",
          details: { inputKind: "policy" },
        });
        return {
          state,
          commands: [reply(event.id, { kind: "failed", message: cause.message, error: cause })],
        };
      }
    const previous = state.selection;
    const fallback = previous?.stored ? { ...previous, fallback: undefined } : previous?.fallback;
    const selection: Selection = {
      id: event.id,
      policy,
      stored: event.type === "reselect",
      // Switching permissions or tools and back before the boundary still revokes grants.
      revokesGrants:
        previous !== undefined &&
        (previous.revokesGrants ||
          (next.policy !== undefined && changesGrants(next.policy, previous.policy))),
      fallback,
    };
    const commands: SessionCommand[] = [
      ...(previous?.stored
        ? [reply(previous.id, { kind: "selected", id: previous.id, policy: previous.policy })]
        : []),
      { type: "selected", id: selection.id, policy, persist: event.type === "select" },
    ];
    const selected = { ...state, selection };
    return selection.stored
      ? settleStored(selected, commands, resolvers)
      : { state: selected, commands };
  }
  if (event.type === "stored") {
    if (state.status === "closed")
      return { state, commands: [reply(event.id, { kind: "closed" })] };
    if (state.status === "failed")
      return {
        state,
        commands: [reply(event.id, { kind: "failed", message: state.message, error: state.error })],
      };
    const current = state.selection;
    if (current?.id !== event.id) {
      // A superseded selection: the store held it until the current one is written.
      if (event.error)
        return {
          state,
          commands: [
            reply(event.id, { kind: "failed", message: event.error.message, error: event.error }),
          ],
        };
      return {
        state: current
          ? {
              ...state,
              selection: {
                ...current,
                fallback: {
                  id: event.id,
                  policy: event.policy,
                  stored: true,
                  revokesGrants: current.revokesGrants,
                },
              },
            }
          : state,
        commands: [reply(event.id, { kind: "selected", id: event.id, policy: event.policy })],
      };
    }
    if (event.error) {
      // The store still holds the last selection written, so that one stays pending.
      const commands = [
        reply(event.id, { kind: "failed", message: event.error.message, error: event.error }),
      ];
      const reverted = { ...state, selection: current.fallback };
      return current.fallback
        ? settleStored(reverted, commands, resolvers)
        : { state: reverted, commands: [...commands, { type: "drain" }] };
    }
    return settleStored({ ...state, selection: { ...current, stored: true } }, [], resolvers);
  }
  if (event.type === "drain") {
    if (state.status !== "ready") return { state, commands: [] };
    const applied = applySelection(state, resolvers);
    if (applied) return applied;
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
