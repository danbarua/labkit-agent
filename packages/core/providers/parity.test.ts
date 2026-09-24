import { expect, test } from "@logtape/testing-bun/autoload";

import { PreparedModelSchema } from "../agent/agent.ts";
import {
  bindProviders,
  CompletionRequestSchema,
  ContinuationSchema,
  googleGenerate,
  googleGenerateV2,
  openaiResponses,
  openaiResponsesV2,
} from "./index.ts";

const response = (body: unknown) => ({ status: 200, headers: new Headers(), body });

const request = CompletionRequestSchema.parse({
  model: "fixture-model",
  messages: [{ role: "user", text: "Go" }],
  tools: [],
  successors: [],
});

const googleBody = (parts: unknown[]) => ({
  candidates: [{ finishReason: "STOP", content: { role: "model", parts } }],
});

const signedParts = (round: number) => [
  { text: "private", thought: true },
  { text: `work ${round}`, thoughtSignature: `text-sig-${round}` },
  ...[0, 1].map((i) => ({
    functionCall: { id: `${round}-${i}`, name: "echo", args: { i } },
    thoughtSignature: `call-sig-${round}-${i}`,
  })),
];

const reasoning = (round: number) => ({
  type: "reasoning",
  id: `rs_${round}`,
  summary: [],
  encrypted_content: `encrypted-${round}`,
});

test("Google v2 exact budget mapping, parallel calls, and two-owner signed parts round-trip", () => {
  expect(googleGenerateV2.capabilities.thinking).toEqual({ mode: "budget", maxTokens: 1024 });
  expect(googleGenerateV2.encode({ ...request, thinking: "budget" })).toEqual({
    path: "/models/fixture-model:generateContent",
    method: "POST",
    headers: {},
    body: {
      contents: [{ role: "user", parts: [{ text: "Go" }] }],
      systemInstruction: { parts: [] },
      tools: [{ functionDeclarations: [] }],
      generationConfig: { thinkingConfig: { thinkingBudget: 1024 } },
    },
  });
  for (const thinking of [undefined, "off"] as const)
    expect(googleGenerateV2.encode({ ...request, thinking }).body).toMatchObject({
      generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
    });
  const messages: unknown[] = [...request.messages];
  const envelopes = [0, 1].map((round) => {
    const parts = signedParts(round);
    const decoded = googleGenerateV2.decode(response(googleBody(parts)), {
      ...request,
      thinking: "budget",
    });
    expect(decoded).toEqual({
      completion: {
        kind: "tools",
        text: `work ${round}`,
        calls: [0, 1].map((i) => ({ id: `${round}-${i}`, name: "echo", args: { i } })),
      },
      continuationPayload: { parts },
    });
    const owner = { turnId: "turn", generation: round };
    messages.push(
      {
        role: "assistant",
        owner,
        text: `work ${round}`,
        calls: [0, 1].map((i) => ({ id: `${round}-${i}`, name: "echo", args: { i } })),
      },
      ...[0, 1].map((i) => ({ role: "tool", callId: `${round}-${i}`, text: "ok" })),
    );
    return ContinuationSchema.parse({
      provider: googleGenerateV2.id,
      owner,
      payload: decoded.continuationPayload,
    });
  });
  const body = googleGenerateV2.encode(
    CompletionRequestSchema.parse({
      ...request,
      thinking: "budget",
      messages,
      continuations: envelopes.toReversed(),
    }),
  ).body as { contents: { role: string; parts: unknown[] }[] };
  for (const round of [0, 1]) {
    expect(body.contents[1 + 2 * round]).toEqual({ role: "model", parts: signedParts(round) });
    expect(body.contents[2 + 2 * round]?.parts).toEqual(
      [0, 1].map((i) => ({
        functionResponse: { id: `${round}-${i}`, name: "echo", response: { output: "ok" } },
      })),
    );
  }
  const adjacent = CompletionRequestSchema.parse({
    ...request,
    messages: envelopes.map((entry, i) => ({
      role: "assistant",
      owner: entry.owner,
      text: `work ${i}`,
    })),
    continuations: envelopes,
  });
  expect((googleGenerateV2.encode(adjacent).body as typeof body).contents).toHaveLength(2);
});

test("Google v2 rejects stripped signatures with thinking on, including through transport; v1 stays strict", async () => {
  const parts = signedParts(0).map(({ thoughtSignature, ...part }) => part);
  expect(() =>
    googleGenerateV2.decode(response(googleBody(parts)), { ...request, thinking: "budget" }),
  ).toThrow("thoughtSignature");
  expect(
    googleGenerateV2.decode(response(googleBody(parts)), { ...request, thinking: "off" })
      .completion,
  ).toMatchObject({ kind: "tools" });
  for (const parts of [
    [{ text: "private", thought: true }],
    [{ text: "answer", thoughtSignature: "sig" }],
    signedParts(0),
  ])
    expect(() => googleGenerate.decode(response(googleBody(parts)))).toThrow();
  const port = bindProviders(
    new Map([
      [
        googleGenerateV2.id,
        {
          profile: googleGenerateV2,
          transport: {
            baseUrl: "https://example.invalid",
            fetch: (async () => Response.json(googleBody(parts))) as unknown as typeof fetch,
          },
        },
      ],
    ]),
  );
  await expect(
    port.complete(
      PreparedModelSchema.parse({
        provider: googleGenerateV2.id,
        thinking: "budget",
        model: request.model,
        messages: [],
      }),
      new AbortController().signal,
    ),
  ).rejects.toThrow("thoughtSignature");
});

test("Responses v2 exact stateless body and effort mapping", () => {
  expect(openaiResponsesV2.encode(request)).toEqual({
    path: "/responses",
    method: "POST",
    headers: {},
    body: {
      model: request.model,
      input: [{ role: "user", content: "Go" }],
      store: false,
      stream: false,
      tools: [],
      include: ["reasoning.encrypted_content"],
    },
  });
  for (const thinking of ["off", "low", "medium", "high"] as const) {
    const body = openaiResponsesV2.encode({ ...request, thinking }).body;
    expect(body).toMatchObject({
      store: false,
      reasoning: { effort: thinking === "off" ? "none" : thinking },
    });
    expect(body).not.toHaveProperty("previous_response_id");
    if (thinking === "off") expect(body).not.toHaveProperty("include");
    else expect(body).toHaveProperty("include", ["reasoning.encrypted_content"]);
  }
});

test("Responses v2 replays encrypted reasoning immediately before each owner's calls/message", () => {
  const messages: unknown[] = [...request.messages];
  const envelopes = [0, 1].map((round) => {
    const item = { type: "function_call", call_id: `c${round}`, name: "echo", arguments: "{}" };
    const decoded = openaiResponsesV2.decode(
      response({ status: "completed", output: [reasoning(round), item] }),
    );
    expect(decoded).toEqual({
      completion: { kind: "tools", text: "", calls: [{ id: `c${round}`, name: "echo", args: {} }] },
      continuationPayload: { items: [reasoning(round)] },
    });
    const owner = { turnId: "turn", generation: round };
    messages.push(
      { role: "assistant", owner, text: "", calls: [{ id: `c${round}`, name: "echo", args: {} }] },
      { role: "tool", callId: `c${round}`, text: "ok" },
    );
    return ContinuationSchema.parse({
      provider: openaiResponsesV2.id,
      owner,
      payload: decoded.continuationPayload,
    });
  });
  const body = openaiResponsesV2.encode(
    CompletionRequestSchema.parse({ ...request, messages, continuations: envelopes.toReversed() }),
  ).body as { input: unknown[] };
  expect(body.input).toEqual([
    { role: "user", content: "Go" },
    ...[0, 1].flatMap((round) => [
      reasoning(round),
      { type: "function_call", call_id: `c${round}`, name: "echo", arguments: "{}" },
      { type: "function_call_output", call_id: `c${round}`, output: "ok" },
    ]),
  ]);
  expect(
    openaiResponsesV2.encode(
      CompletionRequestSchema.parse({
        ...request,
        messages: [{ role: "assistant", owner: envelopes[0]!.owner, text: "answer" }],
        continuations: [envelopes[0]],
      }),
    ).body,
  ).toMatchObject({ input: [reasoning(0), { role: "assistant", content: "answer" }] });
  expect(
    openaiResponsesV2.decode(
      response({
        status: "completed",
        output: [
          reasoning(0),
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
        ],
      }),
    ).completion,
  ).toEqual({ kind: "answer", text: "done" });
});

test("Responses rejects server-owned reasoning ids and v1 rejects reasoning items", () => {
  for (const encrypted_content of [undefined, null, ""])
    expect(() =>
      openaiResponsesV2.decode(
        response({ status: "completed", output: [{ ...reasoning(0), encrypted_content }] }),
      ),
    ).toThrow();
  expect(() =>
    openaiResponses.decode(response({ status: "completed", output: [reasoning(0)] })),
  ).toThrow();
});
