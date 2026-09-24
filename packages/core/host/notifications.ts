import { freeze } from "../fsm/fsm.ts";

/** Best-effort, immutable display data. Never await or route observer failures into decisions. */
export function notify<T>(sink: ((event: T) => unknown) | undefined, event: T): void {
  if (!sink) return;
  try {
    void Promise.resolve(sink(freeze(structuredClone(event)))).catch(() => {});
  } catch {}
}
