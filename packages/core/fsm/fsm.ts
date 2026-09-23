/** The entire next state and its post-commit commands form one synchronous decision. */
export type Decision<S, C> = Readonly<{ state: S; commands: readonly C[] }>;
export const stay = <S, C = never>(state: S): Decision<S, C> => ({ state, commands: [] });

export type Rules<S extends { status: string }, E extends { type: string }, C> = {
  [P in S["status"]]: {
    [T in E["type"]]?: (state: Extract<S, { status: P }>, event: Extract<E, { type: T }>) => Decision<S, C>;
  };
};

/** Missing edges ignore irrelevant or late messages, including messages to terminal actors. */
export function defineMachine<S extends { status: string }, E extends { type: string }, C>(rules: Rules<S, E, C>) {
  return (state: S, event: E): Decision<S, C> => {
    // The table indexes both discriminants; the public rule type enforces each handler's inputs.
    const row = rules[state.status as S["status"]] as Partial<Record<E["type"], (s: S, e: E) => Decision<S, C>>>;
    return row[event.type as E["type"]]?.(state, event) ?? stay(state);
  };
}

/** Domain snapshots contain data, not controllers, callbacks, maps or mutable resources. */
export function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value)) freeze(child, seen);
    Object.freeze(value);
  }
  return value;
}

export class Actor<S, E, C> {
  private tail: Promise<unknown> = Promise.resolve();
  private state: S;

  constructor(
    initial: S,
    private readonly decide: (state: S, event: E) => Decision<S, C>,
    private readonly execute: (command: C) => undefined,
    private readonly commandFailed: (command: C, error: unknown) => E,
  ) {
    this.state = freeze(initial);
  }

  get snapshot(): S { return this.state; }

  /** Pure reduction commits once. Commands cannot run until the entire decision succeeds. */
  send(event: E): Promise<S> {
    const result = this.tail.then(() => {
      const decision = this.decide(this.state, event);
      this.state = freeze(decision.state);
      for (const command of decision.commands) {
        try { this.execute(command); }
        catch (error) {
          // This is a new domain event, not rollback of already dispatched commands.
          void this.send(this.commandFailed(command, error));
        }
      }
      return this.state;
    });
    this.tail = result.catch(() => {});
    return result;
  }
}
