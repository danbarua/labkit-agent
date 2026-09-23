import { ActorIdSchema, AgentIdSchema, StepsSchema, type TurnData } from "./types.ts";

export const context = (): TurnData => ({
  id: ActorIdSchema.parse("turn/1"),
  generation: 0,
  agent: AgentIdSchema.parse("writer"),
  steps: StepsSchema.parse(6),
  messages: [],
  view: { kind: "history" },
});
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("Actor did not reach the expected state");
}
