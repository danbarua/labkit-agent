import { z } from "zod";

const tokens = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const source = z
  .strictObject({
    provider: z.string().min(1),
    model: z.string().min(1),
    wireModel: z.string().min(1),
    profile: z.string().min(1),
    httpRequestId: z.string().min(1),
    providerRequestId: z.string().min(1).optional(),
  })
  .readonly();

/** Per-response accounting. These values are not a current-context estimate or a bill. */
export const CompletionUsageSchema = z.discriminatedUnion("status", [
  z
    .strictObject({
      status: z.literal("reported"),
      inputTokens: tokens.optional(),
      outputTokens: tokens.optional(),
      totalTokens: tokens.optional(),
      native: z.record(z.string(), z.json()).readonly(),
      source: source.optional(),
    })
    .readonly(),
  z
    .strictObject({
      status: z.literal("invalid"),
      native: z.json(),
      error: z.string().min(1),
      source: source.optional(),
    })
    .readonly(),
]);

export type CompletionUsage = z.infer<typeof CompletionUsageSchema>;

export function decodeUsage(
  body: unknown,
  dialect: "anthropic" | "chat" | "responses" | "google",
): CompletionUsage | undefined {
  const response = z.record(z.string(), z.unknown()).parse(body);
  const value = response[dialect === "google" ? "usageMetadata" : "usage"];
  if (value == null) return undefined;
  try {
    return normalizeUsage(value, dialect);
  } catch (cause) {
    return CompletionUsageSchema.parse({
      status: "invalid",
      native: value,
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

function normalizeUsage(
  value: unknown,
  dialect: "anthropic" | "chat" | "responses" | "google",
): CompletionUsage {
  const native = z.record(z.string(), z.json()).parse(value);
  const count = (key: string) => {
    if (native[key] === undefined) return undefined;
    const parsed = tokens.safeParse(native[key]);
    if (!parsed.success)
      throw new Error(
        `Invalid ${dialect} usage.${key}: expected a nonnegative safe integer, received ${JSON.stringify(native[key])}`,
        { cause: parsed.error },
      );
    return parsed.data;
  };

  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let totalTokens: number | undefined;
  if (dialect === "anthropic") {
    const uncached = count("input_tokens");
    const read = count("cache_read_input_tokens");
    const written = count("cache_creation_input_tokens");
    inputTokens = uncached === undefined ? undefined : uncached + (read ?? 0) + (written ?? 0);
    outputTokens = count("output_tokens");
    totalTokens =
      inputTokens === undefined || outputTokens === undefined
        ? undefined
        : inputTokens + outputTokens;
  } else if (dialect === "google") {
    inputTokens = count("promptTokenCount");
    const candidates = count("candidatesTokenCount");
    const thoughts = count("thoughtsTokenCount");
    outputTokens = candidates === undefined ? undefined : candidates + (thoughts ?? 0);
    totalTokens = count("totalTokenCount");
  } else {
    inputTokens = count(dialect === "chat" ? "prompt_tokens" : "input_tokens");
    outputTokens = count(dialect === "chat" ? "completion_tokens" : "output_tokens");
    totalTokens = count("total_tokens");
  }
  return CompletionUsageSchema.parse({
    status: "reported",
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    native,
  });
}
