import { z } from "zod";

import { anthropicMessagesV2 } from "./anthropic-messages-v2.ts";
import { googleGenerateV2 } from "./google-generate-v2.ts";
import { openaiChat } from "./openai-chat.ts";
import { openaiResponsesV2 } from "./openai-responses-v2.ts";
import {
  anthropicAssembler,
  chatAssembler,
  googleAssembler,
  responsesAssembler,
} from "./stream-assemblers.ts";
import { parseRequest, type CompletionProfile } from "./types.ts";

/** New IDs preserve the base dialect's payload codec; owner/provider joins use the new ID. */
function streamingProfile(
  base: CompletionProfile,
  id: string,
  stream: NonNullable<CompletionProfile["stream"]>,
  dialect: "chat" | "google" | "messages" | "responses",
): CompletionProfile {
  return {
    ...base,
    id,
    capabilities: { ...base.capabilities, stream: true },
    stream,
    encode(raw, blobs) {
      const request = parseRequest(raw, id, true);
      const encoded = base.encode(
        {
          ...request,
          stream: false,
          ...(request.provider ? { provider: base.id } : {}),
          ...(request.continuations
            ? {
                continuations: request.continuations.map((entry) => ({
                  ...entry,
                  provider: base.id,
                })),
              }
            : {}),
        },
        blobs,
      );
      if (!request.stream) return encoded;
      const body = z.record(z.string(), z.unknown()).parse(encoded.body);
      if (dialect === "google")
        return {
          ...encoded,
          path: encoded.path.replace(/:generateContent$/, ":streamGenerateContent"),
          query: { alt: "sse" },
        };
      return {
        ...encoded,
        body: {
          ...body,
          stream: true,
          ...(dialect === "chat" ? { stream_options: { include_usage: true } } : {}),
        },
      };
    },
  };
}
export const openaiChatV2 = streamingProfile(openaiChat, "openai-chat@2", chatAssembler, "chat");
export const anthropicMessagesV3 = streamingProfile(
  anthropicMessagesV2,
  "anthropic-messages@3",
  anthropicAssembler,
  "messages",
);
export const googleGenerateV3 = streamingProfile(
  googleGenerateV2,
  "google-generate@3",
  googleAssembler,
  "google",
);
export const openaiResponsesV3 = streamingProfile(
  openaiResponsesV2,
  "openai-responses@3",
  responsesAssembler,
  "responses",
);
