import { expect, test } from "@logtape/testing-bun/autoload";

import { PreparedModelSchema } from "../agent/agent.ts";
import {
  anthropicMessagesV2,
  bindProviders,
  CompletionRequestSchema,
  googleGenerateV2,
  openaiChat,
  openaiResponsesV2,
  type StreamDelta,
} from "./index.ts";
import { assembleStream } from "./stream.ts";
import {
  call,
  sse,
  streamingProfiles,
  streamResponse,
  streamVector,
  text,
} from "./testing/stream-vectors.ts";

const signal = () => new AbortController().signal;
for (const profile of streamingProfiles) {
  test(`${profile.id} streams text/thinking/usage, assembles tool arguments and decodes exactly once`, async () => {
    for (const tools of [false, true]) {
      let decodes = 0;
      const deltas: StreamDelta[] = [];
      const port = bindProviders(
        new Map([
          [
            profile.id,
            {
              profile: {
                ...profile,
                decode(...args) {
                  decodes++;
                  return profile.decode(...args);
                },
              },
              transport: {
                baseUrl: "https://example.invalid",
                fetch: (async () =>
                  streamResponse(streamVector(profile, tools), true)) as unknown as typeof fetch,
              },
            },
          ],
        ]),
      );
      const result = await port.complete(
        PreparedModelSchema.parse({
          thinkingBudgetTokens: profile.capabilities.thinking.mode === "budget" ? 1024 : null,
          provider: profile.id,
          model: "m",
          stream: true,
          thinking:
            profile.id.startsWith("anthropic") || profile.id.startsWith("google")
              ? "budget"
              : "high",
          maxOutputTokens: 2048,
          messages: [],
        }),
        signal(),
        undefined,
        (delta) => {
          deltas.push(delta);
          expect(Object.isFrozen(delta)).toBe(true);
        },
      );
      expect(result.completion).toEqual(
        tools ? { kind: "tools", text, calls: [call] } : { kind: "answer", text },
      );
      expect(decodes).toBe(1);
      expect(deltas.map((delta) => delta.text ?? "").join("")).toBe(text);
      expect(deltas.some((delta) => delta.usage)).toBe(true);
      expect(deltas.map((delta) => delta.thinking ?? "").join("")).toBe("Considering");
      if (profile.id !== "openai-chat@2") {
        expect(JSON.stringify(result.continuationPayload)).toContain("signature");
      }
    }
  });
  test(`${profile.id} rejects EOF before every required terminal marker without decoding`, async () => {
    const events = streamVector(profile, true);
    for (const end of [0, 1, events.length - 1]) {
      let decoded = false;
      const port = bindProviders(
        new Map([
          [
            profile.id,
            {
              profile: {
                ...profile,
                decode(...args) {
                  decoded = true;
                  return profile.decode(...args);
                },
              },
              transport: {
                baseUrl: "https://example.invalid",
                fetch: (async () =>
                  streamResponse(events.slice(0, end))) as unknown as typeof fetch,
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
            stream: true,
            messages: [],
          }),
          signal(),
        ),
      ).rejects.toThrow();
      expect(decoded).toBe(false);
    }
  });
  test(`${profile.id} preserves nonstream wire behavior and selects its stream endpoint`, () => {
    const base = [openaiChat, anthropicMessagesV2, googleGenerateV2, openaiResponsesV2][
      streamingProfiles.indexOf(profile)
    ]!;
    const request = CompletionRequestSchema.parse({
      maxOutputTokens: 16384,
      model: "m",
      messages: [],
      tools: [],
      successors: [],
    });
    expect(profile.encode(request)).toEqual(base.encode(request));
    const stream = profile.encode({ ...request, stream: true });
    if (profile.id.startsWith("google")) {
      expect(stream.path).toEndWith(":streamGenerateContent");
      expect(stream.query).toEqual({ alt: "sse" });
    } else expect(stream.body).toMatchObject({ stream: true });
    expect(() => base.encode({ ...request, stream: true })).toThrow("Unsupported streaming");
  });
}

test("SSE handles CRLF, multiline data, comments and split UTF-8; malformed frames fail closed", async () => {
  const profile = streamingProfiles[0]!;
  const events = streamVector(profile);
  const source =
    ": keepalive\r\n\r\n" +
    sse(events)
      .replaceAll('data: {"choices":', 'data: {\ndata: "choices":')
      .replaceAll("\n", "\r\n");
  const response = new Response(source, { headers: { "content-type": "text/event-stream" } });
  expect(await assembleStream(response, profile.stream!(), signal())).toMatchObject({
    choices: [{ message: { content: text } }],
  });
  for (const body of [
    sse(events).slice(0, -2),
    "data: invalid\n\n",
    'data: {"error":"provider broke"}\n\n',
  ])
    await expect(
      assembleStream(
        new Response(body, { headers: { "content-type": "text/event-stream" } }),
        profile.stream!(),
        signal(),
      ),
    ).rejects.toThrow();
});

test("abort cancels a blocked reader and never decodes a partial response", async () => {
  let cancelled = false;
  let entered = false;
  const controller = new AbortController();
  const response = new Response(
    new ReadableStream({
      start(stream) {
        stream.enqueue(
          new TextEncoder().encode(
            'data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n',
          ),
        );
      },
      cancel() {
        cancelled = true;
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
  const pending = assembleStream(
    response,
    streamingProfiles[0]!.stream!(),
    controller.signal,
    () => {
      entered = true;
      controller.abort();
    },
  );
  await expect(pending).rejects.toThrow();
  expect(entered).toBe(true);
  expect(cancelled).toBe(true);
});

test("stream observers cannot change assembled results or fail the transport", async () => {
  for (const sink of [
    () => {
      throw new Error("display failure");
    },
    () => Promise.reject(new Error("async display failure")),
    () => new Promise(() => {}),
  ]) {
    const profile = streamingProfiles[0]!;
    const result = await assembleStream(
      streamResponse(streamVector(profile)),
      profile.stream!(),
      signal(),
      sink,
    );
    expect(result).toMatchObject({ choices: [{ message: { content: text } }] });
  }
});

test("malformed terminal data, refusals and provider errors fail each dialect", async () => {
  for (const profile of streamingProfiles) {
    const vector = streamVector(profile, true);
    const error = {
      event: "error",
      data: JSON.stringify({ type: "error", error: { message: "broken" } }),
    };
    await expect(
      assembleStream(streamResponse([...vector.slice(0, 1), error]), profile.stream!(), signal()),
    ).rejects.toThrow();
    await expect(
      assembleStream(streamResponse([...vector, vector[0]!]), profile.stream!(), signal()),
    ).rejects.toThrow();
  }
  const profile = streamingProfiles[0]!;
  const refusal = {
    data: JSON.stringify({
      choices: [{ index: 0, delta: { refusal: "No" }, finish_reason: "stop" }],
    }),
  };
  await expect(
    assembleStream(streamResponse([refusal, { data: "[DONE]" }]), profile.stream!(), signal()),
  ).rejects.toThrow("refused");
  const badUtf8 = new Response(new Uint8Array([255]), {
    headers: { "content-type": "text/event-stream" },
  });
  await expect(assembleStream(badUtf8, profile.stream!(), signal())).rejects.toThrow();
  await expect(assembleStream(Response.json({}), profile.stream!(), signal())).rejects.toThrow(
    "SSE",
  );
});

test("transport rejects unsupported streaming before fetch", async () => {
  let fetches = 0;
  const port = bindProviders(
    new Map([
      [
        openaiChat.id,
        {
          profile: openaiChat,
          transport: {
            baseUrl: "https://example.invalid",
            fetch: (async () => {
              fetches++;
              return Response.json({});
            }) as unknown as typeof fetch,
          },
        },
      ],
    ]),
  );
  await expect(
    port.complete(
      PreparedModelSchema.parse({
        maxOutputTokens: 16384,
        provider: openaiChat.id,
        model: "m",
        stream: true,
        messages: [],
      }),
      signal(),
    ),
  ).rejects.toThrow("Unsupported streaming");
  expect(fetches).toBe(0);
});

for (const profile of streamingProfiles)
  test(`${profile.id} assembles parallel tools without executing or losing argument fragments`, async () => {
    const frames = streamVector(profile, true).map((frame) => ({ ...frame }));
    const second = { id: "c2", name: "echo", args: { text: "second" } };
    const event = (data: { type?: string; [key: string]: unknown }) => ({
      ...(data.type ? { event: data.type } : {}),
      data: JSON.stringify(data),
    });
    if (profile.id === "openai-chat@2") {
      frames.splice(
        4,
        0,
        event({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 1,
                    id: "c2",
                    type: "function",
                    function: { name: "echo", arguments: '{"text":' },
                  },
                ],
              },
            },
          ],
        }),
      );
      frames.splice(
        6,
        0,
        event({
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 1, function: { arguments: '"second"}' } }] },
            },
          ],
        }),
      );
    } else if (profile.id.startsWith("anthropic")) {
      frames.splice(
        -2,
        0,
        event({
          type: "content_block_start",
          index: 3,
          content_block: { type: "tool_use", id: "c2", name: "echo", input: {} },
        }),
        event({
          type: "content_block_delta",
          index: 3,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(second.args) },
        }),
        event({ type: "content_block_stop", index: 3 }),
      );
    } else if (profile.id.startsWith("google")) {
      frames.splice(
        -1,
        0,
        event({
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  {
                    functionCall: { id: "c2", name: "echo", args: second.args },
                    thoughtSignature: "second-signature",
                  },
                ],
              },
            },
          ],
        }),
      );
    } else {
      const terminal = JSON.parse(frames.at(-1)!.data);
      terminal.response.output.push({
        type: "function_call",
        call_id: "c2",
        name: "echo",
        arguments: JSON.stringify(second.args),
      });
      frames[frames.length - 1] = event(terminal);
    }
    const body = await assembleStream(streamResponse(frames), profile.stream!(), signal());
    expect(profile.decode({ status: 200, headers: new Headers(), body }).completion).toEqual({
      kind: "tools",
      text,
      calls: [call, second],
    });
  });
