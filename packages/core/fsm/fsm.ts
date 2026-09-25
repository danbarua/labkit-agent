/**
 * The entire next state and its post-commit commands form one synchronous decision.
 * {@link Actor.send} installs (freezes) `state` before it runs any of `commands`, so a command
 * whose adapter reports back immediately already sees the state this decision installed.
 */
export type Decision<S, C> = Readonly<{ state: S; commands: readonly C[] }>;
/** A {@link Decision} that keeps `state` unchanged and issues no commands. */
export const stay = <S, C = never>(state: S): Decision<S, C> => ({ state, commands: [] });

/**
 * Transition table for {@link defineMachine}, keyed by state `status`, then by event `type`.
 * Each handler receives the state and event narrowed to its row and column and returns the complete
 * {@link Decision}. A missing entry means the event is ignored in that status.
 */
export type Rules<S extends { status: string }, E extends { type: string }, C> = {
  [P in S["status"]]: {
    [T in E["type"]]?: (
      state: Extract<S, { status: P }>,
      event: Extract<E, { type: T }>,
    ) => Decision<S, C>;
  };
};

/**
 * Builds a pure reducer from a {@link Rules} table.
 * Missing edges ignore irrelevant or late messages, including messages to terminal actors: the
 * reducer then returns {@link stay} (the same state object, no commands). Handlers must not mutate
 * state or start I/O; effects belong in the returned commands.
 */
export function defineMachine<S extends { status: string }, E extends { type: string }, C>(
  rules: Rules<S, E, C>,
) {
  return (state: S, event: E): Decision<S, C> => {
    // The table indexes both discriminants; the public rule type enforces each handler's inputs.
    const row = rules[state.status as S["status"]] as Partial<
      Record<E["type"], (s: S, e: E) => Decision<S, C>>
    >;
    return row[event.type as E["type"]]?.(state, event) ?? stay(state);
  };
}

/**
 * Deep-freezes `value` in place and returns it.
 * Domain snapshots contain data, not controllers, callbacks, maps or mutable resources. Only own
 * enumerable property values are traversed, so the entries of a Map or Set stay mutable, and
 * functions are not frozen. Cyclic references are handled.
 */
export function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value)) freeze(child, seen);
    Object.freeze(value);
  }
  return value;
}

/**
 * Serialized mailbox around a pure reducer: events are decided one at a time, in `send` order.
 * Each decision's state is installed before its commands run.
 *
 * @param initial - Frozen and installed as the first snapshot.
 * @param decide - Pure reducer, usually from {@link defineMachine}.
 * @param execute - Dispatches one command synchronously. Asynchronous work must report back later
 *   through {@link Actor.send}.
 * @param commandFailed - Turns a synchronous throw from `execute` into a new event for this actor.
 *   The event is queued after the current one; it does not roll back the installed state or the
 *   commands already dispatched.
 */
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

  /**
   * The last installed state, deeply frozen. Events still queued in the mailbox are not reflected.
   */
  get snapshot(): S {
    return this.state;
  }

  /**
   * Queues `event` in the mailbox. Pure reduction commits once. Commands cannot run until the
   * entire decision succeeds.
   *
   * @returns Resolves with the state this event installed, once its commands have been dispatched
   *   (not when their asynchronous work finishes). Any `commandFailed` event is decided later and
   *   is not reflected. Rejects when `decide` throws; the state is then unchanged and later events
   *   are still processed.
   */
  send(event: E): Promise<S> {
    const result = this.tail.then(() => {
      const decision = this.decide(this.state, event);
      this.state = freeze(decision.state);
      for (const command of decision.commands) {
        try {
          this.execute(command);
        } catch (error) {
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
