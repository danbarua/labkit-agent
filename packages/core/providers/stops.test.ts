import { expect, test } from "@logtape/testing-bun/autoload";

import { PreparedModelSchema } from "../agent/agent.ts";
import { failure } from "../agent/types.ts";
import { bindProviders, googleGenerateV3, openaiChatV2, openaiResponsesV3 } from "./index.ts";
import { streamResponse, streamVector } from "./testing/stream-vectors.ts";

for (const profile of [openaiChatV2, openaiResponsesV3, googleGenerateV3]) {
  for (const stream of [false, true]) {
    test(`${profile.id} preserves typed token limit through transport (stream=${stream})`, async () => {
      const chat = profile.id === openaiChatV2.id;
      const google = profile.id === googleGenerateV3.id;
      const reason = chat ? "length" : google ? "MAX_TOKENS" : "max_output_tokens";
      const body = chat
        ? { choices: [{ finish_reason: reason, message: { content: "partial" } }] }
        : google
          ? { candidates: [{ finishReason: reason, content: { parts: [{ text: "partial" }] } }] }
          : { status: "incomplete", incomplete_details: { reason }, output: [] };
      let requests = 0;
      const binding = bindProviders(
        new Map([
          [
            "test",
            {
              profile,
              transport: {
                baseUrl: "https://example.invalid",
                fetch: (async () => {
                  requests++;
                  if (!stream) return Response.json(body);
                  const events = streamVector(profile).map((event) => {
                    if (event.data === "[DONE]") return event;
                    const data = JSON.parse(event.data);
                    if (chat && data.choices?.[0]?.finish_reason)
                      data.choices[0].finish_reason = reason;
                    if (google && data.candidates?.[0]?.finishReason)
                      data.candidates[0].finishReason = reason;
                    if (data.type === "response.completed") {
                      data.type = "response.incomplete";
                      data.response.status = "incomplete";
                      data.response.incomplete_details = { reason };
                      return { event: data.type, data: JSON.stringify(data) };
                    }
                    return { ...event, data: JSON.stringify(data) };
                  });
                  return streamResponse(events);
                }) as unknown as typeof fetch,
              },
            },
          ],
        ]),
      );
      let observed: unknown;
      try {
        await binding.complete(
          PreparedModelSchema.parse({
            provider: "test",
            model: "m",
            messages: [],
            stream,
            maxOutputTokens: 4096,
          }),
          new AbortController().signal,
        );
      } catch (error) {
        observed = error;
      }
      expect(observed).toBeInstanceOf(Error);
      expect(failure(observed)).toMatchObject({
        providerStop: { category: "token_limit", reason },
      });
      expect(requests).toBe(1);
    });
  }
}
