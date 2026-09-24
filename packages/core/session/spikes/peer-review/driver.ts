/**
 * The coordinator, as a scripted completion port. It stands where a model would: it reads the
 * turn's input and the tool results so far, and answers with the next tool calls. Scripted so the
 * paperwork is deterministic; the two judgement calls happen inside tools.
 *
 * Turn inputs are JSON:
 *   {"op":"design","commit":..,"documents":[{path,blob}]}
 *   {"op":"round","model":..,"corpus_bytes":..,"transcript":..,"candidates":[{handle,...finding}]}
 */

import type { Completion, ToolCall } from "../../../agent/types.ts";
import type { CompletionPort } from "../../../host/ports.ts";
import type { Extraction, Verdict } from "./models.ts";
import type { FindingInput } from "./record.ts";

type Recorded = FindingInput & { handle: string };
type Op =
  | { op: "design"; commit: string; documents: Array<{ path: string; blob: string }> }
  | {
      op: "round";
      model: string;
      corpus_bytes: number;
      transcript: string;
      candidates: Recorded[];
    };

type Message = { role: string; content: string; tool_call_id?: string };

export function peerReviewDriver(): CompletionPort {
  // What this turn has asked for, by call id, so a tool result can be read back as its answer.
  let asked = new Map<string, ToolCall>();
  let lastInput = "";
  let counter = 0;
  const call = (name: string, args: unknown): ToolCall =>
    ({ id: `${name}-${++counter}`, name, args } as unknown as ToolCall);
  const tools = (text: string, calls: ToolCall[]): Completion => {
    for (const c of calls) asked.set(c.id, c);
    return { kind: "tools", text, calls: calls as unknown as Completion extends { calls: infer C } ? C : never };
  };

  return ((request: { messages: readonly Message[] }) => {
    const messages = request.messages;
    const input = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    if (input !== lastInput) {
      lastInput = input;
      asked = new Map();
    }
    let op: Op;
    try {
      op = JSON.parse(input) as Op;
    } catch {
      const seen = messages.map((m) => ({ role: m.role, text: m.content.slice(0, 80) }));
      throw new Error(`driver: no JSON op in the last user message; messages were ${JSON.stringify(seen)}`);
    }
    // Results of what this turn asked, by tool name, in order.
    const results = new Map<string, Array<{ call: ToolCall; value: unknown }>>();
    for (const m of messages) {
      if (m.role !== "tool" || !m.tool_call_id) continue;
      const c = asked.get(m.tool_call_id);
      if (!c) continue;
      const list = results.get(c.name) ?? [];
      list.push({ call: c, value: JSON.parse(m.content) });
      results.set(c.name, list);
    }
    const done = (name: string) => results.get(name) ?? [];

    if (op.op === "design") {
      if (done("record_design_version").length === 0)
        return tools("record the design version", [
          call("record_design_version", { commit: op.commit, documents: op.documents }),
        ]);
      return { kind: "answer", text: JSON.stringify(done("record_design_version")[0]!.value) };
    }

    // A round: record it and extract, record each finding, adjudicate each against the earlier
    // round's findings, link, answer.
    const round = done("record_review_round")[0];
    const extracted = done("extract_findings")[0];
    if (!round || !extracted) {
      const design = [...messages]
        .filter((m) => m.role === "tool")
        .map((m) => {
          try {
            return JSON.parse(m.content) as { design?: string };
          } catch {
            return {};
          }
        })
        .find((v) => v.design)?.design;
      return tools("record the round and extract its findings", [
        call("record_review_round", {
          design: design ?? "DV_1",
          model: op.model,
          corpus_bytes: op.corpus_bytes,
          transcript: op.transcript,
        }),
        call("extract_findings", { transcript: op.transcript }),
      ]);
    }
    const roundHandle = (round.value as { round: string }).round;
    const candidates = (extracted.value as Extraction).findings;
    const recorded = done("record_finding");
    if (recorded.length < candidates.length)
      return tools(
        `record ${candidates.length} findings`,
        candidates.map((f) => call("record_finding", { round: roundHandle, ...f })),
      );
    const findings: Recorded[] = recorded.map((r) => ({
      ...(r.call.args as FindingInput),
      handle: (r.value as { finding: string }).finding,
    }));
    if (op.candidates.length === 0)
      return { kind: "answer", text: JSON.stringify({ round: roundHandle, findings: findings.length }) };

    const adjudicated = done("adjudicate_finding");
    if (adjudicated.length < findings.length)
      return tools(
        `adjudicate ${findings.length} findings against ${op.candidates.length} earlier ones`,
        findings.map((f) => call("adjudicate_finding", { finding: f, candidates: op.candidates })),
      );
    const linked = done("link_finding");
    if (linked.length < adjudicated.length)
      return tools(
        "link each finding to its predecessor, or to none",
        adjudicated.map((a) => {
          const finding = (a.call.args as { finding: Recorded }).finding;
          const v = a.value as Verdict;
          return call("link_finding", { finding: finding.handle, same_as: v.same_as, because: v.because });
        }),
      );
    return {
      kind: "answer",
      text: JSON.stringify({
        round: roundHandle,
        findings: findings.length,
        linked: linked.filter((l) => (l.call.args as { same_as: string | null }).same_as).length,
      }),
    };
  }) as unknown as CompletionPort;
}
