import type { ConversationEvent } from "../../agent/agent-conversation.ts";
import { freeze } from "../../fsm/fsm.ts";
import {
  BodySchema,
  JournalRecordSchema,
  WireEventSchema,
  type JournalRecord,
  type WireEvent,
} from "../types.ts";

/**
 * Converts a conversation event into its journaled form ({@link WireEvent}). A captured prompt
 * response remains unchanged; a prepared model (tool definitions, inference result) is filtered to
 * only the fields that the runtime's next turn needs.
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
  if (
    event.type === "child" &&
    event.event.type === "prepared" &&
    event.event.result.kind === "succeeded"
  ) {
    const {
      model,
      messages,
      tools,
      temperature,
      provider,
      thinking,
      thinkingBudgetTokens,
      stream,
      maxOutputTokens,
      successors,
      continuations,
    } = event.event.result.value;
    return WireEventSchema.parse({
      ...event,
      event: {
        ...event.event,
        result: {
          kind: "succeeded",
          value: {
            model,
            messages,
            tools,
            temperature,
            ...(continuations ? { continuations } : {}),
            ...(provider
              ? { provider, thinking, thinkingBudgetTokens, stream, maxOutputTokens, successors }
              : {}),
          },
        },
      },
    });
  }
  return WireEventSchema.parse(event);
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
