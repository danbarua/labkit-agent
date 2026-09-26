import type { ConversationEvent } from "../../agent/agent-conversation.ts";
import { freeze } from "../../fsm/fsm.ts";
import type { CompletionUsage } from "../../providers/usage.ts";
import {
  BodySchema,
  JournalRecordSchema,
  WireEventSchema,
  type JournalRecord,
  type WireEvent,
} from "../types.ts";

/**
 * Converts a conversation event into its journaled form ({@link WireEvent}). A settled step's
 * usage is stripped here; {@link completionUsage} reads it separately for the caller to stage as a
 * sibling `effect` record.
 */
export function wireEvent(event: ConversationEvent): WireEvent {
  if (event.type === "dispatch_failed") {
    if (event.command.type !== "turn") throw new Error("Cannot journal a failed branch callback");
    return WireEventSchema.parse({
      type: "child",
      turnId: event.command.turnId,
      event: { type: "failed", child: event.command.command.child, error: event.error },
    });
  }
  if (event.type === "child" && event.event.type === "model_settled") {
    const { usage: _usage, ...settled } = event.event;
    return WireEventSchema.parse({ ...event, event: settled });
  }
  return WireEventSchema.parse(event);
}

/** The usage a settled step reported, when it admitted a completion; undefined otherwise. */
export function completionUsage(event: ConversationEvent): CompletionUsage | undefined {
  return event.type === "child" && event.event.type === "model_settled"
    ? event.event.usage
    : undefined;
}

/**
 * Serializes a record as a journal append stores it.
 *
 * @throws ZodError when the record is not a current-format journal record.
 */
export function encodeRecord(record: JournalRecord): string {
  return JSON.stringify(JournalRecordSchema.parse(record));
}

/**
 * Parses one stored record and deep-freezes it. Checks only the record format; journal integrity is
 * checked by {@link replay}, which reports a failure here as `record_decode`.
 *
 * @throws SyntaxError for invalid JSON; ZodError for anything else that is not a current-format
 *   record, including a newer `version` or an unknown body `kind`.
 */
export function decodeRecord(serialized: string): JournalRecord {
  return freeze(JournalRecordSchema.parse(JSON.parse(serialized)));
}

export const recordKinds: ReadonlySet<string> = new Set(
  BodySchema.options.map((option) => option.shape.kind.value),
);

export const newerBuild =
  "the journal was probably written by a newer Labkit build, so restart the launcher on current code";

/** Why stored bytes do not decode, read from the raw JSON without validating it. */
export function decodeFailure(serialized: string): string {
  let raw: unknown;
  try {
    raw = JSON.parse(serialized);
  } catch {
    return "Record is not valid JSON";
  }
  const field = (value: unknown, key: string) =>
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)[key]
      : undefined;
  const version = field(raw, "version");
  if (typeof version === "number" && version > 1)
    return `Record has version ${version}, but this Labkit build reads only version 1; ${newerBuild}`;
  const kind = field(field(raw, "body"), "kind");
  if (typeof kind === "string" && !recordKinds.has(kind))
    return `Record has kind ${JSON.stringify(kind)}, which this Labkit build does not know; ${newerBuild}`;
  return "Record does not decode as a version 1 journal record";
}
