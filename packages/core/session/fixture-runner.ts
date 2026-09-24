import { AsyncLocalStorage } from "node:async_hooks";
import { rm } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { configure, getConfig } from "@logtape/logtape";
import { z } from "zod";

import { withFixtureDiagnostics } from "../logging/fixture-capture.ts";
import { diagnostic, diagnosticError } from "../logging/index.ts";
import { scenarios } from "./fixtures/index.ts";
import { fixtureEnvironment, type Scenario } from "./fixtures/support.ts";
import { journalJSONL, journalMarkdown, type JournalState } from "./session-log.ts";

export { scenarios } from "./fixtures/index.ts";

const fixtureRoot = new URL("./fixtures/", import.meta.url);

const defaultArtifacts = new URL("../../../.session-artifacts/latest/", import.meta.url).pathname;

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const baselineSchema = z.array(
  z
    .object({
      name: z.string(),
      requests: z.array(z.unknown()),
      results: z.array(z.unknown()),
      states: z.record(z.string(), z.unknown()),
    })
    .passthrough(),
);

const labels = { a: "Primary assistant", b: "Handoff specialist" };

async function logging() {
  if (!getConfig())
    await configure({
      contextLocalStorage: new AsyncLocalStorage(),
      sinks: {},
      loggers: [{ category: ["logtape", "meta"], lowestLevel: "warning", sinks: [] }],
    });
}

/** JSON evidence deliberately has no undefined properties, exactly like the frozen baselines. */
function evidence(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function difference(actual: unknown, expected: unknown, path = "$"): unknown {
  if (isDeepStrictEqual(actual, expected)) return null;
  if (
    actual !== null &&
    expected !== null &&
    typeof actual === "object" &&
    typeof expected === "object"
  ) {
    const a = actual as Record<string, unknown>;
    const b = expected as Record<string, unknown>;
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const mismatch = difference(a[key], b[key], `${path}.${key}`);
      if (mismatch !== null) return mismatch;
    }
  }
  return { path, expected, actual };
}

function display(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string"))
      return value.length ? value.join(", ") : "none";
    return `${value.length} structured entries (values in assertions.json)`;
  }
  if (value !== null && typeof value === "object")
    return "structured value (details in assertions.json)";
  return value === null ? "no difference" : String(value);
}

function transcript(states: Record<string, JournalState>) {
  const seen = new Map<string, { alias: string; state: JournalState }>();
  return Object.entries(states)
    .map(([alias, state]) => {
      const id = state.conversation.sessionId;
      const previous = seen.get(id);
      if (previous && isDeepStrictEqual(evidence(state), evidence(previous.state)))
        return `# Restored view: ${alias}\n\nSame session ID and durable state as **${previous.alias}**. The conversation is shown once above. Restore assertions in [the scenario report](README.md) check whether provider work occurred.\n`;
      seen.set(id, { alias, state });
      return `# View: ${alias}\n\n${previous ? `Another captured view of **${previous.alias}** (revision ${previous.state.revision} → ${state.revision}). Differences are shown below; recovery is identified only when a recovery record exists.\n\n` : ""}${journalMarkdown(state, { agentLabels: labels })}`;
    })
    .join("\n---\n\n");
}

async function executeScenario(
  scenario: Scenario,
  directory: string,
  runId: string,
  compare: boolean,
) {
  // Remove only this generated scenario directory; never leave an old error file after a passing run.
  await rm(directory, { recursive: true, force: true });
  return withFixtureDiagnostics(
    directory,
    { runId, scenario: scenario.name, fixtureVersion: scenario.version },
    async () => {
      const f = fixtureEnvironment(scenario.dependencies);
      let failure: ReturnType<typeof diagnosticError> | undefined;
      let states: Record<string, JournalState> = {};
      try {
        await scenario.run(f);
        states = Object.fromEntries(
          [...f.sessions].map(([alias, session]) => [alias, session.snapshot.durable]),
        );
        if (compare && scenario.baseline !== "assertions") {
          const suffix = scenario.version === 2 ? "-v2" : "";
          const baseline = baselineSchema
            .parse(await Bun.file(new URL(`expected${suffix}.json`, fixtureRoot)).json())
            .find((item) => item.name === scenario.name);
          if (!baseline) throw new Error(`Missing behavioral baseline for ${scenario.name}`);
          for (const [name, actual] of Object.entries({
            requests: f.requests,
            results: f.results,
            states,
          })) {
            // States contain the journal records, so record ordering and bytes are included in this check.
            f.check(
              `Exact ${name} match the approved behavioral evidence (see evidence/${name === "results" ? "outputs" : name}.json)`,
              difference(evidence(actual), baseline[name]),
              null,
            );
          }
          const expectedJournals = Object.fromEntries(
            Object.entries(baseline.states).map(([alias, state]) => {
              const { records } = z.object({ records: z.array(z.unknown()) }).parse(state);
              return [alias, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`];
            }),
          );
          f.check(
            "Encoded journal bytes match the approved records",
            difference(
              Object.fromEntries(
                Object.entries(states).map(([alias, state]) => [alias, journalJSONL(state)]),
              ),
              expectedJournals,
            ),
            null,
          );
        }
        f.check(
          "Captured evidence excludes the fixture API key",
          json({ requests: f.requests, results: f.results, states }).includes("SECRET_SENTINEL"),
          false,
        );
      } catch (error) {
        failure = diagnosticError(error);
        diagnostic("fixture", "error", "scenario.failed", { error: failure });
      } finally {
        // Capture the state under test before cleanup; logs deliberately include cleanup as well.
        states = Object.fromEntries(
          [...f.sessions].map(([alias, session]) => [alias, session.snapshot.durable]),
        );
        for (const [alias, session] of f.sessions) {
          try {
            await session.close();
          } catch (error) {
            const cleanupError = diagnosticError(error);
            diagnostic("fixture", "error", "scenario.cleanup.failed", {
              alias,
              error: cleanupError,
            });
            failure = failure
              ? diagnosticError(
                  new AggregateError([failure, cleanupError], "Scenario and cleanup failed"),
                )
              : cleanupError;
          }
        }
      }
      const output = { name: scenario.name, requests: f.requests, results: f.results, states };
      const aliases: Record<string, string[]> = {};
      for (const [alias, state] of Object.entries(states)) {
        aliases[state.conversation.sessionId] ??= [];
        aliases[state.conversation.sessionId]!.push(alias);
        await Bun.write(`${directory}/evidence/journal-${alias}.jsonl`, journalJSONL(state));
      }
      await Bun.write(`${directory}/evidence/requests.json`, json(f.requests));
      await Bun.write(`${directory}/evidence/outputs.json`, json(f.results));
      await Bun.write(`${directory}/evidence/states.json`, json(states));
      await Bun.write(`${directory}/evidence/session-aliases.json`, json(aliases));
      await Bun.write(
        `${directory}/evidence/assertions.json`,
        json(f.observations.filter((o) => o.kind === "assertion")),
      );
      if (failure) await Bun.write(`${directory}/evidence/error.json`, json(failure));
      await Bun.write(
        `${directory}/evidence/README.md`,
        `# Exact execution evidence\n\nThese files support assertions and detailed investigation. Start with [the scenario report](../README.md) for the story.\n\n- journal-*.jsonl: authoritative committed records, one captured view per session alias.\n- requests.json: actual requests sent to the simulated provider, in order.\n- outputs.json: actual admission receipts, permission requests and terminal results.\n- states.json: durable snapshots **before cleanup**, including embedded journal records.\n- session-aliases.json: joins readable aliases to session IDs in diagnostics.\n- assertions.json: executed checks with expected and observed values.\n- error.json: failure details, when this run failed.\n\nSnapshots describe the end of the scenario body. Diagnostics also include subsequent cleanup. Restore aliases can refer to the same session ID. No blob bytes are placed in the journal.\n`,
      );
      const rendered = transcript(states);
      await Bun.write(`${directory}/transcript.md`, rendered);
      const source = scenario.source.split("#")[0]!;
      const sourceLink = relative(resolve(directory), resolve(source))
        .split("/")
        .map(encodeURIComponent)
        .join("/");
      const report = [
        `# ${scenario.name}`,
        "",
        `**${failure ? "FAIL" : "PASS"}** · suite v${scenario.version} · ${scenario.group}`,
        "",
        scenario.purpose,
        "",
        "PASS means the scenario satisfied its assertions. A deliberately refused, cancelled, or failed user turn can be the expected result.",
        "",
        `Executable example: [${scenario.source}](${sourceLink}).`,
        "",
        "## Test environment",
        "",
        scenario.environment ??
          "The real session runtime runs against process-local memory persistence and scripted provider responses. IDs are deterministic. No live provider or disk crash durability is tested. Primary assistant = agent `a`; handoff specialist = agent `b`. The echo tool returns its input; scripted deferred/error inputs exercise cancellation and failure.",
        "",
        `Storage fault: ${scenario.dependencies.fault ?? "none"}. Provider: ${scenario.dependencies.policy?.provider ?? "injected completion port"}.`,
        "",
        "## Execution and checks",
        "",
        ...f.observations.flatMap((o, index) => [
          `${index + 1}. ${o.kind === "action" ? o.description : `**${o.passed ? "PASS" : "FAIL"}** — ${o.description}. Expected: ${display(o.expected)}; observed: ${display(o.actual)}. [Values](evidence/assertions.json).`}`,
          "",
        ]),
        ...(failure
          ? [
              "## Failure",
              "",
              "The scenario did not satisfy its checks. Full cause and stack: [error.json](evidence/error.json).",
              "",
              "```json",
              json(failure).trimEnd(),
              "```",
              "",
            ]
          : []),
        "## Read next",
        "",
        "- [Conversation transcript](transcript.md)",
        "- [Runtime diagnostics](diagnostics.log) / [structured diagnostics](diagnostics.jsonl)",
        "- [Exact evidence and file meanings](evidence/README.md)",
        "",
        "Snapshots and transcripts were captured before cleanup. Diagnostics include cleanup of every tracked runtime; closure after a completed scenario is not an additional user turn.",
        "",
      ].join("\n");
      await Bun.write(`${directory}/README.md`, report);
      return { output, transcript: rendered, report, failure };
    },
  );
}

/** Run one named example, retaining evidence before reporting an assertion failure. */
export async function runFixture(
  scenario: Scenario,
  options: { artifactDirectory: string; compareBaseline?: boolean },
) {
  await logging();
  const result = await executeScenario(
    scenario,
    options.artifactDirectory,
    crypto.randomUUID(),
    options.compareBaseline ?? true,
  );
  if (result.failure)
    throw new Error(
      `Scenario ${scenario.name} failed. Report: ${resolve(options.artifactDirectory)}/README.md\n${JSON.stringify(result.failure)}`,
    );
  return result;
}

export async function runFixtures(
  options: { update?: boolean; artifactDirectory?: string; version?: 1 | 2 } = {},
) {
  await logging();
  const version = options.version;
  const selected = scenarios.filter(
    (scenario) => version === undefined || scenario.version === version,
  );
  const runId = crypto.randomUUID();
  const directory = `${options.artifactDirectory ?? defaultArtifacts}/${runId}`;
  await Bun.write(
    `${directory}/run.json`,
    json({
      runId,
      fixtureVersion: version,
      directory: resolve(directory),
      startedAt: new Date().toISOString(),
    }),
  );
  if (import.meta.main)
    console.log(`Session examples and diagnostics: ${resolve(directory)}/README.md`);
  const results: Awaited<ReturnType<typeof executeScenario>>[] = [];
  for (const scenario of selected)
    results.push(
      await executeScenario(scenario, `${directory}/${scenario.name}`, runId, !options.update),
    );
  const structured = json(results.map((result) => result.output));
  const markdown = results.map((result) => result.transcript).join("\n---\n\n");
  await Bun.write(`${directory}/actual.json`, structured);
  await Bun.write(`${directory}/actual.md`, markdown);
  await Bun.write(
    `${directory}/README.md`,
    [
      `# Session examples — ${version ? `group ${version}` : "all scenarios"}`,
      "",
      "Start with conversation and tools for ordinary usage; persistence and branching explain failure and recovery guarantees. Each report links to executable TypeScript, checks, the transcript, and exact evidence. Providers are simulated; the runtime is real.",
      "",
      ...selected.map(
        (scenario, index) =>
          `- **${results[index]!.failure ? "FAIL" : "PASS"}** [${scenario.name}](${scenario.name}/README.md) — ${scenario.purpose}`,
      ),
      "",
      "Aggregate actual.json is machine evidence; actual.md combines transcripts. run.json supplies the nondeterministic run ID used in diagnostics. Per-scenario evidence is captured before cleanup; logs include cleanup.",
      "",
    ].join("\n"),
  );
  const failures = results.filter((result) => result.failure);
  if (failures.length)
    throw new Error(
      `Session examples failed: ${failures.map((result) => `${result.output.name}: ${result.failure?.message ?? "Unknown failure"}`).join("\n")}. Read ${resolve(directory)}/README.md`,
    );
  if (options.update) {
    for (const group of [1, 2]) {
      const suffix = group === 2 ? "-v2" : "";
      const path = new URL(`expected${suffix}.json`, fixtureRoot);
      const selectedResults = results.filter(
        (_result, index) => selected[index]?.version === group,
      );
      if (selectedResults.length)
        await Bun.write(path, json(selectedResults.map((result) => result.output)));
    }
  }

  return {
    structured,
    markdown,
    count: selected.length,
    artifactDirectory: resolve(directory),
    runId,
  };
}
if (import.meta.main) {
  const args = Bun.argv.slice(2);
  if (args.some((arg) => arg !== "--update" && arg !== "--v2"))
    throw new Error("Usage: bun run packages/core/session/fixture-runner.ts [--v2] [--update]");
  const result = await runFixtures({
    update: args.includes("--update"),
    version: args.includes("--v2") ? 2 : undefined,
  });
  console.log(
    `${result.count} session examples ${args.includes("--update") ? "updated" : "passed"}.`,
  );
}
