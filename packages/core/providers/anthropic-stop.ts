import { diagnostic } from "../logging/index.ts";

/** Keep scalar failure evidence without including provider content or arbitrary error bodies. */
export function anthropicStopReason(
  value: unknown,
  usage?: unknown,
): "end_turn" | "tool_use" | "stop_sequence" | "max_tokens" {
  if (
    value === "end_turn" ||
    value === "tool_use" ||
    value === "stop_sequence" ||
    value === "max_tokens"
  )
    return value;
  const reason =
    typeof value === "string" && /^[a-z_]{1,64}$/.test(value) ? value : "invalid_or_missing";
  const counts: string[] = [];
  if (usage && typeof usage === "object") {
    for (const key of ["input_tokens", "output_tokens"] as const) {
      const count = (usage as Record<string, unknown>)[key];
      if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0)
        counts.push(`${key}=${count}`);
    }
  }
  const hint =
    reason === "max_tokens"
      ? " Output token limit reached; increase maxOutputTokens or narrow the request."
      : reason === "model_context_window_exceeded"
        ? " Model context window exhausted; compact or narrow the conversation."
        : "";
  const error = new Error(
    `Anthropic completion stopped: stop_reason=${reason}${counts.length ? ` (${counts.join(", ")})` : ""}.${hint} No partial completion was accepted.`,
  );
  if (reason === "max_tokens" || reason === "model_context_window_exceeded" || reason === "refusal")
    Object.assign(error, {
      providerStop: { category: reason === "refusal" ? "refusal" : "token_limit", reason },
    });
  throw error;
}

export function retainedTruncation(
  content: readonly { type?: string; text?: string; thinking?: string }[],
  usage?: unknown,
) {
  const text = content
    .flatMap((part) =>
      part.type === "text" && part.text
        ? [part.text]
        : part.type === "thinking" && part.thinking
          ? [part.thinking]
          : [],
    )
    .join("");
  if (!text)
    throw new Error(
      `Anthropic completion stopped: stop_reason=max_tokens. Output token limit reached; the response contained no text to retain.`,
    );
  diagnostic("provider", "warning", "completion.truncated", {
    stopReason: "max_tokens",
    retainedCharacters: text.length,
    ...(usage && typeof usage === "object" ? { usage } : {}),
    message:
      "Output token limit reached. The produced text was retained and tool calls were not executed.",
  });
  return text;
}
