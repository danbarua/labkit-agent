import { format } from "prettier";
import { z } from "zod";

import { BlobInputMetaSchema, type BlobRef } from "../agent/content.ts";
import { PolicyPatchSchema } from "../policy/policy.ts";
import { anthropicMessagesV2, googleGenerate, openaiChat } from "../providers/index.ts";
import { journalJSONL, journalMarkdown } from "./session-log.ts";
import type { LegacySessionOptions, SessionOptions } from "./session-runtime.ts";
import {
  createSession,
  defineTool,
  restoreSession,
  type SessionRuntime,
  type TerminalResult,
} from "./session-runtime.ts";
import {
  deferred,
  deterministicIds,
  lostAcknowledgement,
  testOptions,
  until,
} from "./test-support.ts";
import { createMemoryBacking, createMemoryPersistence } from "./testing/memory-persistence.ts";
import { BodySchema } from "./types.ts";

const StepSchema = z.object({
  op: z.enum([
    "input",
    "system",
    "policy",
    "fork",
    "compact",
    "invalid-context",
    "restore",
    "close",
    "abort",
    "release",
    "requests",
    "partial",
    "settle",
    "join",
  ]),
  session: z.string().default("root"),
  target: z.string().optional(),
  text: z.string().optional(),
  attachments: z.array(z.string()).optional(),
  inputs: z.array(z.string()).optional(),
  context: z.unknown().optional(),
  patch: PolicyPatchSchema.optional(),
  wait: z.boolean().default(true),
  count: z.number().int().nonnegative().optional(),
  name: z.string().optional(),
  value: z.unknown().optional(),
  expected: z.string().optional(),
});
const ScenarioSchema = z.object({
  format: z.literal(2).optional(),
  providerResponses: z.literal(true).optional(),
  blobs: z.record(z.string(), BlobInputMetaSchema.extend({ text: z.string() })).optional(),
  policy: PolicyPatchSchema.optional(),
  name: z.string().regex(/^[a-z0-9-]+$/),
  allowance: z.number().int().nonnegative().default(4),
  fault: z.enum(["reject-input", "lose-input", "lose-recovery"]).optional(),
  completions: z.array(z.unknown()),
  steps: z.array(StepSchema),
});
type Scenario = z.infer<typeof ScenarioSchema>;
const fixtureRoot = new URL("./fixtures/", import.meta.url);
const defaultArtifacts = new URL("../../../.session-artifacts/latest/", import.meta.url).pathname;
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

async function runScenario(scenario: Scenario, directory: string) {
  const backing = createMemoryBacking();
  const base = createMemoryPersistence(backing);
  const matches = (records: readonly string[], kind: "input" | "recovery") =>
    records.some((serialized) => {
      const body = BodySchema.parse(JSON.parse(serialized).body);
      return kind === "recovery"
        ? body.kind === "recovery"
        : body.kind === "event" && body.event.type === "user";
    });
  const port =
    scenario.fault === "lose-input" || scenario.fault === "lose-recovery"
      ? lostAcknowledgement(base, (records) =>
          matches(records, scenario.fault === "lose-recovery" ? "recovery" : "input"),
        )
      : scenario.fault === "reject-input"
        ? {
            ...base,
            append: (request: Parameters<typeof base.append>[0], signal: AbortSignal) =>
              matches(request.records, "input")
                ? Promise.resolve({
                    kind: "rejected" as const,
                    message: "Scripted rejected append",
                  })
                : base.append(request, signal),
          }
        : base;
  const requests: unknown[] = [];
  const results: unknown[] = [];
  const sessions = new Map<string, SessionRuntime>();
  const branches = new Map<string, Promise<SessionRuntime>>();
  const active = new Map<string, Promise<TerminalResult>>();
  const deferredWork = new Map<
    string,
    { promise: Promise<unknown>; resolve: (value: unknown) => void; value?: unknown }
  >();
  let completionIndex = 0;
  const options = testOptions({
    persistence: port,
    id: deterministicIds(),
    steps: scenario.allowance,
    tools: new Map([
      [
        "echo",
        defineTool({
          input: z.object({ text: z.string() }),
          run: ({ text }) => {
            if (text.startsWith("error:")) throw new Error(text.slice(6));
            if (!text.startsWith("defer:")) return text;
            const work = deferred<unknown>();
            deferredWork.set(text.slice(6), work);
            return work.promise;
          },
        }),
      ],
    ]),
    complete(request) {
      requests.push({ model: request.model, messages: request.messages, tools: request.tools });
      const outcome = scenario.completions[completionIndex++];
      if (outcome === undefined) throw new Error("Fixture completion script exhausted");
      if (typeof outcome === "object" && outcome !== null && "error" in outcome)
        throw new Error(String(outcome.error));
      if (typeof outcome === "object" && outcome !== null && "defer" in outcome) {
        const work = deferred<unknown>();
        deferredWork.set(String(outcome.defer), {
          ...work,
          value: "value" in outcome ? outcome.value : undefined,
        });
        return work.promise;
      }
      return outcome;
    },
  });
  const bind = (legacy: LegacySessionOptions): SessionOptions =>
    scenario.format === 2
      ? {
          persistence: legacy.persistence,
          configuration: {
            agent: legacy.agent,
            agents: legacy.agents,
            steps: legacy.steps,
            policy: scenario.policy,
          },
          bindings: {
            tools: legacy.tools,
            id: legacy.id,
            ...(scenario.providerResponses
              ? {
                  providers: new Map(
                    [anthropicMessagesV2, googleGenerate, openaiChat].map((profile) => [
                      profile.id,
                      {
                        profile,
                        transport: {
                          baseUrl: "https://example.invalid",
                          fetch: (async (_url, init) => {
                            requests.push(JSON.parse(String(init?.body)));
                            const response = scenario.completions[completionIndex++];
                            if (response === undefined)
                              throw new Error("Fixture provider script exhausted");
                            return Response.json(response);
                          }) as typeof fetch,
                        },
                      },
                    ]),
                  ),
                }
              : {
                  complete: (request, signal) =>
                    legacy.complete!({
                      ...request,
                      baseUrl: legacy.baseUrl,
                      apiKey: legacy.apiKey,
                      signal,
                    }),
                }),
          },
        }
      : legacy;
  let error: string | undefined;
  try {
    sessions.set("root", await createSession(bind(options)));
    const attachments = new Map<string, BlobRef>();
    for (const [name, blob] of Object.entries(scenario.blobs ?? {})) {
      const { text, ...meta } = blob;
      attachments.set(
        name,
        await port.putBlob(
          sessions.get("root")!.snapshot.durable.conversation.sessionId,
          new TextEncoder().encode(text),
          meta,
          new AbortController().signal,
        ),
      );
    }
    for (const step of scenario.steps) {
      const session = sessions.get(step.session);
      if (!session && step.op !== "join") throw new Error(`Unknown session ${step.session}`);
      switch (step.op) {
        case "input": {
          const turn = session!.input(
            step.attachments
              ? {
                  text: step.text ?? "",
                  attachments: step.attachments.map((name) => {
                    const ref = attachments.get(name);
                    if (!ref) throw new Error(`Unknown fixture attachment ${name}`);
                    return ref;
                  }),
                }
              : (step.text ?? ""),
          );
          active.set(step.session, turn.settled);
          results.push({ op: step.op, session: step.session, accepted: await turn.accepted });
          if (step.wait) results.push({ session: step.session, terminal: await turn.settled });
          break;
        }
        case "policy":
        case "system": {
          const receipt =
            step.op === "policy"
              ? await session!.updatePolicy(step.patch ?? {})
              : await session!.updateSystem(step.inputs ?? []);
          if (receipt.kind !== (step.expected ?? "accepted"))
            throw new Error(`Unexpected system receipt: ${receipt.kind}`);
          results.push({ op: step.op, session: step.session, receipt });
          break;
        }
        case "fork":
        case "compact": {
          if (!step.target) throw new Error("Branch needs target alias");
          const branch = step.op === "fork" ? session!.fork() : session!.compact(step.context);
          branches.set(step.target, branch);
          if (step.wait) sessions.set(step.target, await branch);
          else {
            // Wait for durable admission of the fork request, without waiting for the turn.
            await until(() => session!.snapshot.durable.conversation.pending.length > 0);
          }
          break;
        }
        case "join": {
          const branch = branches.get(step.session);
          if (!branch) throw new Error("No queued branch");
          sessions.set(step.session, await branch);
          break;
        }
        case "invalid-context": {
          let rejected = false;
          try {
            await session!.compact(step.context);
          } catch {
            rejected = true;
          }
          if (!rejected) throw new Error("Invalid context was accepted");
          results.push({ op: step.op, rejected });
          break;
        }
        case "restore": {
          if (!step.target) throw new Error("Restore needs target alias");
          const restored = await restoreSession(
            bind({
              ...options,
              persistence:
                scenario.fault === "lose-recovery" ? port : createMemoryPersistence(backing),
              complete: () => {
                throw new Error("Restoration invoked completion");
              },
            }),
            session!.snapshot.durable.conversation.sessionId,
          );
          sessions.set(step.target, restored);
          break;
        }
        case "close":
          await session!.close();
          break;
        case "abort":
          await session!.fire({ type: "abort" });
          results.push({ session: step.session, terminal: await active.get(step.session) });
          break;
        case "settle":
          results.push({ session: step.session, terminal: await active.get(step.session) });
          break;
        case "requests":
          await until(() => requests.length === step.count);
          break;
        case "partial":
          await until(() => session!.snapshot.durable.partial.length === step.count);
          break;
        case "release": {
          const work = deferredWork.get(step.name ?? "");
          if (!work) throw new Error("Deferred work not started");
          work.resolve(step.value ?? work.value);
          await work.promise;
          break;
        }
      }
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const states = Object.fromEntries(
    [...sessions].map(([alias, session]) => [alias, session.snapshot.durable]),
  );
  const transcript = [...sessions]
    .map(
      ([alias, session]) =>
        `# ${scenario.name}: ${alias}\n\n${journalMarkdown(session.snapshot.durable)}`,
    )
    .join("\n");
  // Emit partial evidence even if scenario execution or the subsequent baseline comparison fails.
  await Bun.write(`${directory}/inputs.json`, json(scenario));
  await Bun.write(`${directory}/requests.json`, json(requests));
  await Bun.write(`${directory}/states.json`, json(states));
  await Bun.write(`${directory}/outputs.json`, json(results));
  await Bun.write(`${directory}/transcript.md`, transcript);
  for (const [alias, session] of sessions)
    await Bun.write(`${directory}/journal-${alias}.jsonl`, journalJSONL(session.snapshot.durable));
  if (error) await Bun.write(`${directory}/error.json`, json({ error }));
  const output = {
    name: scenario.name,
    inputs: scenario,
    requests,
    results,
    states,
    ...(error ? { error } : {}),
  };
  for (const session of sessions.values()) await session.close();
  return { output, transcript, error };
}
export async function runFixtures(
  options: { update?: boolean; artifactDirectory?: string; version?: 1 | 2 } = {},
) {
  const suffix = options.version === 2 ? "-v2" : "";
  const scenarios = z
    .array(ScenarioSchema)
    .parse(await Bun.file(new URL(`scenarios${suffix}.json`, fixtureRoot)).json());
  const outputs = [];
  const transcripts = [];
  const failures = [];
  const directory =
    options.artifactDirectory ??
    (options.version === 2 ? `${defaultArtifacts.replace(/\/$/, "")}-v2` : defaultArtifacts);
  for (const scenario of scenarios) {
    const result = await runScenario(scenario, `${directory}/${scenario.name}`);
    outputs.push(result.output);
    transcripts.push(result.transcript);
    if (result.error) failures.push(`${scenario.name}: ${result.error}`);
  }
  // Match the repository formatter without changing approved content or ordering.
  const structured = await format(json(outputs), { parser: "json", printWidth: 100, tabWidth: 2 });
  const markdown = await format(transcripts.join("\n---\n\n"), {
    parser: "markdown",
    printWidth: 100,
    tabWidth: 2,
  });
  await Bun.write(`${directory}/actual.json`, structured);
  await Bun.write(`${directory}/actual.md`, markdown);
  if (failures.length) throw new Error(failures.join("\n"));
  if (structured.includes("SECRET_SENTINEL"))
    throw new Error("Credential leaked into fixture output");
  if (options.update) {
    await Bun.write(new URL(`expected${suffix}.json`, fixtureRoot), structured);
    await Bun.write(new URL(`expected${suffix}.md`, fixtureRoot), markdown);
  } else {
    const expected = await Bun.file(new URL(`expected${suffix}.json`, fixtureRoot)).text();
    const readable = await Bun.file(new URL(`expected${suffix}.md`, fixtureRoot)).text();
    if (structured !== expected || markdown !== readable)
      throw new Error(
        `Session fixture mismatch; inspect ${directory}/actual.json and actual.md. Baselines require explicit --update.`,
      );
  }
  return { structured, markdown, count: scenarios.length };
}
if (import.meta.main) {
  const args = Bun.argv.slice(2);
  if (args.some((arg) => arg !== "--update" && arg !== "--v2"))
    throw new Error("Usage: bun run packages/core/session/fixture-runner.ts [--v2] [--update]");
  const result = await runFixtures({
    update: args.includes("--update"),
    version: args.includes("--v2") ? 2 : 1,
  });
  console.log(
    `${result.count} session fixtures ${args.includes("--update") ? "updated" : "matched"}.`,
  );
}
