import { parseSessionContext } from "../../agent/prompt.ts";
import type { EnvEvent } from "../events.ts";
import type { CommandReceipt } from "../session-fsm.ts";
import type {
  EnvCommandHandle,
  EnvSettlement,
  SessionRegistry,
  SessionRuntime,
  TerminalResult,
} from "../session-runtime.ts";
import { dispatchEvent } from "./env-events.ts";
import type { SessionInstance } from "./instance.ts";

/** The public runtime of one open session; events go through {@link dispatchEvent}. */
export function createFacade(ctx: SessionInstance): SessionRuntime {
  function dispatch(raw: Extract<EnvEvent, { type: "user" }>): {
    accepted: Promise<CommandReceipt>;
    settled: Promise<TerminalResult>;
  };
  function dispatch(raw: Extract<EnvEvent, { type: "system" | "policy" | "abort" }>): {
    accepted: Promise<CommandReceipt>;
    settled: Promise<EnvSettlement>;
  };
  function dispatch(raw: unknown): EnvCommandHandle;
  function dispatch(raw: unknown): EnvCommandHandle {
    return dispatchEvent(ctx, raw);
  }
  const publishBranch = async (event: EnvEvent): Promise<SessionRuntime> => {
    const result = await dispatch(event).settled;
    if (result.kind !== "branch")
      throw new Error("message" in result ? result.message : "Branch was not published");
    return result.session;
  };
  const runtime: SessionRuntime = {
    get snapshot() {
      return ctx.actor.snapshot;
    },
    get lastCompletionUsage() {
      return ctx.actor.snapshot.durable.lastCompletionUsage;
    },
    get registry(): SessionRegistry {
      return ctx.adoption.plan
        ? { kind: "pending_adoption", differences: ctx.adoption.plan.differences }
        : { kind: "current" };
    },
    get policy() {
      return ctx.adoption.plan?.body.policy ?? ctx.actor.snapshot.durable.policy;
    },
    get model() {
      const { conversation } = ctx.actor.snapshot.durable;
      const policy = runtime.policy;
      // A pending adoption may switch an unregistered agent; describe what the next turn uses.
      const agent =
        conversation.turn.status === "idle"
          ? (ctx.adoption.plan?.body.agent ?? conversation.turn.agent)
          : conversation.turn.turn.agent;
      return policy?.provider
        ? ctx.configured.describeModel?.(
            policy.provider,
            policy.model ?? ctx.configured.agents.get(agent)!.model,
          )
        : undefined;
    },
    dispatch,
    fire: (raw) => dispatch(raw).accepted,
    input: (input) =>
      dispatch(
        typeof input === "string" ? { type: "user", text: input } : { ...input, type: "user" },
      ),
    updateSystem: (inputs) => dispatch({ type: "system", inputs }).accepted,
    updatePolicy: (patch) => dispatch({ type: "policy", patch }).accepted,
    fork: () => publishBranch({ type: "fork" }),
    compact: (context) => {
      const validated = parseSessionContext(context);
      return publishBranch({ type: "compact", context: validated });
    },
    async close() {
      await dispatch({ type: "close" }).accepted;
    },
  };
  return runtime;
}
