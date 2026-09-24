/**
 * The two model calls the workflow schedules, each a structured-output call: extraction of
 * findings from a review transcript (find-and-tag), and adjudication of whether a finding is
 * the same as an earlier one (a judgement). Both are tools, so each call and its answer is a
 * journal record with a call id.
 */

import { z } from "zod";
import { defineTool, type Tool } from "../../session-runtime.ts";
import { findingInput, passage } from "./record.ts";

export const MODELS = {
  extract: "claude-haiku-4-5-20251001",
  adjudicate: "claude-sonnet-5",
} as const;

const candidate = findingInput.omit({ round: true });
export const extraction = z.strictObject({ findings: z.array(candidate) });
export type Extraction = z.infer<typeof extraction>;

export const verdict = z.strictObject({
  same_as: z.string().nullable(),
  because: z.string(),
});
export type Verdict = z.infer<typeof verdict>;

/** One structured-output request to the Messages API. */
async function structured<S extends z.ZodType>(
  model: string,
  system: string,
  user: string,
  schema: S,
  maxTokens: number,
  signal: AbortSignal,
): Promise<z.output<S>> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set; put it in the worktree's .env");
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
      output_config: { format: { type: "json_schema", schema: z.toJSONSchema(schema) } },
    }),
  });
  const body = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
    stop_reason?: string;
    error?: { message: string };
    usage?: unknown;
  };
  if (!response.ok) throw new Error(`${model}: ${response.status} ${body.error?.message ?? ""}`);
  const text = body.content?.find((b) => b.type === "text")?.text;
  if (!text)
    throw new Error(
      `${model}: no text block, stop_reason=${body.stop_reason}, blocks=${(body.content ?? []).map((b) => b.type).join(",")}, usage=${JSON.stringify(body.usage)}`,
    );
  return schema.parse(JSON.parse(text));
}

export function modelTools(readTranscript: (path: string) => string): ReadonlyMap<string, Tool> {
  return new Map<string, Tool>([
    [
      "extract_findings",
      defineTool({
        description:
          "Every finding in a review transcript, as passages, scenario and fix. Find-and-tag over " +
          "text the reviewer wrote; the extractor adds nothing.",
        input: z.strictObject({ transcript: z.string() }),
        run: async ({ transcript }, signal) =>
          structured(
            MODELS.extract,
            "You are given one review report over a set of design documents. Extract every " +
              "numbered finding exactly as written. For each: its kind (a contradiction between " +
              "passages; a doctrine rule nothing enforces; an unresolved choice or ambiguity), the " +
              "number the report gave it, a short title, every quoted passage with the document " +
              "it names, the trigger or scenario in which the passages collide, and the fix the " +
              "report proposes. Copy quotes verbatim. Add no findings the report does not make. " +
              "If a finding lacks a scenario or fix, use an empty string.",
            readTranscript(transcript),
            extraction,
            16000,
            signal,
          ),
      }),
    ],
    [
      "adjudicate_finding",
      defineTool({
        description:
          "Whether a finding is the same finding as one of an earlier round's, seen again, or new. " +
          "A judgement over the passages and scenarios, not the numbers.",
        input: z.strictObject({
          finding: findingInput.extend({ handle: z.string() }),
          candidates: z.array(findingInput.extend({ handle: z.string() })),
        }),
        run: async ({ finding, candidates }, signal) =>
          structured(
            MODELS.adjudicate,
            "A design review was run twice over an evolving set of documents. You are given one " +
              "finding from the later round and every finding from the earlier round. Decide " +
              "whether the later finding is the same finding as exactly one of the earlier ones: " +
              "the same two passages or their descendants colliding for the same reason, whatever " +
              "number either report gave it. If so, answer with that earlier finding's handle. If " +
              "it is a new finding, or the earlier one was resolved and this collides differently, " +
              "answer null. Justify against the passages, in one or two sentences. Do not default " +
              "to a match to be agreeable.",
            JSON.stringify({ finding, candidates }, null, 2),
            verdict,
            8000,
            signal,
          ),
      }),
    ],
  ]);
}

export { passage };
