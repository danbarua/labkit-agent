import { PreparedModelSchema } from "../agent/agent.ts";
import {
  decideConversation,
  initialConversation,
  type ConversationCommand,
  type ConversationEvent,
  type ConversationState,
} from "../agent/agent-conversation.ts";
import { completeResults } from "../agent/tool-batch.ts";
import { ActorIdSchema, MessagesSchema, type TurnRecord } from "../agent/types.ts";
import { projectConversationPrompt } from "../agent/prompt.ts";
import { freeze } from "../fsm/fsm.ts";
import {
  INITIAL_REVISION,
  RevisionSchema,
  type AppendId,
  type CommittedBatch,
  type Revision,
} from "./persistence.ts";
import {
  JournalRecordSchema,
  SeedSchema,
  type SystemVersionSchema,
  WireEventSchema,
  type Configuration,
  type JournalBody,
  type JournalRecord,
  type Seed,
  type SessionInput,
  type WireEvent,
} from "./types.ts";

import { projectSessionPrompt } from "./session-prompt.ts";

export type ToolEntry = Extract<JournalBody, { kind: "tool" }>;
export type JournalState = Readonly<{
  conversation: ConversationState;
  configuration: Configuration;
  systemInputs: readonly string[];
  systemVersion: ReturnType<typeof SystemVersionSchema.parse>;
  partial: readonly ToolEntry[];
  revision: Revision;
  records: readonly JournalRecord[];
}>;
export function seedConversation(raw: Seed): JournalState {
  const seed = SeedSchema.parse(raw);
  if (
    seed.sequence !== seed.log.length + 1 ||
    (seed.origin.kind === "fork" && seed.sequence !== seed.origin.sequence)
  )
    throw new Error("Invalid inherited sequence");
  if (!seed.configuration.agents.some(([id]) => id === seed.agent))
    throw new Error("Unknown seed agent");
  if (seed.origin.kind === "root" && (seed.sequence !== 1 || seed.log.length))
    throw new Error("Invalid root boundary");
  if (seed.origin.kind === "compaction" && (seed.sequence !== 1 || seed.log.length))
    throw new Error("Invalid compaction boundary");
  const initial = initialConversation(seed.agent, seed.allowance, seed.sessionId);
  const id = ActorIdSchema.parse(`${seed.sessionId}/turn/${seed.sequence}`);
  const conversation: ConversationState = {
    ...initial,
    context: seed.context,
    origin: seed.origin,
    log: seed.log,
    sequence: seed.sequence,
    turnId: id,
    turn: { ...initial.turn, status: "idle", id, agent: seed.agent, steps: seed.allowance },
  };
  // Validate inherited history as well as the replacement context.
  projectConversationPrompt({
    context: seed.context,
    log: seed.log,
    agent: { model: "validation", tools: [] },
    turn: {
      id,
      agent: seed.agent,
      generation: 0,
      steps: seed.allowance,
      messages: [],
      view: { kind: "history" },
    },
  });
  return freeze({
    conversation,
    configuration: seed.configuration,
    systemInputs: seed.systemInputs,
    systemVersion: seed.systemVersion,
    partial: [],
    revision: INITIAL_REVISION,
    records: [],
  });
}
export function toSeed(state: JournalState, conversation = state.conversation): Seed {
  if (conversation.turn.status !== "idle")
    throw new Error("Initialization requires an idle boundary");
  return SeedSchema.parse({
    sessionId: conversation.sessionId,
    origin: conversation.origin,
    context: conversation.context,
    log: conversation.log,
    sequence: conversation.sequence,
    allowance: conversation.allowance,
    agent: conversation.turn.agent,
    systemInputs: state.systemInputs,
    systemVersion: state.systemVersion,
    configuration: state.configuration,
  });
}
/** Explicit DTO projection: connection settings and credentials never enter a journal. */
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
    const { model, messages, tools, temperature } = event.event.result.value;
    return WireEventSchema.parse({
      ...event,
      event: {
        ...event.event,
        result: { kind: "succeeded", value: { model, messages, tools, temperature } },
      },
    });
  }
  return WireEventSchema.parse(event);
}
export function accepts(state: JournalState, input: SessionInput): boolean {
  const c = state.conversation;
  if (input.kind === "event" && input.event.type === "child") {
    const e = input.event;
    if (e.turnId !== c.turnId || c.turn.status === "idle") return false;
    return e.event.child.id === c.turn.child.id && e.event.child.kind === c.turn.child.kind;
  }
  if (input.kind === "tool") {
    if (
      input.turnId !== c.turnId ||
      c.turn.status !== "executing_tools" ||
      input.batchId !== c.turn.child.id
    )
      return false;
    const calls = c.turn.turn.messages.at(-1);
    return (
      calls?.role === "assistant" &&
      Boolean(calls.calls?.some((call) => call.id === input.callId)) &&
      !state.partial.some(
        (entry) => entry.callId === input.callId || entry.result.kind !== "succeeded",
      )
    );
  }
  return true;
}
function domainEvent(state: JournalState, event: WireEvent): ConversationEvent {
  if (event.type !== "child") return event;
  const child = event.event;
  if (child.type === "prepared") {
    if (child.result.kind === "succeeded") {
      const c = state.conversation;
      if (c.turn.status !== "preparing_model") throw new Error("Prompt outside preparation phase");
      const activeAgent = c.turn.turn.agent;
      const agent = state.configuration.agents.find(([id]) => id === activeAgent)?.[1];
      if (!agent || child.result.value.model !== agent.model)
        throw new Error("Prompt model mismatch");
      const expected = projectSessionPrompt(
        { context: c.context, log: c.log, turn: c.turn.turn, agent },
        state.systemInputs,
      );
      if (JSON.stringify(expected) !== JSON.stringify(child.result.value.messages))
        throw new Error("Prompt differs from captured session projection");
    }
    return {
      ...event,
      event: {
        ...child,
        result:
          child.result.kind === "succeeded"
            ? {
                kind: "succeeded",
                value: PreparedModelSchema.parse({
                  ...child.result.value,
                  baseUrl: "https://journal.invalid",
                }),
              }
            : child.result,
      },
    };
  }
  if (child.type === "model_settled" && child.result.kind === "succeeded") {
    const result = child.result.value;
    const c = state.conversation;
    const activeAgent = c.turn.status === "idle" ? c.turn.agent : c.turn.turn.agent;
    const agent = state.configuration.agents.find(([id]) => id === activeAgent)?.[1];
    if (
      result.kind === "handoff" &&
      !state.configuration.agents.some(([id]) => id === result.agent)
    )
      throw new Error("Unknown handoff agent");
    if (result.kind === "tools" && result.calls.some((call) => !agent?.tools.includes(call.name)))
      throw new Error("Unpermitted tool");
  }
  if (child.type !== "batch_settled") return { ...event, event: child };
  const results = state.partial.flatMap((entry) =>
    entry.result.kind === "succeeded" ? [{ callId: entry.callId, text: entry.result.value }] : [],
  );
  if (JSON.stringify(results) !== JSON.stringify(child.outcome.results))
    throw new Error("Batch results differ from committed individual results");
  if (child.outcome.kind !== "succeeded")
    return { ...event, event: { ...child, outcome: child.outcome } };
  const turn = state.conversation.turn;
  if (turn.status !== "executing_tools" && turn.status !== "cancelling_tools")
    throw new Error("Batch outside tool phase");
  const message = turn.turn.messages.at(-1);
  if (message?.role !== "assistant" || !message.calls) throw new Error("Missing tool intents");
  return {
    ...event,
    event: {
      ...child,
      outcome: { kind: "succeeded", results: completeResults(message.calls, results) },
    },
  };
}
function reduce(
  state: JournalState,
  input: Exclude<SessionInput, { kind: "created" }>,
): { state: JournalState; commands: readonly ConversationCommand[] } {
  if (!accepts(state, input)) throw new Error("Stale or uncorrelated journal input");
  if (input.kind === "system") {
    if (state.conversation.turn.status !== "idle")
      throw new Error("System inputs require idle boundary");
    if (input.version !== state.systemVersion + 1) throw new Error("Invalid system version");
    return {
      state: { ...state, systemInputs: input.inputs, systemVersion: input.version },
      commands: [],
    };
  }
  if (input.kind === "tool")
    return { state: { ...state, partial: [...state.partial, input] }, commands: [] };
  if (input.kind === "recovery") {
    const c = state.conversation;
    if (c.turn.status === "idle" || input.turnId !== c.turnId)
      throw new Error("Recovery requires interrupted turn");
    const messages = MessagesSchema.parse([
      ...c.turn.turn.messages,
      ...state.partial.flatMap((entry) =>
        entry.result.kind === "succeeded"
          ? [{ role: "tool", callId: entry.callId, text: entry.result.value }]
          : [],
      ),
    ]);
    const recovered = decideConversation(
      {
        ...c,
        pending: [],
        turn:
          c.turn.status === "preparing_model"
            ? { ...c.turn, turn: { ...c.turn.turn, messages } }
            : { ...c.turn, turn: { ...c.turn.turn, messages } },
      },
      {
        type: "child",
        turnId: c.turnId,
        event: { type: "failed", child: c.turn.child, error: { message: input.reason } },
      },
    );
    return { state: { ...state, conversation: recovered.state, partial: [] }, commands: [] };
  }
  if (input.systemVersion !== state.systemVersion) throw new Error("Turn system version mismatch");
  const decision = decideConversation(state.conversation, domainEvent(state, input.event));
  return {
    state: {
      ...state,
      conversation: decision.state,
      partial:
        (input.event.type === "child" && input.event.event.type === "batch_settled") ||
        decision.state.sequence !== state.conversation.sequence
          ? []
          : state.partial,
    },
    commands: decision.commands,
  };
}
export function encodeRecord(record: JournalRecord): string {
  return JSON.stringify(JournalRecordSchema.parse(record));
}
export function decodeRecord(serialized: string): JournalRecord {
  return freeze(JournalRecordSchema.parse(JSON.parse(serialized)));
}
export function stage(state: JournalState, input: SessionInput, appendId: AppendId) {
  if (input.kind === "created") {
    if (
      state.revision !== 0 ||
      state.records.length ||
      input.seed.sessionId !== state.conversation.sessionId
    )
      throw new Error("Creation requires an absent stream");
    return stageCreation(input.seed, appendId);
  }
  const decision = reduce(state, input);
  const bodies: JournalBody[] = [input];
  if (decision.state.conversation.sequence !== state.conversation.sequence)
    bodies.push({
      kind: "terminal",
      turnId: state.conversation.turnId,
      record: decision.state.conversation.log.at(-1)!,
    });
  return packageRecords(state, decision.state, bodies, appendId, decision.commands);
}
function packageRecords(
  previous: JournalState,
  next: JournalState,
  bodies: readonly JournalBody[],
  appendId: AppendId,
  commands: readonly ConversationCommand[] = [],
) {
  const records = bodies.map((body, index) =>
    JournalRecordSchema.parse({
      version: 1,
      sessionId: previous.conversation.sessionId,
      revision: previous.revision + index + 1,
      entryId: `${appendId}/${index}`,
      appendId,
      body,
    }),
  );
  const revision = RevisionSchema.parse(previous.revision + records.length);
  return freeze({
    state: { ...next, revision, records: [...previous.records, ...records] },
    records: records.map(encodeRecord),
    commands,
  });
}
export function stageCreation(seed: Seed, appendId: AppendId) {
  const state = seedConversation(seed);
  return packageRecords(state, state, [{ kind: "created", seed }], appendId);
}
export function replay(batches: readonly CommittedBatch[]): JournalState {
  let state: JournalState | undefined;
  let expectedTerminal: { turnId: string; record: TurnRecord } | undefined;
  const entries = new Set<string>();
  const appends = new Set<string>();
  for (const batch of batches) {
    if (
      appends.has(batch.appendId) ||
      batch.expectedRevision !== (state?.revision ?? 0) ||
      batch.revision !== batch.expectedRevision + batch.records.length ||
      !batch.records.length
    )
      throw new Error("Invalid committed batch continuity");
    appends.add(batch.appendId);
    for (const [index, serialized] of batch.records.entries()) {
      const record = decodeRecord(serialized);
      if (
        record.sessionId !== batch.sessionId ||
        record.appendId !== batch.appendId ||
        record.revision !== (state?.revision ?? 0) + 1 ||
        entries.has(record.entryId) ||
        record.entryId !== `${batch.appendId}/${index}`
      )
        throw new Error("Invalid journal identity or revision");
      entries.add(record.entryId);
      const body = record.body;
      if (!state) {
        if (body.kind !== "created" || body.seed.sessionId !== record.sessionId)
          throw new Error("Missing creation record");
        state = seedConversation(body.seed);
      } else {
        if (record.sessionId !== state.conversation.sessionId || body.kind === "created")
          throw new Error("Invalid session identity");
        if (expectedTerminal) {
          if (
            body.kind !== "terminal" ||
            body.turnId !== expectedTerminal.turnId ||
            JSON.stringify(body.record) !== JSON.stringify(expectedTerminal.record)
          )
            throw new Error("Missing or mismatched terminal record");
          expectedTerminal = undefined;
        } else {
          if (body.kind === "terminal") throw new Error("Unexpected terminal record");
          const before = state.conversation;
          state = reduce(state, body).state;
          if (state.conversation.sequence !== before.sequence)
            expectedTerminal = { turnId: before.turnId, record: state.conversation.log.at(-1)! };
        }
      }
      state = { ...state, revision: record.revision, records: [...state.records, record] };
    }
    if (expectedTerminal) throw new Error("Terminal must share atomic transition batch");
  }
  if (!state) throw new Error("Empty journal");
  return freeze(state);
}
export function journalJSONL(state: JournalState): string {
  return `${state.records.map(encodeRecord).join("\n")}\n`;
}
export function journalMarkdown(state: JournalState): string {
  const c = state.conversation;
  const lines = [
    `# Session ${c.sessionId}`,
    `Origin: ${JSON.stringify(c.origin)}`,
    `System version: ${state.systemVersion}`,
    `System inputs: ${JSON.stringify(state.systemInputs)}`,
    `Context: ${JSON.stringify(c.context)}`,
    ...c.log.flatMap((record, index) => [
      `\n## Turn ${index + 1}: ${record.outcome.kind} (${record.agent})`,
      `Outcome: ${JSON.stringify(record.outcome)}`,
      ...record.messages.map((message) => `- ${message.role}: ${JSON.stringify(message)}`),
    ]),
    ...(c.turn.status !== "idle"
      ? [
          `\n## Interrupted/active turn ${c.sequence}: ${c.turn.status}`,
          ...c.turn.turn.messages.map((message) => `- ${message.role}: ${JSON.stringify(message)}`),
          ...state.partial.map((entry) => `- Committed tool outcome: ${JSON.stringify(entry)}`),
        ]
      : []),
    ...state.records.flatMap((record) =>
      record.body.kind === "recovery" ? [`Recovery: ${record.body.reason}`] : [],
    ),
  ];
  return `${lines.join("\n")}\n`;
}
