import { diagnostic } from "../logging/index.ts";
import type { SessionId } from "../agent/types.ts";
import { Actor, type Decision } from "../fsm/fsm.ts";
import {
  AppendResultSchema,
  LoadResultSchema,
  type AppendRequest,
  type AppendResult,
  type LoadResult,
  type SessionPersistence,
} from "./persistence.ts";

export type StorageRef = Readonly<{ kind: "load" | "append"; id: string }>;
export type StorageState<T> =
  | Readonly<{ status: "ready"; ref: StorageRef; cancellationRequested: boolean }>
  | Readonly<{ status: "running"; ref: StorageRef; cancellationRequested: boolean }>
  | Readonly<{ status: "settled"; ref: StorageRef; result: T }>;
/** Based on agent/operation-actor.ts. Cancellation signals I/O but never certifies rollback. */
function operation<T>(
  ref: StorageRef,
  run: (signal: AbortSignal) => Promise<T>,
  failed: (error: unknown) => T,
  sessionId: SessionId,
) {
  type Event = { type: "start" } | { type: "cancel" } | { type: "settled"; result: T };
  type Command = { type: "run" } | { type: "cancel" } | { type: "notify"; result: T };
  const controller = new AbortController();
  let resolve!: (result: T) => void;
  const result = new Promise<T>((done) => {
    resolve = done;
  });
  const decide = (state: StorageState<T>, event: Event): Decision<StorageState<T>, Command> => {
    if (state.status === "settled") return { state, commands: [] };
    if (event.type === "cancel")
      return { state: { ...state, cancellationRequested: true }, commands: [{ type: "cancel" }] };
    if (event.type === "start" && state.status === "ready")
      return {
        state: { status: "running", ref, cancellationRequested: state.cancellationRequested },
        commands: [{ type: "run" }],
      };
    if (event.type === "settled")
      return {
        state: { status: "settled", ref, result: event.result },
        commands: [{ type: "notify", result: event.result }],
      };
    return { state, commands: [] };
  };
  const actor = new Actor<StorageState<T>, Event, Command>(
    { status: "ready", ref, cancellationRequested: false },
    decide,
    (command) => {
      if (command.type === "cancel") {
        diagnostic("persistence", "debug", "storage.cancellation_requested", {
          sessionId,
          operation: ref.kind,
          appendId: ref.kind === "append" ? ref.id : undefined,
        });
        controller.abort();
      }
      if (command.type === "notify") resolve(command.result);
      if (command.type === "run")
        void Promise.resolve()
          .then(() => run(controller.signal))
          .catch(failed)
          .then((result) => actor.send({ type: "settled", result }));
      return undefined;
    },
    (_, error) => ({ type: "settled", result: failed(error) }),
  );
  return {
    get snapshot() {
      return actor.snapshot;
    },
    result,
    start: () => actor.send({ type: "start" }),
    cancel: () => actor.send({ type: "cancel" }),
  };
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
export function appendOperation(port: SessionPersistence, request: AppendRequest) {
  return operation<AppendResult>(
    { kind: "append", id: request.appendId },
    async (signal) => {
      diagnostic("persistence", "debug", "append.started", {
        sessionId: request.sessionId,
        appendId: request.appendId,
        expectedRevision: request.expectedRevision,
        count: request.records.length,
      });
      const result = AppendResultSchema.parse(await port.append(request, signal));
      diagnostic(
        "persistence",
        result.kind === "committed" ? "debug" : "warning",
        "append.settled",
        {
          sessionId: request.sessionId,
          appendId: request.appendId,
          outcome: result.kind,
          revision: result.kind === "committed" ? result.receipt.revision : undefined,
        },
      );
      return result;
    },
    (error) => {
      diagnostic("persistence", "warning", "append.indeterminate", {
        sessionId: request.sessionId,
        appendId: request.appendId,
      });
      return { kind: "indeterminate", message: message(error) };
    },
    request.sessionId,
  );
}
export function loadOperation(port: SessionPersistence, sessionId: SessionId) {
  return operation<LoadResult>(
    { kind: "load", id: sessionId },
    async (signal) => {
      diagnostic("persistence", "debug", "load.started", { sessionId });
      const result = LoadResultSchema.parse(await port.load(sessionId, signal));
      diagnostic("persistence", result.kind === "failed" ? "warning" : "debug", "load.settled", {
        sessionId,
        outcome: result.kind,
        revision: result.kind === "loaded" ? result.revision : undefined,
      });
      return result;
    },
    (error) => {
      diagnostic("persistence", "warning", "load.failed", { sessionId });
      return { kind: "failed", message: message(error) };
    },
    sessionId,
  );
}
export async function loadSession(port: SessionPersistence, sessionId: SessionId) {
  const actor = loadOperation(port, sessionId);
  await actor.start();
  return actor.result;
}
