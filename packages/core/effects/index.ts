import { diagnostic, type DiagnosticFields, type LogLevel } from "../logging/index.ts";

/**
 * Effect event names the runtime knows about today. The type also accepts any other string, so an
 * environment or a later core module can introduce a new effect name without widening this union;
 * `type` still narrows to these literals wherever a call site names one of them.
 */
export type KnownEffectEventName =
  | "child.started"
  | "child.failed"
  | "child.cancelled"
  | "child.settled"
  | "child.timed_out"
  | "child.cancellation_requested"
  | "command.dispatched"
  | "tool.admitted"
  | "tool.locations_resolved"
  | "tool.locations_failed"
  | "tool.awaiting_release"
  | "tool.released"
  | "tool.status_changed"
  | "tool.input_rejected"
  | "permission.waiting"
  | "permission.reused"
  | "permission.decided"
  | "permission.refused"
  | "permission.granted"
  | "permission.grants_cleared"
  | "completion.system_prompt"
  | "completion.usage.received"
  | "provider.http.started"
  | "provider.http.received"
  | "provider.http.rejected"
  | "provider.http.completed"
  | "provider.http.cancelled"
  | "provider.http.failed"
  | "provider.stream.started"
  | "provider.stream.completed"
  | "provider.stream.cancelled"
  | "provider.stream.failed"
  | "provider.completion.started"
  | "provider.completion.completed"
  | "provider.completion.cancelled"
  | "provider.completion.failed"
  | "provider.usage.invalid"
  | "host.closed";

/** Open string union: known names narrow, unknown ones still type-check. */
export type EffectEventName = KnownEffectEventName | (string & {});

/**
 * One effect: an interaction the runtime had with the outside world, or the lifecycle of an
 * operation boundary (a child operation, a tool call, a permission question, a provider HTTP
 * request or stream). `fields` carries whatever correlation IDs are known at that boundary
 * (session, turn, operation/child, tool call, HTTP request, append) alongside the event's own
 * data, the same structured bag `diagnostic()` accepts.
 *
 * Effects are emitted only at operation boundaries: the host's child lifecycle, command dispatch,
 * the tool runner, permission decisions, and the provider transport around fetch. Pure decisions
 * and the journal fold never emit; the fold also runs on load, where nothing happens.
 */
export type EffectEvent = Readonly<{
  category: string;
  level: LogLevel;
  type: EffectEventName;
  fields: DiagnosticFields;
}>;

/**
 * Cross-cutting subscriber: logging, traffic capture, usage/cost accounting, auditing, hooks.
 * Adding one changes no core code; supply it through `ExecutionBindings.effects` (host-level
 * events) and `TransportBinding.effects` (provider transport events). Best-effort: a throwing
 * subscriber must not affect execution, so callers should combine subscribers with
 * {@link fanoutEffects} rather than let one exception drop the rest.
 */
export type EffectEmitter = (event: EffectEvent) => void;

/**
 * Convenience shape matching `diagnostic(category, level, event, fields)` exactly, so a call site
 * that used to log directly can bind one of these (see {@link boundEmitter}) and keep its
 * arguments unchanged.
 */
export type EmitEffect = (
  category: string,
  level: LogLevel,
  type: EffectEventName,
  fields?: DiagnosticFields,
) => void;

/** An emitter that discards every event; the default when no subscriber is bound. */
export const noopEffects: EffectEmitter = () => {};

/** Combines subscribers so each event reaches every one of them once, in order. */
export function fanoutEffects(...emitters: readonly (EffectEmitter | undefined)[]): EffectEmitter {
  const live = emitters.filter((emitter): emitter is EffectEmitter => !!emitter);
  if (live.length === 0) return noopEffects;
  if (live.length === 1) return (event) => live[0]!(event);
  return (event) => {
    for (const emitter of live) {
      try {
        emitter(event);
      } catch {
        // Best-effort, like diagnostic(): a subscriber failure never affects execution.
      }
    }
  };
}

/**
 * The default subscriber: produces the same `diagnostic()` records the runtime always has, from
 * the emitted events. Logging is a consumer of effects, not a second emission path; installing it
 * is how existing log assertions keep passing after this module took over emission.
 */
export function diagnosticsSubscriber(): EffectEmitter {
  return (event) => diagnostic(event.category, event.level, event.type, event.fields);
}

/**
 * Emits one effect. At every site that used to call `diagnostic(category, level, event, fields)`
 * directly, this is the same call shape; the default subscriber reproduces that exact record.
 */
export function emitEffect(
  emit: EffectEmitter,
  category: string,
  level: LogLevel,
  type: EffectEventName,
  fields: DiagnosticFields = {},
): void {
  emit({ category, level, type, fields });
}

/**
 * Binds one {@link EffectEmitter} into the {@link EmitEffect} call shape, so every operation
 * boundary that previously called `diagnostic(category, level, event, fields)` can call this
 * instead, unchanged apart from the function name.
 */
export function boundEmitter(emit: EffectEmitter): EmitEffect {
  return (category, level, type, fields) => emitEffect(emit, category, level, type, fields);
}
