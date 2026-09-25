import { defineMachine, stay, type Decision } from "../fsm/fsm.ts";
import { decideTurn, type TurnCommand, type TurnEvent, type TurnState } from "./agent-fsm.ts";
import { parseSessionContext, type SessionContext } from "./prompt.ts";
import {
  ActorIdSchema,
  SessionIdSchema,
  type ActorId,
  type AgentId,
  type Failure,
  type SessionId,
  type Steps,
  type TurnRecord,
  type UserEvent,
} from "./types.ts";

/**
 * A request to branch this conversation into a new session. It waits in `pending` until no turn is
 * active, then is answered with a {@link SessionReply}.
 * - `fork`: a child session that inherits the history and session context.
 * - `compact`: a child session whose history is empty and whose session context is replaced by `context`.
 */
export type SessionRequest =
  | Readonly<{ kind: "fork"; id: ActorId; sessionId: SessionId }>
  | Readonly<{ kind: "compact"; id: ActorId; sessionId: SessionId; context: SessionContext }>;
/**
 * State of one session's conversation: the settled turns so far and the current turn.
 * `turn` is never `done`: a finished turn is appended to `log` and replaced by a fresh idle turn.
 */
export type ConversationState = Readonly<{
  status: "open";
  sessionId: SessionId;
  /** Where the session came from; `sequence` is the parent's turn sequence at the branch point. */
  origin:
    | Readonly<{ kind: "root" }>
    | Readonly<{ kind: "fork" | "compaction"; parent: SessionId; sequence: number }>;
  context: SessionContext;
  /** Identity of the current turn, `<sessionId>/turn/<sequence>`. */
  turnId: ActorId;
  turn: Exclude<TurnState, { status: "done" }>;
  /** Records of the turns that ended in this session, oldest first. */
  log: readonly TurnRecord[];
  /** Step allowance each new turn starts with. */
  allowance: Steps;
  /** 1-based sequence number of the current turn. */
  sequence: number;
  /** Fork and compaction requests waiting for the current turn to end (not queued user input). */
  pending: readonly SessionRequest[];
}>;
/** Initial conversation state of a forked or compacted session: idle, with no pending requests. */
export type ForkSnapshot = Omit<ConversationState, "turn" | "pending"> &
  Readonly<{
    turn: Extract<TurnState, { status: "idle" }>;
    pending: readonly [];
  }>;
/** Answer to a {@link SessionRequest}, carrying the new session's initial state. */
export type SessionReply = Readonly<{ kind: "forked"; state: ForkSnapshot }>;
/** Input to the conversation machine. */
export type ConversationEvent =
  /** User input or abort, forwarded to the current turn. */
  | UserEvent
  /** Queue a fork or compaction request. */
  | { type: "request"; request: SessionRequest }
  /** Settlement of a turn's child operation; ignored unless `turnId` is the current turn. */
  | { type: "child"; turnId: ActorId; event: TurnEvent }
  /** Executing `command` threw; a turn command becomes a `failed` event for the current turn. */
  | { type: "dispatch_failed"; command: ConversationCommand; error: Failure };
/**
 * Effect the conversation asks its runtime to perform: dispatch a turn's command to the host, or
 * deliver a reply to a waiting {@link SessionRequest}.
 */
export type ConversationCommand =
  | Readonly<{ type: "turn"; turnId: ActorId; command: TurnCommand }>
  | Readonly<{ type: "reply"; requestId: ActorId; result: SessionReply }>;
type D = Decision<ConversationState, ConversationCommand>;
const turnIdentity = (session: SessionId, sequence: number) =>
  ActorIdSchema.parse(`${session}/turn/${sequence}`);

/**
 * Creates the state of a new root session with an idle first turn.
 * @param allowance Steps each turn may use.
 * @param sessionId Defaults to a random UUID.
 */
export function initialConversation(
  agent: AgentId,
  allowance: Steps,
  sessionId: SessionId = SessionIdSchema.parse(crypto.randomUUID()),
): ConversationState {
  const id = turnIdentity(sessionId, 1);
  return {
    status: "open",
    sessionId,
    origin: { kind: "root" },
    context: parseSessionContext([]),
    turnId: id,
    turn: { status: "idle", id, agent, steps: allowance },
    log: [],
    allowance,
    sequence: 1,
    pending: [],
  };
}

function advance(state: ConversationState, event: TurnEvent): D {
  if (
    event.type === "user" &&
    ["awaiting_permission", "executing_tools", "cancelling_tools"].includes(state.turn.status)
  ) {
    throw new Error("Cannot accept user input while tools are active; abort the turn first");
  }
  const decision = decideTurn(state.turn, event);
  const commands: ConversationCommand[] = decision.commands.map((command) => ({
    type: "turn",
    turnId: state.turnId,
    command,
  }));
  if (decision.state.status !== "done")
    return { state: { ...state, turn: decision.state }, commands };
  const record = decision.state.record;
  const sequence = state.sequence + 1;
  const id = turnIdentity(state.sessionId, sequence);
  return {
    state: {
      ...state,
      sequence,
      turnId: id,
      log: [...state.log, record],
      turn: { status: "idle", id, agent: record.agent, steps: state.allowance },
    },
    commands,
  };
}

/** Publish forks only between turns, without changing user input or abort semantics. */
function drain(initial: D): D {
  let state = initial.state;
  const commands = [...initial.commands];
  while (state.turn.status === "idle" && state.pending.length) {
    const idle = state.turn;
    const [branch, ...pending] = state.pending;
    if (!branch) break;
    state = { ...state, pending };
    const sequence = branch.kind === "compact" ? 1 : state.sequence;
    const id = turnIdentity(branch.sessionId, sequence);
    const fork: ForkSnapshot = {
      ...state,
      sessionId: branch.sessionId,
      sequence,
      turnId: id,
      pending: [],
      origin: {
        kind: branch.kind === "compact" ? "compaction" : "fork",
        parent: state.sessionId,
        sequence: state.sequence,
      },
      context: branch.kind === "compact" ? branch.context : state.context,
      log: branch.kind === "compact" ? [] : state.log,
      turn: { ...idle, id },
    };
    commands.push({ type: "reply", requestId: branch.id, result: { kind: "forked", state: fork } });
  }
  return { state, commands };
}

/**
 * The conversation machine: forwards user input, abort and child settlements to the current turn,
 * starts a new idle turn when one ends, and answers pending fork and compaction requests once no turn
 * is active. Turn events are unaffected by pending requests.
 * @throws When user input arrives while permission or tools are pending ("abort the turn first"),
 * and when a request reuses this session's id. The throw rejects the `send` that delivered the event.
 */
export const decideConversation = defineMachine<
  ConversationState,
  ConversationEvent,
  ConversationCommand
>({
  open: {
    user: (state, event) => drain(advance(state, event)),
    abort: (state, event) => drain(advance(state, event)),
    request: (state, event) => {
      if (event.request.sessionId === state.sessionId)
        throw new Error("A fork requires a new session identity");
      return drain({
        state: { ...state, pending: [...state.pending, event.request] },
        commands: [],
      });
    },
    child: (state, event) =>
      event.turnId === state.turnId ? drain(advance(state, event.event)) : stay(state),
    dispatch_failed: (state, event) =>
      event.command.type === "turn" && event.command.turnId === state.turnId
        ? drain(
            advance(state, {
              type: "failed",
              child: event.command.command.child,
              error: event.error,
            }),
          )
        : stay(state),
  },
});
