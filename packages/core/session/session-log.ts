import {
  decideConversation,
  initialConversation,
  type ConversationCommand,
  type ConversationEvent,
  type ConversationState,
} from "../agent/agent-conversation.ts";
import { PreparedModelSchema } from "../agent/agent.ts";
import type { BlobRef, ContentPart } from "../agent/content.ts";
import { projectConversationPrompt } from "../agent/prompt.ts";
import { completeResults } from "../agent/tool-batch.ts";
import {
  ActorIdSchema,
  MessagesSchema,
  type AgentMessage,
  type TurnData,
  type TurnRecord,
} from "../agent/types.ts";
import { freeze } from "../fsm/fsm.ts";
import {
  builtinResolvers,
  defaultPolicy,
  effectiveToolResult,
  patchPolicy,
  PolicyPatchSchema,
  projectPolicy,
  validatePolicy,
  type Policy,
  type PolicyResolvers,
} from "../policy/policy.ts";
import {
  ContinuationSchema,
  matchingContinuations,
  type Continuation,
} from "../providers/types.ts";
import {
  INITIAL_REVISION,
  RevisionSchema,
  type AppendId,
  type CommittedBatch,
  type Revision,
} from "./persistence.ts";
import { projectSessionPrompt } from "./session-prompt.ts";
import {
  bodyHasBlobs,
  bodyHasPermissions,
  JournalRecordSchema,
  SeedSchema,
  WireEventSchema,
  type Configuration,
  type JournalBody,
  type JournalRecord,
  type Seed,
  type SessionInput,
  type SystemVersionSchema,
  type WireEvent,
} from "./types.ts";

export type ToolEntry = Extract<JournalBody, { kind: "tool" }>;
export type JournalState = Readonly<{
  conversation: ConversationState;
  continuations?: readonly Continuation[];
  policy?: Policy;
  pendingInputs?: readonly Readonly<{
    inputId: ReturnType<typeof ActorIdSchema.parse>;
    text: string;
    attachments?: readonly BlobRef[];
  }>[];
  configuration: Configuration;
  systemInputs: readonly string[];
  systemVersion: ReturnType<typeof SystemVersionSchema.parse>;
  partial: readonly ToolEntry[];
  revision: Revision;
  records: readonly JournalRecord[];
}>;
export function seedConversation(
  raw: Seed,
  resolvers: PolicyResolvers = builtinResolvers,
): JournalState {
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
  if (
    seed.policy &&
    validatePolicy(seed.policy, seed.configuration, resolvers).steps !== seed.allowance
  )
    throw new Error("Policy allowance mismatch");
  if (seed.continuations) {
    const owners = new Set<string>();
    for (const entry of seed.continuations) {
      if (resolvers.providerIds && !resolvers.providerIds.has(entry.provider))
        throw new Error("Missing continuation provider binding");
      const key = JSON.stringify(entry.owner);
      if (
        seed.origin.kind !== "fork" ||
        owners.has(key) ||
        ![...seed.context, ...seed.log.flatMap((record) => record.messages)].some(
          (message) =>
            message.role === "assistant" &&
            message.owner?.turnId === entry.owner.turnId &&
            message.owner.generation === entry.owner.generation,
        )
      )
        throw new Error("Invalid inherited continuation owner");
      owners.add(key);
    }
  }
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
    ...(seed.continuations?.length ? { continuations: seed.continuations } : {}),
    configuration: seed.configuration,
    ...(seed.policy ? { policy: seed.policy, pendingInputs: [] } : {}),
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
    ...(state.policy ? { policy: state.policy } : {}),
    ...(state.continuations?.length && conversation.origin.kind !== "compaction"
      ? {
          continuations: state.continuations.filter((entry) =>
            [
              ...conversation.context,
              ...conversation.log.flatMap((record) => record.messages),
            ].some(
              (message) =>
                message.role === "assistant" &&
                message.owner?.turnId === entry.owner.turnId &&
                message.owner.generation === entry.owner.generation,
            ),
          ),
        }
      : {}),
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
    const {
      model,
      messages,
      tools,
      temperature,
      provider,
      thinking,
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
            ...(provider ? { provider, thinking, stream, maxOutputTokens, successors } : {}),
          },
        },
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
        (entry) =>
          entry.callId === input.callId ||
          effectiveToolResult(entry.result, state.policy).kind !== "succeeded",
      )
    );
  }
  return true;
}
function domainEvent(
  state: JournalState,
  event: WireEvent,
  resolvers: PolicyResolvers,
): ConversationEvent {
  if (event.type !== "child") return event;
  const child = event.event;
  if (child.type === "prepared") {
    if (child.result.kind === "succeeded") {
      const c = state.conversation;
      if (c.turn.status !== "preparing_model") throw new Error("Prompt outside preparation phase");
      const activeAgent = c.turn.turn.agent;
      const agent = state.configuration.agents.find(([id]) => id === activeAgent)?.[1];
      if (!agent || child.result.value.model !== (state.policy?.model ?? agent.model))
        throw new Error("Prompt model mismatch");
      const selection = state.policy?.provider
        ? {
            provider: state.policy.provider,
            thinking: state.policy.thinking,
            stream: state.policy.stream,
            maxOutputTokens: state.policy.maxOutputTokens,
            successors: agent.successors ?? state.configuration.agents.map(([id]) => id),
          }
        : {};
      const captured = child.result.value;
      if (
        JSON.stringify(selection) !==
        JSON.stringify(
          captured.provider
            ? {
                provider: captured.provider,
                thinking: captured.thinking,
                stream: captured.stream,
                maxOutputTokens: captured.maxOutputTokens,
                successors: captured.successors,
              }
            : {},
        )
      )
        throw new Error("Prompt provider selection mismatch");
      const projectionInput = { context: c.context, log: c.log, turn: c.turn.turn, agent };
      const expected = state.policy
        ? projectPolicy(projectionInput, state.systemInputs, state.policy, resolvers)
        : projectSessionPrompt(projectionInput, state.systemInputs);
      const expectedContinuations = matchingContinuations(
        expected,
        state.continuations ?? [],
        captured.provider,
      );
      const canonical = (value: unknown): unknown =>
        Array.isArray(value)
          ? value.map(canonical)
          : value !== null && typeof value === "object"
            ? Object.fromEntries(
                Object.entries(value)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([key, item]) => [key, canonical(item)]),
              )
            : value;
      const keyed = (entries: readonly Continuation[]) =>
        entries
          .map((entry) => [
            JSON.stringify(entry.owner),
            entry.provider,
            canonical(
              entry.payloadBlob ? { payloadBlob: entry.payloadBlob } : { payload: entry.payload },
            ),
          ])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      if (
        JSON.stringify(keyed(expectedContinuations)) !==
        JSON.stringify(keyed(captured.continuations ?? []))
      )
        throw new Error("Prompt continuation mismatch");
      if (state.policy) {
        const allowed = state.policy.tools[activeAgent]!;
        const advertised = child.result.value.tools ?? [];
        if (
          advertised.length !== allowed.length ||
          advertised.some(
            (tool, index) =>
              tool.function.name !== allowed[index] ||
              JSON.stringify(tool.function.parameters) !==
                JSON.stringify(
                  state.configuration.tools.find(([name]) => name === tool.function.name)?.[1],
                ),
          )
        )
          throw new Error("Prompt tool permissions mismatch");
      }
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
                }),
              }
            : child.result,
      },
    };
  }
  if (child.type === "model_settled") {
    const required =
      state.policy?.permissions === "ask" &&
      child.result.kind === "succeeded" &&
      child.result.value.kind === "tools";
    if (!!child.permissionRequired !== required)
      throw new Error("Permission phase differs from captured policy");
  }
  if (child.type === "model_settled" && child.result.kind === "succeeded") {
    const result = child.result.value;
    const c = state.conversation;
    const activeAgent = c.turn.status === "idle" ? c.turn.agent : c.turn.turn.agent;
    const agent = state.configuration.agents.find(([id]) => id === activeAgent)?.[1];
    if (
      result.kind === "handoff" &&
      !(agent?.successors ?? state.configuration.agents.map(([id]) => id)).includes(result.agent)
    )
      throw new Error("Unknown handoff agent");
    if (
      result.kind === "tools" &&
      result.calls.some(
        (call) => !(state.policy?.tools[activeAgent] ?? agent?.tools)?.includes(call.name),
      )
    )
      throw new Error("Unpermitted tool");
  }
  if (child.type !== "batch_settled") return { ...event, event: child };
  const results = partialResults(state);
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
function replaceLastMessage(
  decision: ReturnType<typeof decideConversation>,
  update: (message: AgentMessage) => AgentMessage,
): ReturnType<typeof decideConversation> {
  const c = decision.state;
  const messages = c.turn.status === "idle" ? c.log.at(-1)!.messages : c.turn.turn.messages;
  const target = messages.at(-1)!;
  const attachMessages = (items: readonly AgentMessage[]) =>
    items.map((message) => (message === target ? update(message) : message));
  const attachTurn = (turn: TurnData): TurnData => ({
    ...turn,
    messages: attachMessages(turn.messages),
    view:
      turn.view.kind === "handoff"
        ? { ...turn.view, messages: attachMessages(turn.view.messages) }
        : turn.view,
  });
  const attachLog = (log: readonly TurnRecord[]) =>
    log.map((record) => ({ ...record, messages: attachMessages(record.messages) }));
  // Keep the decorated message in history, handoff views and pending branch commands.
  return {
    state: {
      ...c,
      log: attachLog(c.log),
      turn:
        c.turn.status === "idle"
          ? c.turn
          : ({ ...c.turn, turn: attachTurn(c.turn.turn) } as typeof c.turn),
    },
    commands: decision.commands.map((effect): ConversationCommand =>
      effect.type === "reply"
        ? {
            ...effect,
            result: {
              ...effect.result,
              state: { ...effect.result.state, log: attachLog(effect.result.state.log) },
            },
          }
        : {
            ...effect,
            command:
              "turn" in effect.command
                ? { ...effect.command, turn: attachTurn(effect.command.turn) }
                : effect.command,
          },
    ),
  };
}
function withUserParts(
  decision: ReturnType<typeof decideConversation>,
  text: string,
  attachments?: readonly BlobRef[],
) {
  if (!attachments) return decision;
  const parts: readonly ContentPart[] = [
    ...(text ? [{ type: "text" as const, text }] : []),
    ...attachments.map((ref) => ({ type: "blob" as const, ref })),
  ];
  return replaceLastMessage(decision, (message) => {
    if (message.role !== "user") throw new Error("Input did not produce a user message");
    return { ...message, parts };
  });
}
function reduce(
  state: JournalState,
  input: Exclude<JournalBody, { kind: "created" | "terminal" }>,
  resolvers: PolicyResolvers,
): { state: JournalState; commands: readonly ConversationCommand[] } {
  if (!accepts(state, input)) throw new Error("Stale or uncorrelated journal input");
  if (input.kind === "upgrade" || input.kind === "policy") {
    const c = state.conversation;
    if (c.turn.status !== "idle" || state.pendingInputs?.length)
      throw new Error("Policy changes require an idle boundary");
    const policy = validatePolicy(input.policy, state.configuration, resolvers);
    if (input.kind === "upgrade") {
      if (
        state.policy ||
        JSON.stringify(policy) !== JSON.stringify(defaultPolicy(state.configuration, c.allowance))
      )
        throw new Error("Invalid upgrade boundary");
    } else if (
      !state.policy ||
      JSON.stringify(policy) !==
        JSON.stringify(patchPolicy(state.policy, input.patch, state.configuration, resolvers))
    )
      throw new Error("Invalid policy patch/version");
    return {
      state: {
        ...state,
        policy,
        pendingInputs: state.pendingInputs ?? [],
        conversation: { ...c, allowance: policy.steps, turn: { ...c.turn, steps: policy.steps } },
      },
      commands: [],
    };
  }
  if (input.kind === "queued") {
    const c = state.conversation;
    if (
      !state.policy ||
      input.policyVersion !== state.policy.version ||
      c.turn.status === "idle" ||
      state.records.some(
        (record) => record.body.kind === "queued" && record.body.inputId === input.inputId,
      )
    )
      throw new Error("Invalid queued input");
    if (
      state.policy.admission !== "queue-user" &&
      !(
        state.policy.admission === "abort-tools-on-user" &&
        ["awaiting_permission", "executing_tools", "cancelling_tools"].includes(c.turn.status)
      )
    )
      throw new Error("Policy does not queue this input");
    return {
      state: {
        ...state,
        pendingInputs: [
          ...(state.pendingInputs ?? []),
          {
            inputId: input.inputId,
            text: input.text,
            ...(input.attachments ? { attachments: input.attachments } : {}),
          },
        ],
      },
      commands: [],
    };
  }
  if (input.kind === "input_cancelled") {
    if (!state.pendingInputs?.some((entry) => entry.inputId === input.inputId))
      throw new Error("Unknown cancelled input");
    return {
      state: {
        ...state,
        pendingInputs: state.pendingInputs.filter((entry) => entry.inputId !== input.inputId),
      },
      commands: [],
    };
  }
  if (input.kind === "dequeued") {
    const pending = state.pendingInputs?.[0];
    if (
      state.conversation.turn.status !== "idle" ||
      !pending ||
      pending.inputId !== input.inputId ||
      input.policyVersion !== state.policy?.version
    )
      throw new Error("Invalid dequeue boundary");
    const decision = withUserParts(
      decideConversation(state.conversation, { type: "user", text: pending.text }),
      pending.text,
      pending.attachments,
    );
    return {
      state: {
        ...state,
        conversation: decision.state,
        pendingInputs: state.pendingInputs!.slice(1),
      },
      commands: decision.commands,
    };
  }
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
    if (input.turnId !== c.turnId) throw new Error("Recovery turn mismatch");
    if (c.turn.status === "idle") {
      if (!state.pendingInputs?.length) throw new Error("Recovery requires interrupted work");
      return { state, commands: [] };
    }
    const messages = MessagesSchema.parse([
      ...c.turn.turn.messages,
      ...partialResults(state).map((result) => ({
        role: "tool",
        callId: result.callId,
        text: result.text,
      })),
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
  if (input.policyVersion !== state.policy?.version)
    throw new Error("Turn policy version mismatch");
  if (
    input.event.type === "user" &&
    state.policy &&
    state.conversation.turn.status !== "idle" &&
    (!state.policy.bargeIn || state.policy.admission === "queue-user")
  )
    throw new Error("Policy rejects barge-in");
  const settled =
    input.event.type === "child" && input.event.event.type === "model_settled"
      ? input.event.event
      : undefined;
  const envelope = settled?.continuation;
  if (envelope) {
    ContinuationSchema.parse(envelope);
    const active = state.conversation.turn;
    if (
      settled?.result.kind !== "succeeded" ||
      active.status !== "awaiting_model" ||
      envelope.owner.turnId !== state.conversation.turnId ||
      envelope.owner.generation !== active.turn.generation ||
      envelope.provider !== state.policy?.provider ||
      state.continuations?.some(
        (entry) =>
          entry.owner.turnId === envelope.owner.turnId &&
          entry.owner.generation === envelope.owner.generation,
      )
    )
      throw new Error("Continuation owner/provider mismatch");
  }
  let decision = decideConversation(state.conversation, domainEvent(state, input.event, resolvers));
  if (input.event.type === "user")
    decision = withUserParts(decision, input.event.text, input.event.attachments);
  if (envelope)
    decision = replaceLastMessage(decision, (message) => {
      if (message.role !== "assistant") throw new Error("Completion did not produce an assistant");
      return { ...message, owner: envelope.owner };
    });
  return {
    state: {
      ...state,
      conversation: decision.state,
      ...(envelope ? { continuations: [...(state.continuations ?? []), envelope] } : {}),
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
export function stage(
  state: JournalState,
  input: SessionInput,
  appendId: AppendId,
  resolvers: PolicyResolvers = builtinResolvers,
  inputId = ActorIdSchema.parse(appendId),
) {
  if (input.kind === "created") {
    if (
      state.revision !== 0 ||
      state.records.length ||
      input.seed.sessionId !== state.conversation.sessionId
    )
      throw new Error("Creation requires an absent stream");
    return stageCreation(input.seed, appendId, resolvers);
  }
  let next = state;
  const bodies: JournalBody[] = [];
  const commands: ConversationCommand[] = [];
  const apply = (body: Exclude<JournalBody, { kind: "created" | "terminal" }>) => {
    const before = next;
    const decision = reduce(next, body, resolvers);
    next = decision.state;
    bodies.push(body);
    commands.push(...decision.commands);
    if (next.conversation.sequence !== before.conversation.sequence)
      bodies.push({
        kind: "terminal",
        turnId: before.conversation.turnId,
        record: next.conversation.log.at(-1)!,
      });
  };
  if (input.kind !== "policy" && bodyHasBlobs(input) && !next.policy)
    apply({
      kind: "upgrade",
      policy: defaultPolicy(next.configuration, next.conversation.allowance),
    });
  if (input.kind === "policy") {
    if (!next.policy)
      apply({
        kind: "upgrade",
        policy: defaultPolicy(next.configuration, next.conversation.allowance),
      });
    apply({
      kind: "policy",
      patch: PolicyPatchSchema.parse(input.patch),
      policy: patchPolicy(next.policy!, input.patch, next.configuration, resolvers),
    });
  } else if (
    input.kind === "event" &&
    input.event.type === "user" &&
    next.policy &&
    next.conversation.turn.status !== "idle" &&
    (next.policy.admission === "queue-user" ||
      (next.policy.admission === "abort-tools-on-user" &&
        ["awaiting_permission", "executing_tools", "cancelling_tools"].includes(
          next.conversation.turn.status,
        )))
  ) {
    apply({
      kind: "queued",
      inputId,
      text: input.event.text,
      ...(input.event.attachments ? { attachments: input.event.attachments } : {}),
      policyVersion: next.policy.version,
    });
    if (
      next.policy!.admission === "abort-tools-on-user" &&
      ["awaiting_permission", "executing_tools"].includes(next.conversation.turn.status)
    )
      apply({
        kind: "event",
        event: { type: "abort" },
        systemVersion: next.systemVersion,
        policyVersion: next.policy!.version,
      });
  } else {
    apply(
      input.kind === "event" && next.policy
        ? { ...input, policyVersion: next.policy.version }
        : input,
    );
  }
  if (input.kind === "recovery")
    for (const pending of next.pendingInputs ?? [])
      apply({ kind: "input_cancelled", inputId: pending.inputId, reason: input.reason });
  return packageRecords(state, next, bodies, appendId, commands);
}
function partialResults(state: JournalState) {
  return state.partial.flatMap((entry) => {
    const result = effectiveToolResult(entry.result, state.policy);
    return result.kind === "succeeded" ? [{ callId: entry.callId, text: result.value }] : [];
  });
}
function packageRecords(
  previous: JournalState,
  next: JournalState,
  bodies: readonly JournalBody[],
  appendId: AppendId,
  commands: readonly ConversationCommand[] = [],
) {
  let version = previous.policy?.provider ? 3 : previous.policy ? 2 : 1;
  const records = bodies.map((body, index) => {
    const precedingVersion = version;
    if (body.kind === "upgrade") version = 2;
    if (body.kind === "policy" && body.policy.provider) version = 3;
    if (body.kind === "created")
      version = body.seed.policy?.provider ? 3 : body.seed.policy ? 2 : 1;
    const policy =
      body.kind === "created" ? body.seed.policy : body.kind === "policy" ? body.policy : undefined;
    if (
      (policy?.thinking !== undefined && policy.thinking !== "off") ||
      (body.kind === "created" && body.seed.continuations !== undefined) ||
      (body.kind === "event" &&
        body.event.type === "child" &&
        body.event.event.type === "model_settled" &&
        body.event.event.continuation) ||
      previous.records.at(-1)?.version === 4
    )
      version = 4;
    if (bodyHasBlobs(body) || previous.records.at(-1)?.version === 5) version = 5;
    if (bodyHasPermissions(body)) version = 6;
    version = Math.max(version, precedingVersion, previous.records.at(-1)?.version ?? 1);
    return JournalRecordSchema.parse({
      version,
      sessionId: previous.conversation.sessionId,
      revision: previous.revision + index + 1,
      entryId: `${appendId}/${index}`,
      appendId,
      body,
    });
  });
  const revision = RevisionSchema.parse(previous.revision + records.length);
  return freeze({
    state: { ...next, revision, records: [...previous.records, ...records] },
    records: records.map(encodeRecord),
    commands,
  });
}
export function stageCreation(
  seed: Seed,
  appendId: AppendId,
  resolvers: PolicyResolvers = builtinResolvers,
) {
  const state = seedConversation(seed, resolvers);
  return packageRecords(state, state, [{ kind: "created", seed }], appendId);
}
export function replay(
  batches: readonly CommittedBatch[],
  resolvers: PolicyResolvers = builtinResolvers,
): JournalState {
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
        if (
          record.version !==
          (bodyHasPermissions(body)
            ? 6
            : bodyHasBlobs(body)
              ? 5
              : body.seed.continuations !== undefined ||
                  (body.seed.policy?.thinking !== undefined && body.seed.policy.thinking !== "off")
                ? 4
                : body.seed.policy?.provider
                  ? 3
                  : body.seed.policy
                    ? 2
                    : 1)
        )
          throw new Error("Creation version does not match policy");
        state = seedConversation(body.seed, resolvers);
      } else {
        if (record.sessionId !== state.conversation.sessionId || body.kind === "created")
          throw new Error("Invalid session identity");
        if (
          record.version !==
          (state.records.at(-1)?.version === 6 || bodyHasPermissions(body)
            ? 6
            : state.records.at(-1)?.version === 5 || bodyHasBlobs(body)
              ? 5
              : state.records.at(-1)?.version === 4 ||
                  (body.kind === "policy" &&
                    body.policy.thinking !== undefined &&
                    body.policy.thinking !== "off") ||
                  (body.kind === "event" &&
                    body.event.type === "child" &&
                    body.event.event.type === "model_settled" &&
                    body.event.event.continuation)
                ? 4
                : state.policy?.provider || (body.kind === "policy" && body.policy.provider)
                  ? 3
                  : state.policy || body.kind === "upgrade"
                    ? 2
                    : 1)
        )
          throw new Error("Invalid journal upgrade boundary");
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
          state = reduce(state, body, resolvers).state;
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
    ...(state.policy
      ? [
          `Policy: ${JSON.stringify(state.policy)}`,
          `Pending inputs: ${JSON.stringify(state.pendingInputs)}`,
        ]
      : []),
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
