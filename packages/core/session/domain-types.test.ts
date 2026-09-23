import { expect, test } from "bun:test";
import type { AppendResult, Revision } from "./persistence.ts";
import type { StorageRef } from "./session-operation.ts";
import type { SessionState } from "./session-fsm.ts";
// Compile-time assertions; bunx tsc --noEmit is required in addition to the test runner.
function assertions(state: SessionState, result: AppendResult) {
  // @ts-expect-error A plain number is not a journal revision.
  const revision: Revision = 1;
  // @ts-expect-error Storage operations cannot masquerade as completions.
  const storage: StorageRef = { kind: "completion", id: "x" };
  // @ts-expect-error Committing states require the staged batch and commands.
  const committing: SessionState = { status: "committing", durable: state.durable, queue: [] };
  switch (result.kind) {
    case "committed":
    case "conflict":
    case "rejected":
      break;
    default: {
      // @ts-expect-error Indeterminate outcomes must be explicitly handled.
      const exhausted: never = result;
      void exhausted;
    }
  }
  void revision;
  void storage;
  void committing;
}
test("domain assertions are checked by TypeScript", () => {
  expect(typeof assertions).toBe("function");
});
