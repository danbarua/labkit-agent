import { reduceConfiguration, reducePolicy, reduceSystem } from "./reduce-boundary.ts";
import { reduceEvent } from "./reduce-event.ts";
import { reduceDequeued, reduceInputCancelled, reduceQueued } from "./reduce-queue.ts";
import { reduceRecovery, reduceTool } from "./reduce-tools.ts";
import { accepts, missingTarget } from "./shared.ts";
import type { Fold, JournalState, Reducer, ReducibleBody, Reduction } from "./state.ts";

const reducers: { readonly [K in ReducibleBody["kind"]]: Reducer<K> } = {
  policy: reducePolicy,
  configuration: reduceConfiguration,
  system: reduceSystem,
  queued: reduceQueued,
  input_cancelled: reduceInputCancelled,
  dequeued: reduceDequeued,
  tool: reduceTool,
  recovery: reduceRecovery,
  event: reduceEvent,
};

/**
 * Applies one journal body to the state through its registered reducer. Staging first requires
 * the input to be accepted by the commit-time rules; loading only requires its target to exist.
 */
export function reduce(state: JournalState, input: ReducibleBody, fold: Fold): Reduction {
  if (fold.mode === "stage") {
    if (!accepts(state, input)) throw new Error("Stale or uncorrelated journal input");
  } else {
    const missing = missingTarget(state, input);
    if (missing) throw new Error(missing);
  }
  return (reducers[input.kind] as Reducer<typeof input.kind>)(state, input as never, fold);
}
