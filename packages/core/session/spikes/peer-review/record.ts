/**
 * A stand-in research record for the peer-review spike: an append-only list of acts, each
 * minting a handle, exposed as tools with JSON schemas. The verbs here are the ones the review
 * workflow reaches for; which of them LabKit already has is the spike's first measurement.
 */

import { z } from "zod";
import { defineTool, type Tool } from "../../session-runtime.ts";

export type Act = Readonly<{
  seq: number;
  verb: string;
  handle: string;
  input: unknown;
  /** The session tool call that performed this act, when one did. */
  callId?: string;
}>;

export const passage = z.strictObject({ document: z.string(), quote: z.string() });
export const findingInput = z.strictObject({
  round: z.string(),
  kind: z.enum(["contradiction", "doctrine_rule", "unresolved"]),
  /** The number the reviewer gave it in its own report, e.g. C7. Not an identity. */
  numbered: z.string(),
  title: z.string(),
  passages: z.array(passage).min(1),
  scenario: z.string(),
  fix: z.string(),
});
export type FindingInput = z.infer<typeof findingInput>;

export class ResearchRecord {
  readonly acts: Act[] = [];
  private readonly counters = new Map<string, number>();

  private mint(prefix: string): string {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}_${n}`;
  }

  record(verb: string, prefix: string, input: unknown): string {
    const handle = this.mint(prefix);
    this.acts.push({ seq: this.acts.length + 1, verb, handle, input });
    return handle;
  }

  /** Every act of one verb, with its handle. */
  of<T>(verb: string): Array<{ handle: string; input: T }> {
    return this.acts
      .filter((a) => a.verb === verb)
      .map((a) => ({ handle: a.handle, input: a.input as T }));
  }

  /** The verbs LabKit has today, by the same word, and the ones this workflow needed. */
  tools(): ReadonlyMap<string, Tool> {
    return new Map<string, Tool>([
      [
        "record_design_version",
        defineTool({
          description:
            "The documents a review was run over, each by its git blob hash. LabKit today: no verb.",
          input: z.strictObject({
            commit: z.string(),
            documents: z.array(z.strictObject({ path: z.string(), blob: z.string() })).min(1),
          }),
          run: (input) => ({ design: this.record("record_design_version", "DV", input) }),
        }),
      ],
      [
        "record_review_round",
        defineTool({
          description:
            "One review of a design version by one model: which model, how big the corpus, and " +
            "where the transcript is. LabKit today: no verb.",
          input: z.strictObject({
            design: z.string(),
            model: z.string(),
            corpus_bytes: z.number().int().nonnegative(),
            transcript: z.string(),
          }),
          run: (input) => ({ round: this.record("record_review_round", "RR", input) }),
        }),
      ],
      [
        "record_finding",
        defineTool({
          description:
            "One finding a review round made: verbatim passages, the scenario in which they " +
            "collide, and the smallest fix. LabKit today: no verb; the nearest is `note`.",
          input: findingInput,
          run: (input) => ({ finding: this.record("record_finding", "FND", input) }),
        }),
      ],
      [
        "link_finding",
        defineTool({
          description:
            "An adjudication that a finding is the same as an earlier round's, or new. Its own " +
            "act, so a wrong link is one retractable decision. LabKit today: SUPERSEDES between " +
            "claims is the nearest edge.",
          input: z.strictObject({
            finding: z.string(),
            same_as: z.string().nullable(),
            because: z.string(),
          }),
          run: (input) => ({ link: this.record("link_finding", "LNK", input) }),
        }),
      ],
    ]);
  }
}
