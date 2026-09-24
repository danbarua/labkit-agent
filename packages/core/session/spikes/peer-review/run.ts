#!/usr/bin/env bun
/**
 * The peer-review spike: one journaled session drives a stand-in research record through a
 * design version and two review rounds, extracting findings with Haiku and adjudicating
 * them across rounds with Sonnet. Writes the journal, the record, and a report.
 *
 *   bun packages/core/session/spikes/peer-review/run.ts [--rounds 2] [--corpus <edge_instruments dir>]
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createSession, journalJSONL } from "../../index.ts";
import { createMemoryPersistence } from "../../testing/memory-persistence.ts";
import { peerReviewDriver } from "./driver.ts";
import { modelTools } from "./models.ts";
import { ResearchRecord, type FindingInput } from "./record.ts";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : (args[i + 1] ?? fallback);
};
const rounds = Number(flag("--rounds", "2"));
const corpus = resolve(flag("--corpus", "/Users/dan/Code/science/10_edge_instruments"));
const out = resolve(".session-artifacts/peer-review");
mkdirSync(out, { recursive: true });

// The design version the rounds reviewed: the seven documents at the frozen commit.
const COMMIT = "bc7b562";
const documents = Bun.spawnSync(
  ["git", "ls-tree", "-r", COMMIT, "--", "DESIGN.md", "instruments", "HIPPO.md", "PARK.md"],
  { cwd: corpus },
)
  .stdout.toString()
  .trim()
  .split("\n")
  .map((line) => {
    const [, , blob, path] = line.split(/\s+/);
    return { path: path!, blob: blob! };
  });

const transcripts = readdirSync(join(corpus, "reviews"))
  .filter((f) => f.endsWith(".md"))
  .sort()
  .slice(0, rounds)
  .map((f) => join(corpus, "reviews", f));
const readTranscript = (path: string) => readFileSync(path, "utf8");

const record = new ResearchRecord();
const session = await createSession({
  persistence: createMemoryPersistence(),
  configuration: {
    agent: "coordinator",
    agents: new Map([
      [
        "coordinator",
        {
          model: "scripted",
          systemPrompt: "Drives the record through a review cycle.",
          tools: [
            "record_design_version",
            "record_review_round",
            "record_finding",
            "link_finding",
            "extract_findings",
            "adjudicate_finding",
          ],
        },
      ],
    ]),
    steps: 8,
  },
  bindings: {
    complete: peerReviewDriver(),
    tools: new Map([...record.tools(), ...modelTools(readTranscript)]),
  },
});

// The journal and the record are written whatever happens, so a failed round leaves evidence.
const dump = () => {
  writeFileSync(join(out, "journal.jsonl"), journalJSONL(session.snapshot.durable));
  writeFileSync(join(out, "record.json"), JSON.stringify(record.acts, null, 2));
};
const turn = async (op: unknown) => {
  const t = session.input(JSON.stringify(op));
  await t.accepted;
  const outcome = await t.settled;
  if (outcome.kind !== "terminal" || outcome.record.outcome.kind !== "completed") {
    dump();
    throw new Error(
      `turn did not complete: ${JSON.stringify(outcome.kind === "terminal" ? outcome.record.outcome : outcome).slice(0, 1200)}`,
    );
  }
  return outcome;
};

console.error(`design: ${documents.length} documents at ${COMMIT}`);
await turn({ op: "design", commit: COMMIT, documents });

type Recorded = FindingInput & { handle: string };
let previous: Recorded[] = [];
for (const [i, transcript] of transcripts.entries()) {
  const header = readTranscript(transcript).split("\n").slice(0, 6).join("\n");
  const model = /requesting review from (\S+)/.exec(header)?.[1] ?? "unknown";
  const bytes = Number(/(\d+) bytes/.exec(header)?.[1] ?? 0);
  console.error(`round ${i + 1}: ${transcript} (${model}, ${bytes} bytes)`);
  await turn({ op: "round", model, corpus_bytes: bytes, transcript, candidates: previous });
  const roundHandle = record.of<{ transcript: string }>("record_review_round").at(-1)!.handle;
  previous = record
    .of<FindingInput>("record_finding")
    .filter((f) => f.input.round === roundHandle)
    .map((f) => ({ ...f.input, handle: f.handle }));
  console.error(`  ${previous.length} findings recorded`);
}

await session.close();
dump();

const findings = record.of<FindingInput>("record_finding");
const links = record.of<{ finding: string; same_as: string | null; because: string }>("link_finding");
const byHandle = new Map(findings.map((f) => [f.handle, f.input]));
const lines: string[] = ["# Peer-review spike", ""];
lines.push(`Acts: ${record.acts.length}. Verbs used: ${[...new Set(record.acts.map((a) => a.verb))].join(", ")}.`, "");
for (const r of record.of<{ model: string; transcript: string }>("record_review_round")) {
  const mine = findings.filter((f) => f.input.round === r.handle);
  const kinds = mine.reduce<Record<string, number>>((n, f) => ((n[f.input.kind] = (n[f.input.kind] ?? 0) + 1), n), {});
  lines.push(`## ${r.handle} — ${r.input.model} — ${r.input.transcript.split("/").pop()}`, "");
  lines.push(`${mine.length} findings: ${JSON.stringify(kinds)}`, "");
  for (const f of mine) lines.push(`- ${f.handle} ${f.input.numbered} ${f.input.title}`);
  lines.push("");
}
if (links.length) {
  lines.push("## Links (round 2 finding → round 1 finding)", "");
  lines.push("| later | earlier | because |", "|---|---|---|");
  for (const l of links) {
    const later = byHandle.get(l.input.finding);
    const earlier = l.input.same_as ? byHandle.get(l.input.same_as) : undefined;
    lines.push(
      `| ${l.input.finding} ${later?.numbered ?? ""} ${later?.title ?? ""} | ${l.input.same_as ? `${l.input.same_as} ${earlier?.numbered ?? ""} ${earlier?.title ?? ""}` : "new"} | ${l.input.because.replace(/\|/g, "/")} |`,
    );
  }
  lines.push("");
  // The hand-made trace from reading the two transcripts.
  const hand: Array<[string, string | null]> = [
    ["C6", "C4"],
    ["C13", "C8"],
    ["C5", null],
    ["C1", null],
  ];
  lines.push("## Against the hand trace (round 1 number → round 2 number)", "");
  for (const [r1, r2] of hand) {
    const earlier = findings.find((f) => f.input.round === "RR_1" && f.input.numbered === r1);
    const linkedTo = links.filter((l) => l.input.same_as === earlier?.handle).map((l) => byHandle.get(l.input.finding)?.numbered);
    lines.push(`- R1 ${r1}: hand says ${r2 ?? "no successor"}; adjudication linked ${linkedTo.length ? linkedTo.join(", ") : "nothing"}`);
  }
}
writeFileSync(join(out, "report.md"), lines.join("\n"));
console.error(`wrote ${out}/journal.jsonl, record.json, report.md`);
console.log(lines.join("\n"));
