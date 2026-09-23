import {
  createSession,
  type BoundSessionOptions,
  type EnvReceipt,
  type EnvSettlement,
  type SessionRuntime,
} from "../session/session-runtime.ts";
import type { EnvEvent } from "../session/events.ts";
import type { SessionState } from "../session/session-fsm.ts";

export type EnvironmentUpdate =
  | Readonly<{ kind: "snapshot"; snapshot: SessionState }>
  | Readonly<{ kind: "receipt"; event: EnvEvent; receipt: EnvReceipt }>
  | Readonly<{ kind: "settled"; event: EnvEvent; outcome: EnvSettlement }>;
export type Environment = Readonly<{
  events: AsyncIterable<EnvEvent>;
  render: (update: EnvironmentUpdate) => void | Promise<void>;
}>;
/** The source owns interaction timing. This loop only waits for admission, never turn completion. */
export async function runEnvironment(session: SessionRuntime, environment: Environment) {
  const settlements = new Set<Promise<void>>();
  let settlementError: unknown;
  let rendering = Promise.resolve();
  const render = (update: EnvironmentUpdate) => {
    const next = rendering.then(() => environment.render(update));
    rendering = next.catch(() => {});
    return next;
  };
  try {
    for await (const event of environment.events) {
      const handle = session.dispatch(event);
      const settled = handle.settled.then((outcome) => render({ kind: "settled", event, outcome }));
      settlements.add(settled);
      void settled.then(
        () => settlements.delete(settled),
        (error) => {
          settlements.delete(settled);
          settlementError ??= error;
        },
      );
      await render({ kind: "receipt", event, receipt: await handle.accepted });
      if (event.type === "close") break;
    }
  } finally {
    await session.close();
    await Promise.allSettled(settlements);
    await rendering;
  }
  if (settlementError) throw settlementError;
}
/** Bind before construction so initial commits are observable too. No phase decisions live here. */
export async function startEnvironment(options: BoundSessionOptions, environment: Environment) {
  let observing = Promise.resolve();
  const originalObserve = options.bindings.observe;
  const originalRender = environment.render;
  const render = (update: EnvironmentUpdate) => {
    const next = observing.then(() => originalRender(update));
    observing = next.catch(() => {});
    return next;
  };
  const session = await createSession({
    ...options,
    bindings: {
      ...options.bindings,
      observe: (snapshot) => {
        try {
          const result = originalObserve?.(snapshot);
          if (result instanceof Promise) void result.catch(() => {});
        } catch {
          /* Observer isolation. */
        }
        void render({ kind: "snapshot", snapshot }).catch(() => {});
      },
    },
  });
  try {
    await runEnvironment(session, { ...environment, render });
  } finally {
    await observing;
  }
  return session;
}
