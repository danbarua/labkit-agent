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
  failure,
  MessagesSchema,
  type AgentMessage,
  type TurnData,
  type TurnRecord,
} from "../agent/types.ts";
import { freeze } from "../fsm/fsm.ts";
import {
  bindingPolicyFields,
  builtinResolvers,
  effectiveToolResult,
  patchPolicy,
  PolicyPatchSchema,
  projectPolicy,
  resolverPolicyFields,
  validatePolicy,
  type Policy,
  type PolicyResolvers,
} from "../policy/policy.ts";
import {
  ContinuationSchema,
  matchingContinuations,
  type Continuation,
} from "../providers/types.ts";
import type { CompletionUsage } from "../providers/usage.ts";
import {
  INITIAL_REVISION,
  RevisionSchema,
  type AppendId,
  type CommittedBatch,
  type Revision,
} from "./persistence.ts";
import {
  BodySchema,
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

/** A `tool` record's body: one tool call's raw result, committed before its tool batch settles. */
export type ToolEntry = Extract<JournalBody, { kind: "tool" }>;

/** Accounting of the latest committed completion that reported usage. */
export type LastCompletionUsage = Readonly<{
  /** Turn whose step produced the completion. */
  turnId: string;
  /** ID of the completion: a child operation of the turn, not a child session. */
  operationId: string;
  usage: CompletionUsage;
}>;

/**
 * Session state folded from journal records: the conversation plus everything the records set.
 * {@link replay} builds it on load; {@link stage} returns the next one for new work. A staged state
 * is a proposal until its append commits.
 */
export type JournalState = Readonly<{
  /** Accounting of the latest committed completion that reported usage; kept when one has none. */
  lastCompletionUsage?: LastCompletionUsage;
  /** Current turn, turn log, inherited context and pending branch requests. */
  conversation: ConversationState;
  /**
   * Provider continuation payloads (such as thinking signatures) committed with settled steps, each
   * owned by the assistant message of one turn and generation.
   */
  continuations?: readonly Continuation[];
  /**
   * Configuration (the user-selectable settings) in force. Policy records are staged only at an
   * idle boundary, so a running turn keeps the policy it started with.
   */
  policy: Policy;
  /**
   * Queued inputs, oldest first, each waiting for the current turn to end. Not the in-memory
   * submissions of `SessionState.queue`.
   */
  pendingInputs?: readonly Readonly<{
    inputId: ReturnType<typeof ActorIdSchema.parse>;
    text: string;
    attachments?: readonly BlobRef[];
  }>[];
  /** The registry (tool and agent definitions); the user-selectable configuration is `policy`. */
  configuration: Configuration;
  /** Standing session instructions, not system notices. */
  systemInputs: readonly string[];
  systemVersion: ReturnType<typeof SystemVersionSchema.parse>;
  /**
   * `tool` records committed for the running tool batch, in commit order. Cleared when the batch
   * settles or the turn ends.
   */
  partial: readonly ToolEntry[];
  /** Revision of the last record in `records`; 0 before the creation record. */
  revision: Revision;
  /** Every record folded so far, in revision order. A staged state ends with uncommitted ones. */
  records: readonly JournalRecord[];
}>;

/**
 * How records fold into state. `stage` admits new work and enforces every commit-time rule against
 * the live resolvers. `load` rebuilds state from committed records: each stored record is taken as
 * written, and only what the fold needs to apply it is checked.
 */
type Fold = Readonly<{ mode: "stage"; resolvers: PolicyResolvers }> | Readonly<{ mode: "load" }>;

const load: Fold = { mode: "load" };

/**
 * Builds the initial state of a new session from its seed under every commit-time rule: the turn
 * sequence against origin and log, a registered starting agent, the policy against the registry and
 * live `resolvers`, inherited continuation owners and provider bindings, and a history that
 * projects into a prompt. Load folds a committed seed without these checks.
 *
 * @throws Error when the seed breaks a commit-time rule; ZodError when it does not parse.
 */
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
  const state = foldSeed(seed);
  // Validate inherited history as well as the replacement context.
  projectConversationPrompt({
    context: seed.context,
    log: seed.log,
    agent: { model: "validation", tools: [] },
    turn: {
      id: state.conversation.turnId,
      agent: seed.agent,
      generation: 0,
      steps: seed.allowance,
      messages: [],
      view: { kind: "history" },
    },
  });
  return state;
}

/** Loading a creation record: the committed seed is the initial state, as written. */
function foldSeed(seed: Seed): JournalState {
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
  return freeze({
    conversation,
    ...(seed.continuations?.length ? { continuations: seed.continuations } : {}),
    configuration: seed.configuration,
    policy: seed.policy,
    pendingInputs: [],
    systemInputs: seed.systemInputs,
    systemVersion: seed.systemVersion,
    partial: [],
    revision: INITIAL_REVISION,
    records: [],
  });
}

/**
 * The seed that starts a fork or compaction child session (not a child operation) from
 * `conversation`. It carries `state`'s registry, policy and standing instructions. Continuations
 * are kept only for a fork, and only those whose assistant message is in the context or log.
 *
 * @param conversation Conversation to seed from, defaulting to `state.conversation`. A branch
 *   passes its branched snapshot, which already holds the child's session ID and origin.
 * @throws Error when `conversation` has a running turn.
 */
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
    policy: state.policy,
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
/**
 * Converts a conversation event into its journaled form ({@link WireEvent}). A captured prompt
 * keeps only its journaled fields, so connection settings and credentials never enter a journal. A
 * failed dispatch of a turn's child operation becomes a `failed` child event.
 *
 * @throws Error for a failed branch reply, which has no journaled form.
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
 * Why a record cannot apply: it names a turn, operation, batch or tool call that does not exist in
 * the folded state. Load checks only this; staging (`accepts`) adds the commit-time rules.
 */
function missingTarget(state: JournalState, input: SessionInput): string | undefined {
  const c = state.conversation;
  if (input.kind === "event" && input.event.type === "child") {
    const { turnId, event } = input.event;
    if (turnId !== c.turnId) return `Event for turn ${turnId}; the current turn is ${c.turnId}`;
    if (c.turn.status === "idle")
      return `Event for ${event.child.kind} ${event.child.id}; turn ${turnId} is idle`;
    if (event.child.id !== c.turn.child.id || event.child.kind !== c.turn.child.kind)
      return `Event for ${event.child.kind} ${event.child.id}; the active operation is ${c.turn.child.kind} ${c.turn.child.id}`;
    return undefined;
  }
  if (input.kind !== "tool") return undefined;
  if (input.turnId !== c.turnId)
    return `Tool result for turn ${input.turnId}; the current turn is ${c.turnId}`;
  if (c.turn.status !== "executing_tools" && c.turn.status !== "cancelling_tools")
    return `Tool result for batch ${input.batchId}; turn ${c.turnId} has no tool batch`;
  if (input.batchId !== c.turn.child.id)
    return `Tool result for batch ${input.batchId}; the active batch is ${c.turn.child.id}`;
  const intents = c.turn.turn.messages.at(-1);
  if (intents?.role !== "assistant" || !intents.calls?.some((call) => call.id === input.callId))
    return `Tool result for call ${input.callId}; batch ${input.batchId} has no such call`;
  return undefined;
}

/**
 * Whether `input` still applies to `state`: the turn, operation, tool batch and call it names are
 * current, and a tool result arrives while its batch runs, once per call, with no earlier result of
 * the batch counting as failed under the policy's `toolFailure`. `false` marks a stale or
 * uncorrelated input: `decideSession` answers `ignored` and {@link stage} throws.
 */
export function accepts(state: JournalState, input: SessionInput): boolean {
  if (missingTarget(state, input)) return false;
  if (input.kind !== "tool") return true;
  // New results arrive only while the batch runs, once per call, and none after a failure.
  return (
    state.conversation.turn.status === "executing_tools" &&
    !state.partial.some(
      (entry) =>
        entry.callId === input.callId ||
        effectiveToolResult(entry.result, state.policy).kind !== "succeeded",
    )
  );
}

function domainEvent(state: JournalState, event: WireEvent, fold: Fold): ConversationEvent {
  if (event.type !== "child") return event;
  const child = event.event;
  if (child.type === "prepared") {
    // Staging only: the captured prompt must be today's projection of the folded session.
    if (child.result.kind === "succeeded" && fold.mode === "stage") {
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
            thinkingBudgetTokens: state.policy.thinkingBudgetTokens,
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
                thinkingBudgetTokens: captured.thinkingBudgetTokens,
                stream: captured.stream,
                maxOutputTokens: captured.maxOutputTokens,
                successors: captured.successors,
              }
            : {},
        )
      )
        throw new Error("Prompt provider selection mismatch");
      const projectionInput = { context: c.context, log: c.log, turn: c.turn.turn, agent };
      const expected = projectPolicy(
        projectionInput,
        state.systemInputs,
        state.policy,
        fold.resolvers,
      );
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
  if (fold.mode === "stage" && child.type === "model_settled") {
    const required =
      state.policy?.permissions === "ask" &&
      child.result.kind === "succeeded" &&
      child.result.value.kind === "tools";
    if (!!child.permissionRequired !== required)
      throw new Error("Permission phase differs from captured policy");
  }
  if (
    fold.mode === "stage" &&
    child.type === "model_settled" &&
    child.result.kind === "succeeded"
  ) {
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
  // Load takes the committed outcome as written; staging requires it to match the tool records.
  const results = fold.mode === "stage" ? partialResults(state) : child.outcome.results;
  if (fold.mode === "stage" && JSON.stringify(results) !== JSON.stringify(child.outcome.results))
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
  fold: Fold,
): { state: JournalState; commands: readonly ConversationCommand[] } {
  if (fold.mode === "stage") {
    if (!accepts(state, input)) throw new Error("Stale or uncorrelated journal input");
  } else {
    const missing = missingTarget(state, input);
    if (missing) throw new Error(missing);
  }
  if (input.kind === "policy") {
    const c = state.conversation;
    // Load: the stored policy is the policy, whatever today's patch rules would derive.
    let policy = input.policy;
    if (fold.mode === "stage") {
      if (c.turn.status !== "idle" || state.pendingInputs?.length)
        throw new Error("Policy changes require an idle boundary");
      policy = validatePolicy(input.policy, state.configuration, fold.resolvers);
      if (
        !state.policy ||
        JSON.stringify(policy) !==
          JSON.stringify(
            patchPolicy(state.policy, input.patch, state.configuration, fold.resolvers),
          )
      )
        throw new Error("Invalid policy patch/version");
    }
    return {
      state: {
        ...state,
        policy,
        pendingInputs: state.pendingInputs ?? [],
        // A running turn keeps the allowance it started with.
        conversation: {
          ...c,
          allowance: policy.steps,
          turn: c.turn.status === "idle" ? { ...c.turn, steps: policy.steps } : c.turn,
        },
      },
      commands: [],
    };
  }
  if (input.kind === "configuration") {
    const c = state.conversation;
    if (fold.mode === "stage" && (c.turn.status !== "idle" || state.pendingInputs?.length))
      throw new Error("Configuration changes require an idle boundary");
    // The switch replaces the idle conversation's agent; a running turn has none to replace.
    if (input.agent !== undefined && c.turn.status !== "idle")
      throw new Error("Configuration agent switch during a running turn");
    const current = c.turn.status === "idle" ? c.turn.agent : c.turn.turn.agent;
    const agent = input.agent ?? current;
    // Load: the stored configuration, policy and agent replace the folded ones as written.
    let policy = input.policy ?? state.policy;
    if (fold.mode === "stage") {
      const registered = new Set(input.configuration.agents.map(([id]) => id));
      // An agent switch is recorded only when the idle conversation's agent was unregistered.
      if (input.agent !== undefined && registered.has(current))
        throw new Error("Configuration agent switch requires an unregistered current agent");
      if (!registered.has(agent))
        throw new Error(`Configuration omits the current agent: ${agent}`);
      if (input.policy) {
        // Reconciliation may rewrite only tool permissions, resolver IDs and binding selections.
        const previous = state.policy;
        const keys = new Set([...Object.keys(previous ?? {}), ...Object.keys(input.policy)]);
        for (const key of ["tools", "version", ...resolverPolicyFields, ...bindingPolicyFields])
          keys.delete(key);
        if (
          !previous ||
          input.policy.version !== previous.version + 1 ||
          [...keys].some(
            (key) =>
              JSON.stringify(previous[key as keyof Policy]) !==
              JSON.stringify(input.policy![key as keyof Policy]),
          )
        )
          throw new Error(
            "Configuration policy may only reconcile tools, resolvers and binding selections",
          );
        policy = validatePolicy(input.policy, input.configuration, fold.resolvers);
      } else if (state.policy) validatePolicy(state.policy, input.configuration, fold.resolvers);
    }
    return {
      state: {
        ...state,
        configuration: input.configuration,
        policy,
        pendingInputs: state.pendingInputs ?? [],
        conversation:
          c.turn.status === "idle" && agent !== c.turn.agent
            ? { ...c, turn: { ...c.turn, agent } }
            : c,
      },
      commands: [],
    };
  }
  if (input.kind === "queued") {
    const c = state.conversation;
    if (fold.mode === "stage") {
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
    }
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
    if (
      fold.mode === "stage" &&
      (state.conversation.turn.status !== "idle" ||
        state.pendingInputs?.[0]?.inputId !== input.inputId ||
        input.policyVersion !== state.policy?.version)
    )
      throw new Error("Invalid dequeue boundary");
    // Load needs only the queued input whose text starts the turn.
    const pending = state.pendingInputs?.find((entry) => entry.inputId === input.inputId);
    if (!pending) throw new Error(`Dequeued input ${input.inputId} is not queued`);
    const decision = withUserParts(
      decideConversation(state.conversation, { type: "user", text: pending.text }),
      pending.text,
      pending.attachments,
    );
    return {
      state: {
        ...state,
        conversation: decision.state,
        pendingInputs: state.pendingInputs!.filter((entry) => entry !== pending),
      },
      commands: decision.commands,
    };
  }
  if (input.kind === "system") {
    if (fold.mode === "stage") {
      if (state.conversation.turn.status !== "idle")
        throw new Error("System inputs require idle boundary");
      if (input.version !== state.systemVersion + 1) throw new Error("Invalid system version");
    }
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
      if (fold.mode === "stage" && !state.pendingInputs?.length)
        throw new Error("Recovery requires interrupted work");
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
        event: {
          type: "failed",
          child: c.turn.child,
          error: failure(input.reason, {
            classification: "interrupted",
            phase: c.turn.status,
            operation: { ...c.turn.child, sessionId: c.sessionId, turnId: c.turnId },
          }),
        },
      },
    );
    return { state: { ...state, conversation: recovered.state, partial: [] }, commands: [] };
  }
  if (fold.mode === "stage") {
    if (input.systemVersion !== state.systemVersion)
      throw new Error("Turn system version mismatch");
    if (input.policyVersion !== state.policy?.version)
      throw new Error("Turn policy version mismatch");
    if (
      input.event.type === "user" &&
      state.policy &&
      state.conversation.turn.status !== "idle" &&
      (!state.policy.bargeIn || state.policy.admission === "queue-user")
    )
      throw new Error("Policy rejects barge-in");
  }
  const settled =
    input.event.type === "child" && input.event.event.type === "model_settled"
      ? input.event.event
      : undefined;
  if (fold.mode === "stage" && settled?.usage && settled.result.kind !== "succeeded")
    throw new Error("Completion usage requires an admitted completion");
  const envelope = settled?.continuation;
  if (envelope) {
    ContinuationSchema.parse(envelope);
    const active = state.conversation.turn;
    if (
      fold.mode === "stage" &&
      (settled?.result.kind !== "succeeded" ||
        active.status !== "awaiting_model" ||
        envelope.owner.turnId !== state.conversation.turnId ||
        envelope.owner.generation !== active.turn.generation ||
        envelope.provider !== state.policy?.provider ||
        state.continuations?.some(
          (entry) =>
            entry.owner.turnId === envelope.owner.turnId &&
            entry.owner.generation === envelope.owner.generation,
        ))
    )
      throw new Error("Continuation owner/provider mismatch");
    // Load keeps the stored owner, but the envelope needs the assistant message its completion made.
    if (settled?.result.kind !== "succeeded")
      throw new Error("Continuation without an admitted completion");
  }
  let decision = decideConversation(state.conversation, domainEvent(state, input.event, fold));
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
      ...(settled?.usage && decision.state !== state.conversation && input.event.type === "child"
        ? {
            lastCompletionUsage: {
              turnId: input.event.turnId,
              operationId: settled.child.id,
              usage: settled.usage,
            },
          }
        : {}),
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

const recordKinds: ReadonlySet<string> = new Set(
  BodySchema.options.map((option) => option.shape.kind.value),
);

const newerBuild =
  "the journal was probably written by a newer Labkit build, so restart the launcher on current code";

/** Why stored bytes do not decode, read from the raw JSON without validating it. */
function decodeFailure(serialized: string): string {
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

/**
 * Stages new work: folds `input` into `state` under every commit-time rule, checked against the
 * live `resolvers` (prompt projection, policy patches and versions, permissions, mid-turn input
 * policy, registry, continuations and tool-result correlation). Load ({@link replay}) never re-runs
 * these rules. Nothing is durable until the returned records commit.
 *
 * One input can stage several records into one append. A record that ends a turn is followed by the
 * turn's `terminal` record. User input the policy queues becomes a `queued` record, followed by an
 * `abort` event under `abort-tools-on-user` while tools run or permission is awaited. `recovery` is
 * followed by `input_cancelled` for every queued input.
 *
 * @param appendId Stable ID of the append; entry IDs are `<appendId>/<index>`.
 * @param inputId Queued-input ID for user input the policy queues; defaults to `appendId`.
 * @returns `state`, the proposed next state, whose `revision` and `records` include the staged
 *   records; `records`, the serialized records to append; `commands`, the conversation commands to
 *   dispatch once the append commits.
 * @throws Error when the input is stale or uncorrelated (see {@link accepts}) or breaks a
 *   commit-time rule; `created` also requires an empty journal.
 */
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
  const fold: Fold = { mode: "stage", resolvers };
  let next = state;
  const bodies: JournalBody[] = [];
  const commands: ConversationCommand[] = [];
  const apply = (body: Exclude<JournalBody, { kind: "created" | "terminal" }>) => {
    const before = next;
    const decision = reduce(next, body, fold);
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
  if (input.kind === "policy") {
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
  const records = bodies.map((body, index) => {
    return JournalRecordSchema.parse({
      version: 1,
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

/**
 * Stages the `created` record of a new session: {@link seedConversation} under the commit-time
 * rules, as a one-record append at revision 1. Load folds the committed seed without these rules.
 *
 * @throws Error or ZodError, as {@link seedConversation} does.
 */
export function stageCreation(
  seed: Seed,
  appendId: AppendId,
  resolvers: PolicyResolvers = builtinResolvers,
) {
  const state = seedConversation(seed, resolvers);
  return packageRecords(state, state, [{ kind: "created", seed }], appendId);
}

/**
 * Integrity rules a committed journal must satisfy to load. Nothing else is checked on load; the
 * commit-time rules run only when new work is staged. "Batch" in these rules is a journal append
 * batch (`CommittedBatch`), except in `record_applicable`, where it is a tool batch.
 */
export type JournalIntegrityRule =
  /** Each append ID is committed once. */
  | "append_unique"
  /** An append batch is non-empty and continues the journal at its expected revision. */
  | "batch_continuity"
  /** A record decodes as a current-format journal record. */
  | "record_decode"
  /** Every record belongs to the batch's and the creation record's session. */
  | "session_identity"
  /** A record carries its batch's append ID. */
  | "append_identity"
  /** Record revisions increase by one from 1. */
  | "revision_sequence"
  /** An entry ID is `<appendId>/<index in batch>`; unique append IDs make entry IDs unique. */
  | "entry_format"
  /** The first record, and only the first, creates the session. */
  | "creation_first"
  /** A record that ends a turn is followed by that turn's terminal record. */
  | "terminal_required"
  /** A terminal record follows a record that ended its turn. */
  | "terminal_unexpected"
  /** A turn's terminal record is committed in the same append as the record that ended the turn. */
  | "terminal_same_batch"
  /**
   * The record applies to the folded state: it names a turn, operation, tool batch, call or queued
   * input the state has. Any other error while folding a record is reported under this rule too.
   */
  | "record_applicable";

/** Position of an offending record: its own fields, or where it was expected when undecodable. */
export type JournalLocation = Readonly<{ revision?: number; appendId?: string; entryId?: string }>;

/**
 * A committed journal that cannot load, naming the violated rule and the offending record. Thrown
 * by {@link replay}. The message reads `Journal integrity (<rule>) at <entryId>: <detail>`.
 */
export class JournalIntegrityError extends Error {
  readonly rule: JournalIntegrityRule;
  /** Revision of the offending record, or where it was expected; absent for an empty journal. */
  readonly revision?: number;
  /** Append ID of the offending record's batch; absent for an empty journal. */
  readonly appendId?: string;
  /** Entry ID of the offending record, or where it was expected; absent for an empty journal. */
  readonly entryId?: string;

  constructor(
    rule: JournalIntegrityRule,
    detail: string,
    at: JournalLocation,
    options?: ErrorOptions,
  ) {
    super(`Journal integrity (${rule}) at ${at.entryId ?? "journal"}: ${detail}`, options);
    this.name = "JournalIntegrityError";
    this.rule = rule;
    this.revision = at.revision;
    this.appendId = at.appendId;
    this.entryId = at.entryId;
  }
}

/**
 * Loads a journal: folds committed batches into state, checking only journal integrity
 * ({@link JournalIntegrityRule}). Each stored record is taken as written. Commit-time rules (prompt
 * projection, policy patches, permissions, admission, bindings) are not re-run, so a journal the
 * runtime committed keeps loading after code, configuration or bindings change. A turn that process
 * exit interrupted stays open in the result; closing it is a separately staged `recovery` record.
 *
 * @throws {@link JournalIntegrityError} naming the first violated rule and the offending record.
 */
export function replay(batches: readonly CommittedBatch[]): JournalState {
  let state: JournalState | undefined;
  let ended: { turnId: string; at: JournalLocation } | undefined;
  const appends = new Set<string>();
  const fold = (at: JournalLocation, apply: () => JournalState) => {
    try {
      return apply();
    } catch (error) {
      throw new JournalIntegrityError(
        "record_applicable",
        error instanceof Error ? error.message : String(error),
        at,
        { cause: error },
      );
    }
  };
  for (const batch of batches) {
    const revision = state?.revision ?? 0;
    // A batch-level failure names the batch's first record as the batch itself describes it.
    const first = {
      revision: batch.expectedRevision + 1,
      appendId: batch.appendId,
      entryId: `${batch.appendId}/0`,
    };
    if (appends.has(batch.appendId))
      throw new JournalIntegrityError(
        "append_unique",
        `Append ${batch.appendId} is committed twice`,
        first,
      );
    if (
      !batch.records.length ||
      batch.expectedRevision !== revision ||
      batch.revision !== batch.expectedRevision + batch.records.length
    )
      throw new JournalIntegrityError(
        "batch_continuity",
        `Batch of ${batch.records.length} records from revision ${batch.expectedRevision} to ${batch.revision}; the journal is at revision ${revision}`,
        first,
      );
    appends.add(batch.appendId);
    for (const [index, serialized] of batch.records.entries()) {
      const expected = {
        revision: (state?.revision ?? 0) + 1,
        appendId: batch.appendId,
        entryId: `${batch.appendId}/${index}`,
      };
      let record: JournalRecord;
      try {
        record = decodeRecord(serialized);
      } catch (error) {
        throw new JournalIntegrityError("record_decode", decodeFailure(serialized), expected, {
          cause: error,
        });
      }
      const at = { revision: record.revision, appendId: record.appendId, entryId: record.entryId };
      const sessionId = state?.conversation.sessionId ?? batch.sessionId;
      if (record.sessionId !== batch.sessionId || record.sessionId !== sessionId)
        throw new JournalIntegrityError(
          "session_identity",
          `Record of session ${record.sessionId} in the journal of session ${sessionId}`,
          at,
        );
      if (record.appendId !== batch.appendId)
        throw new JournalIntegrityError(
          "append_identity",
          `Record of append ${record.appendId} in batch ${batch.appendId}`,
          at,
        );
      if (record.revision !== expected.revision)
        throw new JournalIntegrityError(
          "revision_sequence",
          `Record revision ${record.revision} does not follow revision ${expected.revision - 1}`,
          at,
        );
      if (record.entryId !== expected.entryId)
        throw new JournalIntegrityError(
          "entry_format",
          `Entry ID ${record.entryId} should be ${expected.entryId}`,
          at,
        );
      const body = record.body;
      if (!state) {
        if (body.kind !== "created")
          throw new JournalIntegrityError(
            "creation_first",
            `The first record is ${body.kind}, not created`,
            at,
          );
        if (body.seed.sessionId !== record.sessionId)
          throw new JournalIntegrityError(
            "session_identity",
            `Creation record seeds session ${body.seed.sessionId} in the journal of session ${record.sessionId}`,
            at,
          );
        const seed = body.seed;
        state = fold(at, () => foldSeed(seed));
      } else if (body.kind === "created") {
        throw new JournalIntegrityError("creation_first", "A second creation record", at);
      } else if (ended) {
        if (body.kind !== "terminal" || body.turnId !== ended.turnId)
          throw new JournalIntegrityError(
            "terminal_required",
            `Turn ${ended.turnId} ended at ${ended.at.entryId}, but the next record is ${body.kind === "terminal" ? `the terminal record of turn ${body.turnId}` : body.kind}`,
            at,
          );
        // The stored terminal record is the turn's log entry, whatever the fold derived.
        const c = state.conversation;
        state = {
          ...state,
          conversation: {
            ...c,
            log: [...c.log.slice(0, -1), body.record],
            turn: c.turn.status === "idle" ? { ...c.turn, agent: body.record.agent } : c.turn,
          },
        };
        ended = undefined;
      } else if (body.kind === "terminal") {
        throw new JournalIntegrityError(
          "terminal_unexpected",
          `Terminal record of turn ${body.turnId}, but no turn ended`,
          at,
        );
      } else {
        const before = state;
        state = fold(at, () => reduce(before, body, load).state);
        if (state.conversation.sequence !== before.conversation.sequence)
          ended = { turnId: before.conversation.turnId, at };
      }
      state = { ...state, revision: record.revision, records: [...state.records, record] };
    }
    if (ended)
      throw new JournalIntegrityError(
        "terminal_same_batch",
        `Turn ${ended.turnId} ended without a terminal record in append ${batch.appendId}`,
        ended.at,
      );
  }
  if (!state) throw new JournalIntegrityError("creation_first", "The journal has no records", {});
  return freeze(state);
}

/** The records as JSON Lines: one encoded record per line in revision order, newline-terminated. */
export function journalJSONL(state: JournalState): string {
  return `${state.records.map(encodeRecord).join("\n")}\n`;
}
/**
 * Renders the journal as a Markdown report for people: agent system prompts, standing instruction
 * history, context, turn log, any unfinished turn, permission decisions, recoveries and registry
 * adoptions. A readable view only; the journal remains the authoritative record.
 *
 * @param options.agentLabels Display names by agent ID.
 */
export function journalMarkdown(
  state: JournalState,
  options: { agentLabels?: Readonly<Record<string, string>> } = {},
): string {
  const c = state.conversation;
  const label = (id: string) =>
    options.agentLabels?.[id] ? `${options.agentLabels[id]} (agent ID: ${id})` : `Agent ${id}`;
  const block = (value: unknown) => {
    const text = JSON.stringify(value, null, 2);
    const fence = "`".repeat(
      Math.max(3, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length + 1)),
    );
    return `${fence}json\n${text}\n${fence}`;
  };
  const quote = (text: string) =>
    text
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
  const message = (m: AgentMessage): string[] => {
    const title =
      m.role === "tool"
        ? `Tool result — call ${m.callId}`
        : m.role[0]!.toUpperCase() + m.role.slice(1);
    let content = quote(m.text);
    if (m.role === "tool") {
      // Tool messages are text at this boundary. Pretty-print JSON when present, retaining literal text otherwise.
      try {
        const parsed: unknown = JSON.parse(m.text);
        if (parsed !== null && typeof parsed === "object") content = block(parsed);
      } catch {
        /* Literal tool text is valid and is rendered unchanged. */
      }
    }
    const lines = [`### ${title}`, "", ...(m.text ? [content, ""] : [])];
    if (m.role === "assistant" && m.calls) {
      for (const call of m.calls)
        lines.push(`**Tool call: ${call.name}** (call ID: ${call.id})`, "", block(call.args), "");
    }
    if (m.role !== "tool") {
      for (const part of m.parts ?? []) {
        if (part.type === "blob")
          lines.push(
            `Attachment: **${part.ref.name ?? "Unnamed attachment"}** — ${part.ref.media}, ${part.ref.bytes} bytes.`,
            "",
            `Blob ID: \`${part.ref.id}\` (bytes are stored separately).`,
            "",
          );
      }
    }
    return lines;
  };
  const lines = [
    `# Session ${c.sessionId}`,
    "",
    `Revision: ${state.revision}. System instruction version: ${state.systemVersion}.`,
    "",
  ];
  if (c.origin.kind === "root") lines.push("Origin: new root session.", "");
  else
    lines.push(
      `Origin: ${c.origin.kind} of session \`${c.origin.parent}\` at parent sequence ${c.origin.sequence}.`,
      "",
    );
  lines.push("## Agent system prompts", "");
  for (const [id, agent] of state.configuration.agents)
    lines.push(
      `### ${label(id)}`,
      "",
      agent.systemPrompt ? quote(agent.systemPrompt) : "No configured system prompt.",
      "",
    );
  const instructionRecords = state.records.flatMap((record) => {
    const body = record.body;
    if (body.kind === "created")
      return [
        {
          revision: record.revision,
          version: body.seed.systemVersion,
          inputs: body.seed.systemInputs,
        },
      ];
    if (body.kind === "system")
      return [{ revision: record.revision, version: body.version, inputs: body.inputs }];
    return [];
  });
  lines.push("## Session instruction history", "");
  for (const entry of instructionRecords)
    lines.push(
      `### Revision ${entry.revision} — instruction version ${entry.version}`,
      "",
      ...(entry.inputs.length
        ? entry.inputs.flatMap((text) => [quote(text), ""])
        : ["No shared instructions.", ""]),
    );
  if (state.systemInputs.length)
    lines.push(
      "## Shared instructions",
      "",
      ...state.systemInputs.flatMap((text) => [quote(text), ""]),
    );
  if (c.context.length)
    lines.push("## Inherited or replacement context", "", ...c.context.flatMap(message));
  if (!c.log.length) lines.push("No terminal turns have been committed.", "");
  c.log.forEach((record, index) => {
    lines.push(
      `## Turn ${index + 1} — ${record.outcome.kind}`,
      "",
      `Responsible agent: ${label(record.agent)}.`,
      "",
      ...record.messages.flatMap(message),
    );
    const outcome = record.outcome;
    lines.push(
      `**Outcome:** ${outcome.kind}${outcome.kind === "failed" ? ` — ${outcome.error.message}` : outcome.kind === "exhausted" ? " — model-step allowance reached" : outcome.kind === "aborted" ? " — turn cancelled" : ""}.`,
      "",
    );
  });
  if (c.turn.status !== "idle")
    lines.push(
      `## Unfinished turn — ${c.turn.status}`,
      "",
      ...c.turn.turn.messages.flatMap(message),
      ...state.partial.flatMap((entry) => [
        "Committed partial tool outcome:",
        "",
        block(entry),
        "",
      ]),
    );
  const permissions = state.records.flatMap(({ body }) => {
    if (
      body.kind !== "event" ||
      body.event.type !== "child" ||
      body.event.event.type !== "permission_settled"
    )
      return [];
    const result = body.event.event.result;
    return [
      `Turn ID: \`${body.event.turnId}\``,
      "",
      ...(result.kind === "succeeded"
        ? result.value.map(
            (decision) =>
              `- Call ${decision.callId}: **${decision.decision}**${decision.decision === "invalid_input" ? ` — ${decision.error.message}` : decision.approval ? ` — ${decision.approval.scope}, ${decision.approval.source}, grant ${decision.approval.grantId}` : ""}`,
          )
        : [
            `Permission operation: ${result.kind}${result.kind === "failed" ? ` — ${result.error.message}` : ""}.`,
          ]),
      "",
    ];
  });
  if (permissions.length) lines.push("## Recorded permission decisions", "", ...permissions);
  for (const { body, revision } of state.records) {
    if (body.kind === "recovery") lines.push("## Recovery", "", quote(body.reason), "");
    if (body.kind === "configuration")
      lines.push(
        `## Registry adopted at revision ${revision}`,
        "",
        `Agents: ${body.configuration.agents.map(([id]) => id).join(", ")}.`,
        "",
        `Tools: ${body.configuration.tools.map(([name]) => name).join(", ") || "none"}.`,
        "",
        ...(body.agent ? [`Conversation continues with ${label(body.agent)}.`, ""] : []),
        ...(body.policy
          ? [`Tool permissions reconciled as policy version ${body.policy.version}.`, ""]
          : []),
      );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
