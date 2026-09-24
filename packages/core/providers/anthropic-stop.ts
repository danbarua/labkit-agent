/** Keep scalar failure evidence without including provider content or arbitrary error bodies. */
export function anthropicStopReason(
  value: unknown,
  usage?: unknown,
): "end_turn" | "tool_use" | "stop_sequence" {
  if (value === "end_turn" || value === "tool_use" || value === "stop_sequence") return value;
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
  throw new Error(
    `Anthropic completion stopped: stop_reason=${reason}${counts.length ? ` (${counts.join(", ")})` : ""}.${hint} No partial completion was accepted.`,
  );
}
