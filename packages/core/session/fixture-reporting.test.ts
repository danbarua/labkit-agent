import { expect, test } from "@logtape/testing-bun/autoload";

import { runFixture } from "./fixture-runner.ts";
import { plainConversationV1 } from "./fixtures/conversation.ts";
import { interruptedRecoveryV1, rejectedAppendV1 } from "./fixtures/persistence.ts";
import { partialCancellationLateResultV1, permissionRejectBatchV2 } from "./fixtures/tools.ts";
import { createSession } from "./session-runtime.ts";

const directory = ".session-artifacts/reporting";

test("conversation reports introduce actors, quote messages, and explain identical restored views", async () => {
  const result = await runFixture(plainConversationV1, {
    artifactDirectory: `${directory}/conversation`,
  });
  expect(result.report).toContain(plainConversationV1.purpose);
  expect(result.report).toContain("Executable example:");
  expect(result.report).toContain("captured before cleanup");
  expect(result.transcript).toContain("Primary assistant (agent ID: a)");
  expect(result.transcript).toContain("### User\n\n> Hi");
  expect(result.transcript).toContain("### Assistant\n\n> Hello");
  expect(result.transcript).toContain("Same session ID and durable state");
  expect(result.transcript.match(/> Hello/g)).toHaveLength(1);
  expect(result.transcript).not.toContain('"role":');
  expect(result.report).not.toContain('"messages":');
});

test("refusal report explains the batch failure and shows approval decisions beside readable tools", async () => {
  const result = await runFixture(permissionRejectBatchV2, {
    artifactDirectory: `${directory}/refusal`,
  });
  expect(result.transcript).toContain("**Tool call: echo** (call ID: one)");
  expect(result.transcript).toContain('```json\n{\n  "text": "one"\n}\n```');
  expect(result.transcript).toContain("Call one: **allow_once**");
  expect(result.transcript).toContain("Call two: **reject_once**");
  expect(result.transcript).toContain("failed — Tool permission rejected");
  expect(result.report).toContain("No tool executes without batch approval");
  expect(result.transcript).not.toContain("durable state changed during recovery");
});

test("recovery report distinguishes interrupted work, committed partial results, and a recovered terminal", async () => {
  const result = await runFixture(interruptedRecoveryV1, {
    artifactDirectory: `${directory}/recovery`,
  });
  expect(result.transcript).toContain("Unfinished turn — executing_tools");
  expect(result.transcript).toContain("Committed partial tool outcome");
  expect(result.transcript).toContain("Tool result — call fast");
  expect(result.transcript).toContain("Interrupted session; external effects were not replayed");
  expect(result.report).toContain("Provider request count is unchanged by restore");
});

test("a failed named assertion fails the runner after preserving its report, evidence, and cleanup logs", async () => {
  const location = `${directory}/deliberate-failure`;
  const scenario = {
    ...plainConversationV1,
    name: "deliberate-failure",
    async run(f: Parameters<typeof plainConversationV1.run>[0]) {
      f.track("root", await createSession(f.options));
      f.action("Demonstrate how an incorrect expectation is reported.");
      f.check(
        "A new session has no completed turns",
        f.sessions.get("root")!.snapshot.durable.conversation.log.length,
        99,
      );
    },
  };
  await expect(
    runFixture(scenario, { artifactDirectory: location, compareBaseline: false }),
  ).rejects.toThrow("A new session has no completed turns");
  const report = await Bun.file(`${location}/README.md`).text();
  expect(report).toContain("**FAIL**");
  expect(report).toContain("Expected: 99; observed: 0");
  const error = await Bun.file(`${location}/evidence/error.json`).json();
  expect(error.message).toContain("A new session has no completed turns");
  expect(error.stack).toContain("fixture-reporting.test.ts");
  expect(await Bun.file(`${location}/diagnostics.log`).text()).toContain("host.closed");
  expect(await Bun.file(`${location}/evidence/journal-root.jsonl`).exists()).toBe(true);
  // Reusing an artifact directory must not leave a stale failure behind.
  await runFixture(plainConversationV1, { artifactDirectory: location });
  expect(await Bun.file(`${location}/evidence/error.json`).exists()).toBe(false);
});

test("a baseline mismatch names the evidence field and preserves expected and observed values", async () => {
  const location = `${directory}/deliberate-baseline-mismatch`;
  await expect(
    runFixture(
      {
        ...plainConversationV1,
        purpose: "Deliberately change the first answer to verify behavioral mismatch reporting.",
        dependencies: {
          completions: [
            { kind: "answer", text: "Changed answer" },
            { kind: "answer", text: "Again" },
          ],
        },
      },
      { artifactDirectory: location },
    ),
  ).rejects.toThrow("Exact requests match the approved behavioral evidence");
  const error = await Bun.file(`${location}/evidence/error.json`).json();
  expect(error.message).toContain("Changed answer");
  expect(error.message).toContain("Hello");
  expect(error.message).toContain("$.1.messages");
  expect(await Bun.file(`${location}/README.md`).text()).toContain("**FAIL**");
});

test("cancelled work and a rejected admission are explained as expected outcomes", async () => {
  const cancelled = await runFixture(partialCancellationLateResultV1, {
    artifactDirectory: `${directory}/cancelled`,
  });
  expect(cancelled.transcript).toContain("aborted — turn cancelled");
  expect(cancelled.transcript).not.toContain("> late");
  const rejected = await runFixture(rejectedAppendV1, {
    artifactDirectory: `${directory}/rejected`,
  });
  expect(rejected.report).toContain("**PASS**");
  expect(rejected.report).toContain("Input admission is failed");
  expect(rejected.transcript).toContain("No terminal turns have been committed");
});
