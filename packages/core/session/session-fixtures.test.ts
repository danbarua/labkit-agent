import { expect, test } from "@logtape/testing-bun/autoload";

import { runFixtures } from "./fixture-runner.ts";

type DiagnosticRecord = { level: string } & Record<string, unknown>;
async function diagnostics(directory: string, scenario: string): Promise<DiagnosticRecord[]> {
  const text = await Bun.file(`${directory}/${scenario}/diagnostics.jsonl`).text();
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}
async function assertDiagnosticArtifacts(directory: string, runId: string) {
  const records = await diagnostics(directory, "plain-conversation");
  const aliases = await Bun.file(`${directory}/plain-conversation/session-aliases.json`).json();
  const journal = (await Bun.file(`${directory}/plain-conversation/journal-root.jsonl`).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const sessionId = Object.keys(aliases)[0]!;
  expect(aliases[sessionId]).toContain("root");
  expect(
    records.every((record) => record.runId === runId && record.scenario === "plain-conversation"),
  ).toBe(true);
  const terminal = records.find((record) => record.event === "turn.settled")!;
  expect(terminal.sessionId).toBe(sessionId);
  expect(
    journal.some(
      (record) => record.body.kind === "terminal" && record.body.turnId === terminal.turnId,
    ),
  ).toBe(true);
  expect(
    records.some((record) => record.level === "debug" && record.event === "append.started"),
  ).toBe(true);
  expect(records.some((record) => record.event === "host.closed")).toBe(true);
  const readable = await Bun.file(`${directory}/plain-conversation/diagnostics.log`).text();
  expect(readable).toContain(sessionId);
  expect(readable).toContain("turn.settled");
  expect(readable).toContain(runId);
  const rejected = await diagnostics(directory, "rejected-append");
  expect(
    rejected.some(
      (record) =>
        record.event === "append.settled" &&
        record.outcome === "rejected" &&
        record.reason === "Scripted rejected append",
    ),
  ).toBe(true);
  const failure = await diagnostics(directory, "failure");
  expect(
    failure.some((record) => record.event === "child.failed" && record.error !== undefined),
  ).toBe(true);
  expect(
    failure.some((record) => record.event === "turn.settled" && record.outcome === "failed"),
  ).toBe(true);
}

test("approved structured and readable fixtures match across repeated deterministic runs", async () => {
  const first = await runFixtures({ artifactDirectory: ".session-artifacts/test-first" });
  const second = await runFixtures({ artifactDirectory: ".session-artifacts/test-second" });
  expect(first.count).toBe(17);
  await assertDiagnosticArtifacts(first.artifactDirectory, first.runId);
  expect(second.runId).not.toBe(first.runId);
  expect(second.structured).toBe(first.structured);
  expect(second.markdown).toBe(first.markdown);
});

test("version-two policy fixtures are independent of the unchanged version-one baseline", async () => {
  const first = await runFixtures({ version: 2, artifactDirectory: ".session-artifacts/v2-first" });
  const second = await runFixtures({
    version: 2,
    artifactDirectory: ".session-artifacts/v2-second",
  });
  expect(first.count).toBe(22);
  const records = await diagnostics(first.artifactDirectory, "permission-reject-batch");
  expect(
    records.some(
      (record) => record.event === "permission.decided" && record.decision === "reject_once",
    ),
  ).toBe(true);
  expect(second.structured).toBe(first.structured);
  expect(second.markdown).toBe(first.markdown);
});
