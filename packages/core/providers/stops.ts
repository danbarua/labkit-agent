/** Recognize explicit provider terminal signals before parsing a successful completion. */
export function rejectStoppedResponse(body: unknown): void {
  if (!body || typeof body !== "object") return;
  const value = body as Record<string, unknown>;
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};

  const stop = (category: "token_limit" | "refusal", reason: string): never => {
    throw Object.assign(
      new Error(
        category === "token_limit"
          ? `Provider stopped at its token limit (${reason}); adjust the output limit or reduce context as appropriate. No partial completion was accepted.`
          : `Provider refused completion (${reason}). No partial completion was accepted.`,
      ),
      { providerStop: { category, reason } },
    );
  };

  for (const choice of Array.isArray(value.choices) ? value.choices : []) {
    const item = record(choice);
    if (item.finish_reason === "length") stop("token_limit", "length");
    if (item.finish_reason === "content_filter") stop("refusal", "content_filter");
    if (
      [record(item.message).refusal, record(item.delta).refusal].some(
        (value) => typeof value === "string" && value.length > 0,
      )
    )
      stop("refusal", "refusal");
  }
  for (const candidate of Array.isArray(value.candidates) ? value.candidates : []) {
    const reason = record(candidate).finishReason;
    if (reason === "MAX_TOKENS") stop("token_limit", reason);
    if (reason === "SAFETY" || reason === "PROHIBITED_CONTENT" || reason === "RECITATION")
      stop("refusal", reason);
  }
  if (value.status === "incomplete") {
    const reason = record(value.incomplete_details).reason;
    if (reason === "max_output_tokens") stop("token_limit", reason);
    if (reason === "content_filter") stop("refusal", reason);
  }
  for (const output of Array.isArray(value.output) ? value.output : []) {
    const content = record(output).content;
    if (Array.isArray(content) && content.some((part) => record(part).type === "refusal"))
      stop("refusal", "refusal");
  }
}
