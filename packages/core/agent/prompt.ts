import type { ChatMessage } from "./agent.ts";
import {
  MessagesSchema,
  ToolCallsSchema,
  type AgentMessage,
  type TurnData,
  type TurnRecord,
} from "./types.ts";

/** Everything prompt projection may draw on to build the next step's request. */
export type PromptInput = Readonly<{
  /** Session context placed before the finished turns, e.g. a compaction's replacement context. */
  context?: readonly AgentMessage[];
  /** Finished turns of this session, oldest first. */
  log: readonly TurnRecord[];
  /** The turn in progress. Its `view` decides whether history or the handoff packet is sent. */
  turn: TurnData;
  /**
   * The agent that will run the step. {@link projectConversationPrompt} uses only `systemPrompt`;
   * the other fields are for custom projections.
   */
  agent: Readonly<{
    successors?: readonly string[];
    model: string;
    systemPrompt?: string;
    tools: readonly string[];
  }>;
}>;

function completedExchanges(
  messages: readonly AgentMessage[],
  source: string,
  interrupted = false,
): AgentMessage[] {
  const output: AgentMessage[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role === "tool")
      throw new Error(`Invalid tool history in ${source}: orphan result ${message.callId}`);
    if (message.role !== "assistant" || !message.calls) {
      output.push(message);
      continue;
    }
    const results: Extract<AgentMessage, { role: "tool" }>[] = [];
    while (messages[index + 1]?.role === "tool") {
      const next = messages[++index]!;
      if (next.role === "tool") results.push(next);
    }
    const ids = new Set(message.calls.map((call) => call.id));
    const resultIds = new Set(results.map((result) => result.callId));
    if (resultIds.size !== results.length || results.some((result) => !ids.has(result.callId))) {
      throw new Error(`Invalid tool history in ${source}: duplicate or unmatched tool IDs`);
    }
    const missing = message.calls.filter((call) => !resultIds.has(call.id));
    if (missing.length && !(interrupted && index === messages.length - 1)) {
      throw new Error(
        `Invalid tool history in ${source}: missing results for ${missing.map((call) => call.id).join(", ")}`,
      );
    }
    const calls = message.calls.filter((call) => resultIds.has(call.id));
    output.push(
      calls.length
        ? { ...message, calls: ToolCallsSchema.parse(calls) }
        : {
            role: "assistant",
            text: message.text,
            ...(message.parts ? { parts: message.parts } : {}),
            ...(message.owner ? { owner: message.owner } : {}),
          },
    );
    output.push(...results);
  }
  return output;
}

/** Replacement context must contain complete, correlated exchanges. */
const SessionContextSchema = MessagesSchema.transform((messages) => {
  completedExchanges(messages, "session context");
  return messages;
}).brand<"SessionContext">();
/**
 * Session context that was checked to hold only complete, correlated tool exchanges.
 * Build it with {@link parseSessionContext}.
 */
export type SessionContext = ReturnType<typeof SessionContextSchema.parse>;
/**
 * Validates messages as session context, for example a compaction's replacement context.
 * @throws When a message is invalid, or a tool exchange has an orphan, duplicate, unmatched or
 * missing result.
 */
export const parseSessionContext = (raw: unknown): SessionContext =>
  SessionContextSchema.parse(raw);

/**
 * The default prompt projection: builds the chat messages for the next step.
 *
 * The agent's `systemPrompt`, when set, comes first as a `system` message. Then, with a `history`
 * view: session context, every finished turn and the current turn's messages. With a `handoff`
 * view: only the handoff packet. Stored history is not changed.
 *
 * Tool exchanges must be complete. The one exception is the last exchange of a finished turn that
 * did not complete: calls without results are dropped from the request.
 *
 * @throws When any source (including one the view does not send) has an orphan, duplicate or
 * unmatched tool result, or a tool call without a result outside that exception.
 */
export function projectConversationPrompt({
  context = [],
  log,
  turn,
  agent,
}: PromptInput): ChatMessage[] {
  const base = completedExchanges(context, "session context");
  const history = log.flatMap((record, index) =>
    completedExchanges(
      record.messages,
      `logged turn ${index + 1}`,
      record.outcome.kind !== "completed",
    ),
  );
  const current = completedExchanges(turn.messages, "current turn");
  const messages =
    turn.view.kind === "handoff"
      ? completedExchanges(turn.view.messages, "handoff packet")
      : [...base, ...history, ...current];
  return [
    ...(agent.systemPrompt ? [{ role: "system" as const, content: agent.systemPrompt }] : []),
    ...messages.map((message): ChatMessage => {
      if (message.role === "tool")
        return { role: "tool", content: message.text, tool_call_id: message.callId };
      if (message.role === "assistant" && message.calls)
        return {
          role: "assistant",
          content: message.text,
          ...(message.parts ? { parts: message.parts } : {}),
          ...(message.owner ? { owner: message.owner } : {}),
          tool_calls: message.calls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          })),
        };
      return {
        role: message.role,
        content: message.text,
        ...(message.parts ? { parts: message.parts } : {}),
        ...(message.role === "assistant" && message.owner ? { owner: message.owner } : {}),
      };
    }),
  ];
}
