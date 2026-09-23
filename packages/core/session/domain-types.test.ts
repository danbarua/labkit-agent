import { expect, test } from "bun:test";

import type { PolicyPatch } from "../policy/policy.ts";
import type { EnvEvent } from "./events.ts";
import type { AppendResult, Revision } from "./persistence.ts";
import type { SessionState } from "./session-fsm.ts";
import type { StorageRef } from "./session-operation.ts";

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

function policyAssertions() {
  // @ts-expect-error Executable functions cannot enter a policy patch.
  const patch: PolicyPatch = { project: () => [] };
  // @ts-expect-error Private child events cannot be public environment events.
  const child: EnvEvent = { type: "child", event: {} };
  void patch;
  void child;
}
void policyAssertions;
