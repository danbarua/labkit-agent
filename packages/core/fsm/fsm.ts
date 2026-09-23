export type Trigger = string;

export type Transition<S extends string, C> = {
  to: S | ((ctx: C, event: any) => S);
  internal?: boolean;
  guard?: (ctx: C, event: any) => boolean | Promise<boolean>;
  effect?: (ctx: C, event: any) => C | Promise<C>;
};

export type Rule<S extends string, C> = {
  entry?: (ctx: C) => C | Promise<C>;
  exit?: (ctx: C) => C | Promise<C>;
  on: Partial<Record<Trigger, Transition<S, C>[]>>;
};

export type RuleSet<S extends string, C> = Record<S, Rule<S, C>>;

export class Machine<S extends string, C> {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private state: S,
    private ctx: C,
    private table: RuleSet<S, C>,
    private finalStates: ReadonlySet<S> = new Set(),
  ) {}

  get snapshot() {
    return { state: this.state, ctx: this.ctx };
  }

  /**
   * Enqueues one transition. Lifecycle failures reject this call without rollback:
   * exit/effect context updates remain committed; an entry failure also leaves the
   * target state selected. In-place mutations and external side effects persist.
   * Later queued events run against that partial snapshot. Actions should return
   * new contexts and convert expected I/O failures into explicit domain events.
   */
  fire<E>(trigger: Trigger, event?: E) {
    const result = this.tail.then(() => this.transition(trigger, event));
    // A rejected event must not poison later events in the mailbox.
    this.tail = result.catch(() => {});
    return result;
  }

  private async transition<E>(trigger: Trigger, event?: E) {
    if (this.finalStates.has(this.state)) {
      throw new Error(`Cannot fire ${trigger} from final state ${this.state}`);
    }

    const candidates = this.table[this.state].on[trigger] ?? [];
    for (const transition of candidates) {
      if (transition.guard && !(await transition.guard(this.ctx, event))) continue;
      const next =
        typeof transition.to === "function"
          ? transition.to(this.ctx, event)
          : transition.to;
      if (!this.table[next]) throw new Error(`Undeclared target state ${next}`);
      if (transition.internal) {
        this.ctx = (await transition.effect?.(this.ctx, event)) ?? this.ctx;
        return this.snapshot;
      }
      // Commit each lifecycle step as it succeeds; see fire() for failure semantics.
      this.ctx = (await this.table[this.state].exit?.(this.ctx)) ?? this.ctx;
      this.ctx = (await transition.effect?.(this.ctx, event)) ?? this.ctx;
      this.state = next;
      this.ctx = (await this.table[this.state].entry?.(this.ctx)) ?? this.ctx;
      return this.snapshot;
    }
    throw new Error(`No legal ${trigger} from ${this.state}`);
  }
}

type StateName = string;

export class StateBuilder<C, S extends string = StateName> {
  constructor(private rule: Rule<S, C>, private name: S) {}

  /** A self-target is explicit reentry: exit, effect, then entry. */
  on(trigger: Trigger, target: S, effect?: Transition<S, C>["effect"]) {
    this.addTransition(trigger, { to: target, effect });
    return this;
  }

  onIf(trigger: Trigger, target: S, guard: NonNullable<Transition<S, C>["guard"]>, effect?: Transition<S, C>["effect"]) {
    this.addTransition(trigger, { to: target, guard, effect });
    return this;
  }

  internal(trigger: Trigger, effect?: Transition<S, C>["effect"], guard?: Transition<S, C>["guard"]) {
    this.addTransition(trigger, { to: () => this.name, internal: true, guard, effect });
    return this;
  }

  onDynamic(
    trigger: Trigger,
    target: (ctx: C, event: any) => S,
    guard?: (ctx: C, event: any) => boolean | Promise<boolean>,
    effect?: (ctx: C, event: any) => C | Promise<C>,
  ) {
    this.addTransition(trigger, { to: target, guard, effect });
    return this;
  }

  onEntry(action: (ctx: C) => C | Promise<C>) {
    this.rule.entry = action;
    return this;
  }

  onExit(action: (ctx: C) => C | Promise<C>) {
    this.rule.exit = action;
    return this;
  }

  private addTransition(trigger: Trigger, transition: Transition<S, C>) {
    (this.rule.on[trigger] ??= []).push(transition);
  }
}

export class MachineBuilder<C, S extends string = StateName> {
  private readonly rules = new Map<S, Rule<S, C>>();
  private readonly finalStates = new Set<S>();

  constructor(private readonly initialState: S) {}

  state(name: S, configure?: (state: StateBuilder<C, S>) => unknown) {
    this.declare(name, false, configure);
    return this;
  }

  final(name: S, configure?: (state: StateBuilder<C, S>) => unknown) {
    this.declare(name, true, configure);
    return this;
  }

  build(ctx: C) {
    this.validate();
    return new Machine(
      this.initialState,
      ctx,
      Object.fromEntries(this.rules) as RuleSet<S, C>,
      this.finalStates,
    );
  }

  private declare(
    name: S,
    isFinal: boolean,
    configure?: (state: StateBuilder<C, S>) => unknown,
  ) {
    if (this.rules.has(name)) throw new Error(`State "${name}" is already declared`);
    const rule: Rule<S, C> = { on: {} };
    this.rules.set(name, rule);
    if (isFinal) this.finalStates.add(name);
    configure?.(new StateBuilder(rule, name));
  }

  private validate() {
    if (!this.rules.has(this.initialState)) {
      throw new Error(`Initial state "${this.initialState}" is not declared`);
    }

    for (const [source, rule] of this.rules) {
      if (this.finalStates.has(source) && Object.values(rule.on).some((transitions) => transitions?.length)) {
        throw new Error(`Final state "${source}" cannot have outgoing transitions`);
      }
      for (const [trigger, transitions] of Object.entries(rule.on)) {
        for (const transition of transitions ?? []) {
          if (typeof transition.to === "function") continue;
          if (!this.rules.has(transition.to)) {
            throw new Error(
              `Transition from "${source}" on "${trigger}" targets undeclared state "${transition.to}"`,
            );
          }
        }
      }
    }
  }
}


/**
 * Configure a new Machine
 *
 * @export
 * @template C 
 * @template {string} [S=StateName] 
 * @param {S} initialState 
 * @returns {MachineBuilder<C, S>} 
 */
export function configure<C, S extends string = StateName>(initialState: S) {
  return new MachineBuilder<C, S>(initialState);
}