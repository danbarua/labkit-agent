import { type AgentContext, type AgentEvent, type AgentMachine } from "./agent-fsm.ts";
import type { CompletionStatus } from "./types.ts";

export type ConversationEvent =
  | { type: "user"; text: string }
  | { type: "abort" }
  | { type: "agent"; turnId: number; operationId?: number; event: AgentEvent };

export type TurnRecord = Readonly<{
  agent: string;
  messages: ReadonlyArray<Readonly<AgentContext["messages"][number]>>;
  completion: CompletionStatus;
  error?: string;
}>;

export type ConversationSnapshot = Readonly<{
  turnId: number;
  child: AgentMachine;
  agentContext: AgentContext;
  log: ReadonlyArray<TurnRecord>;
}>;

export type ConversationMachine = {
  readonly snapshot: ConversationSnapshot;
  fire(event: ConversationEvent): Promise<ConversationSnapshot>;
};

export type ConversationActions = {
  createAgentMachine: (context: AgentContext, turnId: number) => AgentMachine;
};

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freezeDeep(item);
    Object.freeze(value);
  }
  return value;
}

export function createConversationMachine(
  initialContext: AgentContext,
  actions: ConversationActions,
): ConversationMachine {
  const budget = { ...initialContext.budget };
  let turnId = 1;
  const fresh = (agent: string): AgentContext => ({
    agent, messages: [], pendingTools: [], budget: { ...budget },
  });
  let child = actions.createAgentMachine({
    ...fresh(initialContext.agent), messages: structuredClone(initialContext.messages),
  }, turnId);
  let log: ReadonlyArray<TurnRecord> = Object.freeze([]);
  let tail: Promise<unknown> = Promise.resolve();
  const snapshot = (): ConversationSnapshot => ({ turnId, child, agentContext: child.snapshot.ctx, log });

  async function dispatch(event: ConversationEvent) {
    if (event.type === "agent") {
      // Check at dequeue time, after any preceding cancellation or child replacement.
      if (event.turnId !== turnId || (event.operationId !== undefined &&
          event.operationId !== child.snapshot.ctx.operation?.id)) return snapshot();
      const childEvent = event.event;
      if (childEvent.type === "tool_done" &&
          !child.snapshot.ctx.pendingTools.some(call => call.id === childEvent.id)) return snapshot();
      await child.fire(event.event.type, event.event);
    } else {
      await child.fire(event.type, event);
    }
    if (child.snapshot.state === "done") {
      const ctx = child.snapshot.ctx;
      if (!ctx.completion) throw new Error("Terminal turn has no completion reason");
      const record: TurnRecord = freezeDeep({
        agent: ctx.agent, messages: structuredClone(ctx.messages), completion: ctx.completion,
        ...(ctx.error === undefined ? {} : { error: ctx.error }),
      });
      log = Object.freeze([...log, record]);
      child = actions.createAgentMachine(fresh(ctx.agent), ++turnId);
    }
    return snapshot();
  }
  return {
    get snapshot() { return snapshot(); },
    fire(event) {
      const result = tail.then(() => dispatch(event));
      tail = result.catch(() => {});
      return result;
    },
  };
}
