import type { AgentActions } from "./agent-fsm.ts";
import type { AgentContext } from "./types.ts";

export const context = (): AgentContext => ({
  agent: "writer", messages: [], pendingTools: [], budget: { steps: 3, usd: 1 },
});

/** Explicit inert host for tests of the transition table alone. */
export const actions = (overrides: Partial<AgentActions> = {}): AgentActions => ({
  startCompletion: ctx => ctx,
  runTools: ctx => ctx,
  cancel: ctx => ctx,
  canHandoff: agent => agent === "reviewer",
  canRunTools: ctx => ctx.pendingTools.every(call => call.name === "search"),
  swapAgent: (ctx, agent) => ({ ...ctx, agent }),
  ...overrides,
});
