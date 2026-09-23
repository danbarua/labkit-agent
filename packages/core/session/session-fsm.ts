import type { ConversationCommand } from "../agent/agent-conversation.ts";
import type { Decision } from "../fsm/fsm.ts";
import { accepts, replay, stage, type JournalState } from "./session-log.ts";
import type { AppendId, AppendRequest, AppendResult, LoadResult, Receipt } from "./persistence.ts";
import { SystemVersionSchema, type SessionInput } from "./types.ts";

export type CommandReceipt =
  | Readonly<{ kind: "accepted"; receipt: Receipt }>
  | Readonly<{ kind: "ignored" }>
  | Readonly<{ kind: "busy" }>
  | Readonly<{ kind: "failed"; message: string }>
  | Readonly<{ kind: "closed" }>;
export type Submission = Readonly<{ id: string; appendId: AppendId; input: SessionInput }>;
type Pending = Readonly<{
  submission: Submission;
  next: JournalState;
  request: AppendRequest;
  commands: readonly ConversationCommand[];
  attempts: number;
}>;
type Base = Readonly<{ durable: JournalState; queue: readonly Submission[] }>;
export type SessionState = Base &
  (
    | Readonly<{ status: "ready" }>
    | Readonly<{ status: "committing" | "reconciling"; pending: Pending }>
    | Readonly<{ status: "failed"; message: string }>
    | Readonly<{ status: "closed" }>
  );
export type SessionEvent =
  | { type: "submit"; submission: Submission }
  | { type: "appended"; appendId: AppendId; result: AppendResult }
  | { type: "loaded"; appendId: AppendId; result: LoadResult }
  | { type: "drain" }
  | { type: "close" };
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
function fail(state: SessionState, message: string): D {
  const submissions = [...("pending" in state ? [state.pending.submission] : []), ...state.queue];
  return {
    state: { status: "failed", durable: state.durable, queue: [], message },
    commands: [
      { type: "stop" },
      ...submissions.map((s) => reply(s.id, { kind: "failed", message })),
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
    return fail(state, "Invalid append receipt");
  return {
    state: { status: "ready", durable: p.next, queue: state.queue },
    commands: [
      { type: "dispatch", commands: p.commands, submission: p.submission, durable: p.next },
      reply(p.submission.id, { kind: "accepted", receipt }),
      { type: "drain" },
    ],
  };
}
export function decideSession(state: SessionState, event: SessionEvent): D {
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
      return { state, commands: [reply(s.id, { kind: "failed", message: state.message })] };
    // Busy is evaluated at admission, including a staged active turn.
    if (
      s.input.kind === "system" &&
      (state.durable.conversation.turn.status !== "idle" ||
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
      const next = stage(state.durable, input, s.appendId);
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
      const message = error instanceof Error ? error.message : String(error);
      if (
        s.input.kind === "tool" ||
        s.input.kind === "recovery" ||
        (s.input.kind === "event" && s.input.event.type === "child")
      ) {
        const failed = fail(state, message);
        return {
          state: failed.state,
          commands: [...failed.commands, reply(s.id, { kind: "failed", message })],
        };
      }
      return { state, commands: [reply(s.id, { kind: "failed", message })] };
    }
  }
  if (event.type === "drain") {
    if (state.status !== "ready" || !state.queue.length) return { state, commands: [] };
    const [submission, ...queue] = state.queue;
    const decision = mergeQueue(
      decideSession({ ...state, queue: [] }, { type: "submit", submission: submission! }),
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
        state: { ...state, status: "reconciling" },
        commands: [{ type: "load", appendId: event.appendId }],
      };
    return fail(
      state,
      event.result.kind === "conflict" ? "Persistence revision conflict" : event.result.message,
    );
  }
  if (event.type === "loaded" && state.status === "reconciling") {
    const loaded = event.result;
    if (loaded.kind === "failed") return fail(state, loaded.message);
    const p = state.pending;
    if (loaded.kind === "loaded") {
      try {
        if (replay(loaded.batches).revision !== loaded.revision)
          throw new Error("Load revision mismatch");
      } catch (error) {
        return fail(state, String(error));
      }
      const found = loaded.batches.find((batch) => batch.appendId === p.request.appendId);
      if (found) {
        if (
          found.expectedRevision !== p.request.expectedRevision ||
          JSON.stringify(found.records) !== JSON.stringify(p.request.records) ||
          loaded.revision !== found.revision
        )
          return fail(state, "Reconciliation content or writer conflict");
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
      return fail(state, "Unable to reconcile append");
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
        : { kind: "failed", message: decision.state.message };
    return {
      state: decision.state,
      commands: [...decision.commands, ...queue.map((submission) => reply(submission.id, result))],
    };
  }
  return { ...decision, state: { ...decision.state, queue: [...decision.state.queue, ...queue] } };
}
