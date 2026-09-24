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

export type SessionRequest =
  | Readonly<{ kind: "fork"; id: ActorId; sessionId: SessionId }>
  | Readonly<{ kind: "compact"; id: ActorId; sessionId: SessionId; context: SessionContext }>;
export type ConversationState = Readonly<{
  status: "open";
  sessionId: SessionId;
  origin:
    | Readonly<{ kind: "root" }>
    | Readonly<{ kind: "fork" | "compaction"; parent: SessionId; sequence: number }>;
  context: SessionContext;
  turnId: ActorId;
  turn: Exclude<TurnState, { status: "done" }>;
  log: readonly TurnRecord[];
  allowance: Steps;
  sequence: number;
  pending: readonly SessionRequest[];
}>;
export type ForkSnapshot = Omit<ConversationState, "turn" | "pending"> &
  Readonly<{
    turn: Extract<TurnState, { status: "idle" }>;
    pending: readonly [];
  }>;
export type SessionReply = Readonly<{ kind: "forked"; state: ForkSnapshot }>;
export type ConversationEvent =
  | UserEvent
  | { type: "request"; request: SessionRequest }
  | { type: "child"; turnId: ActorId; event: TurnEvent }
  | { type: "dispatch_failed"; command: ConversationCommand; error: Failure };
export type ConversationCommand =
  | Readonly<{ type: "turn"; turnId: ActorId; command: TurnCommand }>
  | Readonly<{ type: "reply"; requestId: ActorId; result: SessionReply }>;
type D = Decision<ConversationState, ConversationCommand>;
const turnIdentity = (session: SessionId, sequence: number) =>
  ActorIdSchema.parse(`${session}/turn/${sequence}`);

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

/** Turn events continue normally while fork/compaction requests wait for Done. */
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
