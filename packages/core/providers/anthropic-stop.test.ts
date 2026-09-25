import { expect, test } from "@logtape/testing-bun/autoload";

import { PreparedModelSchema } from "../agent/agent.ts";
import { anthropicStopReason } from "./anthropic-stop.ts";
import {
  anthropicMessages,
  anthropicMessagesV2,
  anthropicMessagesV3,
  anthropicMessagesV4,
  bindProviders,
} from "./index.ts";
import { streamResponse, streamVector } from "./testing/stream-vectors.ts";

for (const reason of ["max_tokens", "model_context_window_exceeded", "pause_turn", "refusal"]) {
  test(`Anthropic ${reason} preserves scalar evidence in streamed and nonstream failures`, async () => {
    for (const profile of [
      anthropicMessages,
      anthropicMessagesV2,
      anthropicMessagesV3,
      anthropicMessagesV4,
    ]) {
      expect(() =>
        profile.decode({
          status: 200,
          headers: new Headers(),
          body: {
            role: "assistant",
            stop_reason: reason,
            content: [{ type: "text", text: "PRIVATE_CONTENT" }],
            usage: { output_tokens: 4096 },
          },
        }),
      ).toThrow(`stop_reason=${reason} (output_tokens=4096)`);
    }
    let decoded = false;
    const profile = {
      ...anthropicMessagesV4,
      decode() {
        decoded = true;
        throw new Error("must not decode partial output");
      },
    };
    const events = streamVector(anthropicMessagesV3).map((event) => {
      const data = JSON.parse(event.data);
      if (data.type === "message_delta") {
        data.delta.stop_reason = reason;
        data.usage = { output_tokens: 4096, private_field: "PRIVATE_CONTENT" };
      }
      return { ...event, data: JSON.stringify(data) };
    });
    const port = bindProviders(
      new Map([
        [
          profile.id,
          {
            profile,
            transport: {
              baseUrl: "https://example.invalid",
              fetch: (async () => streamResponse(events)) as unknown as typeof fetch,
            },
          },
        ],
      ]),
    );
    await expect(
      port.complete(
        PreparedModelSchema.parse({
          maxOutputTokens: 16384,
          provider: profile.id,
          model: "m",
          messages: [],
          stream: true,
        }),
        new AbortController().signal,
      ),
    ).rejects.toThrow(`stop_reason=${reason} (output_tokens=4096)`);
    expect(decoded).toBe(false);
  });
}

test("stop diagnostics exclude arbitrary content and nonnumeric usage", () => {
  try {
    anthropicStopReason("PRIVATE\nCONTENT", {
      output_tokens: "PRIVATE_CONTENT",
      input_tokens: 12,
      other: "PRIVATE_CONTENT",
    });
    throw new Error("expected failure");
  } catch (error) {
    expect(String(error)).toContain("stop_reason=invalid_or_missing (input_tokens=12)");
    expect(String(error)).not.toContain("PRIVATE");
  }
});
