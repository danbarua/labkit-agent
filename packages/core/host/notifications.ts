import { freeze } from "../fsm/fsm.ts";

/**
 * Delivers a display event to an optional observer sink without letting the observer affect
 * execution. Best-effort, immutable display data. Never await or route observer failures into
 * decisions. The sink receives a frozen deep copy of `event`. Throws and rejections are swallowed,
 * and an event that `structuredClone` cannot copy is silently dropped.
 */
export function notify<T>(sink: ((event: T) => unknown) | undefined, event: T): void {
  if (!sink) return;
  try {
    void Promise.resolve(sink(freeze(structuredClone(event)))).catch(() => {});
  } catch {}
}
