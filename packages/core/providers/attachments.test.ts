import { expect, test } from "@logtape/testing-bun/autoload";

import { BlobRefSchema, hashBlob } from "../agent/content.ts";
import { MessageSchema } from "../agent/types.ts";
import {
  anthropicMessages,
  anthropicMessagesV2,
  CompletionRequestSchema,
  googleGenerate,
  openaiChat,
  openaiResponses,
} from "./index.ts";

const markdown = new TextEncoder().encode("# Design\nPinned review content.");
const ref = BlobRefSchema.parse({
  id: hashBlob(markdown),
  media: "text/markdown",
  bytes: markdown.length,
  name: "DESIGN.md",
});
const input = CompletionRequestSchema.parse({
  maxOutputTokens: 16384,
  model: "fixture-model",
  messages: [
    {
      role: "user",
      text: "Review",
      parts: [
        { type: "text", text: "Review" },
        { type: "blob", ref },
      ],
    },
  ],
  tools: [],
  successors: [],
});

test("all profiles inline small markdown while retaining refs on the canonical request", () => {
  const text = "Review\n# Design\nPinned review content.";
  const resolver = (id: typeof ref.id) => {
    expect(id).toBe(ref.id);
    return markdown;
  };
  expect(openaiChat.encode(input, resolver).body).toMatchObject({
    messages: [{ role: "user", content: text }],
  });
  expect(openaiResponses.encode(input, resolver).body).toMatchObject({
    input: [{ role: "user", content: text }],
  });
  expect(googleGenerate.encode(input, resolver).body).toMatchObject({
    contents: [{ role: "user", parts: [{ text }] }],
  });
  expect(anthropicMessages.encode(input, resolver).body).toMatchObject({
    messages: [{ role: "user", content: [{ type: "text", text }] }],
  });
  expect(anthropicMessagesV2.encode(input, resolver).body).toMatchObject({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Review" },
          { type: "text", text: "# Design\nPinned review content." },
        ],
      },
    ],
  });
  expect(input.messages[0]).toMatchObject({
    parts: [
      { type: "text", text: "Review" },
      { type: "blob", ref },
    ],
  });
});

test("large text uses a named hash stub; invalid bytes and unsupported media fail closed", () => {
  const bytes = new Uint8Array(65537).fill(65);
  const large = { ...ref, id: hashBlob(bytes), bytes: bytes.length };
  const request = CompletionRequestSchema.parse({
    ...input,
    messages: [{ role: "user", text: "", parts: [{ type: "blob", ref: large }] }],
  });
  expect(openaiChat.encode(request, () => bytes).body).toMatchObject({
    messages: [{ role: "user", content: `[attached: DESIGN.md sha256:${large.id}]` }],
  });
  expect(() => openaiChat.encode(request, () => markdown)).toThrow("do not match");
  expect(() => openaiChat.encode(input)).toThrow("resolver");
  for (const media of ["image/png", "application/pdf"] as const)
    expect(() =>
      openaiChat.encode(
        CompletionRequestSchema.parse({
          ...input,
          messages: [{ role: "user", text: "", parts: [{ type: "blob", ref: { ...ref, media } }] }],
        }),
        () => markdown,
      ),
    ).toThrow("media");
});

for (const media of ["image/png", "image/jpeg", "application/pdf"] as const)
  test(`Anthropic v2 encodes ${media} by BlobId`, () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const image = { id: hashBlob(bytes), bytes: bytes.length, media, name: "image" };
    const request = CompletionRequestSchema.parse({
      ...input,
      messages: [{ role: "user", text: "", parts: [{ type: "blob", ref: image }] }],
    });
    expect(
      anthropicMessagesV2.encode(request, (id) => {
        expect(id).toBe(image.id);
        return bytes;
      }).body,
    ).toMatchObject({
      messages: [
        {
          role: "user",
          content: [
            {
              type: media === "application/pdf" ? "document" : "image",
              source: { type: "base64", media_type: media, data: "AQID" },
            },
          ],
        },
      ],
    });
  });

test("message text must agree with text parts and tools cannot carry parts", () => {
  expect(() =>
    MessageSchema.parse({
      role: "user",
      text: "different",
      parts: [{ type: "text", text: "body" }],
    }),
  ).toThrow();
  expect(
    MessageSchema.parse({
      role: "assistant",
      text: "ab",
      parts: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ],
    }).text,
  ).toBe("ab");
  expect(() =>
    MessageSchema.parse({ role: "tool", text: "result", callId: "c", parts: [] }),
  ).toThrow();
});

test("adjacent explicit text parts concatenate without added separators", () => {
  const request = CompletionRequestSchema.parse({
    ...input,
    messages: [
      {
        role: "user",
        text: "ab",
        parts: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      },
    ],
  });
  expect(openaiChat.encode(request).body).toMatchObject({
    messages: [{ role: "user", content: "ab" }],
  });
});

test("Google profiles encode audio MIME types and bytes natively in content order", async () => {
  const { AUDIO_MEDIA_KINDS } = await import("../agent/content.ts");
  const { googleGenerateV2, googleGenerateV3 } = await import("./index.ts");
  const bytes = new Uint8Array([1, 2, 3]);
  for (const profile of [googleGenerate, googleGenerateV2, googleGenerateV3]) {
    for (const media of AUDIO_MEDIA_KINDS) {
      const ref = BlobRefSchema.parse({ id: hashBlob(bytes), media, bytes: bytes.length });
      const request = CompletionRequestSchema.parse({
        provider: profile.id,
        model: "audio-model",
        tools: [],
        successors: [],
        messages: [
          {
            role: "user",
            text: "beforeafter",
            parts: [
              { type: "text", text: "before" },
              { type: "blob", ref },
              { type: "text", text: "after" },
            ],
          },
        ],
      });
      const body = profile.encode(request, () => bytes).body as any;
      expect(body.contents[0].parts).toEqual([
        { text: "before" },
        { inlineData: { mimeType: media, data: "AQID" } },
        { text: "after" },
      ]);
      expect(profile.capabilities.media).toContain(media);
    }
  }
});
