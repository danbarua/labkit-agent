import type { ConversationEvent } from "../../agent/agent-conversation.ts";
import { PreparedModelSchema } from "../../agent/agent.ts";
import { completeResults } from "../../agent/tool-batch.ts";
import { projectPolicy } from "../../policy/policy.ts";
import { matchingContinuations, type Continuation } from "../../providers/types.ts";
import type { WireEvent } from "../types.ts";
import { partialResults } from "./shared.ts";
import type { Fold, JournalState } from "./state.ts";

/**
 * Converts a conversation event into its journaled form ({@link WireEvent}). A captured prompt
 * keeps only its journaled fields, so connection settings and credentials never enter a journal. A
 * failed dispatch of a turn's child operation becomes a `failed` child event.
 *
 * @throws Error for a failed branch reply, which has no journaled form.
 */
export function domainEvent(state: JournalState, event: WireEvent, fold: Fold): ConversationEvent {
  if (event.type !== "child") return event;
  const child = event.event;
  if (child.type === "prepared") {
    // Staging only: the captured prompt must be today's projection of the folded session.
    if (child.result.kind === "succeeded" && fold.mode === "stage") {
      const c = state.conversation;
      if (c.turn.status !== "preparing_model") throw new Error("Prompt outside preparation phase");
      const activeAgent = c.turn.turn.agent;
      const agent = state.configuration.agents.find(
        ([id]: readonly [string, unknown]) => id === activeAgent,
      )?.[1];
      if (!agent || child.result.value.model !== (state.policy?.model ?? agent.model))
        throw new Error("Prompt model mismatch");
      const selection = state.policy?.provider
        ? {
            provider: state.policy.provider,
            thinking: state.policy.thinking,
            thinkingBudgetTokens: state.policy.thinkingBudgetTokens,
            stream: state.policy.stream,
            maxOutputTokens: state.policy.maxOutputTokens,
            successors:
              agent.successors ??
              state.configuration.agents.map(([id]: readonly [string, unknown]) => id),
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
                  state.configuration.tools.find(
                    ([name]: readonly [string, unknown]) => name === tool.function.name,
                  )?.[1],
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
    const agent = state.configuration.agents.find(
      ([id]: readonly [string, unknown]) => id === activeAgent,
    )?.[1];
    if (
      result.kind === "handoff" &&
      !(
        agent?.successors ??
        state.configuration.agents.map(([id]: readonly [string, unknown]) => id)
      ).includes(result.agent)
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
