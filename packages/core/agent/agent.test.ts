import { expect, test } from "bun:test";
import { createChatCompletion } from "./agent.ts";

test("sends a chat completion request and returns the assistant message", async () => {
  let receivedUrl = "";
  let receivedInit: RequestInit | undefined;

  const result = await createChatCompletion(
    {
      baseUrl: "http://host.docker.internal:8000/v1/",
      model: "local-model",
      apiKey: "secret",
      messages: [
        { role: "system", content: "Be concise." },
        { role: "user", content: "Hello" },
      ],
      temperature: 0.2,
    },
    (async (input, init) => {
      receivedUrl = String(input);
      receivedInit = init;
      return Response.json({
        choices: [{ message: { role: "assistant", content: "Hi there." } }],
      });
    }) as typeof fetch,
  );

  expect(receivedUrl).toBe("http://host.docker.internal:8000/v1/chat/completions");
  expect(receivedInit?.method).toBe("POST");
  expect(receivedInit?.headers).toEqual({
    "Content-Type": "application/json",
    Authorization: "Bearer secret",
  });
  expect(JSON.parse(String(receivedInit?.body))).toEqual({
    model: "local-model",
    messages: [
      { role: "system", content: "Be concise." },
      { role: "user", content: "Hello" },
    ],
    temperature: 0.2,
  });
  expect(result).toEqual({ text: "Hi there." });
});

test("includes the API error body when the completion request fails", async () => {
  await expect(
    createChatCompletion(
      {
        baseUrl: "http://localhost:8000/v1",
        model: "local-model",
        messages: [{ role: "user", content: "Hello" }],
      },
      (async (_input, _init) =>
        new Response("model is unavailable", { status: 503 })) as typeof fetch
    )
  ).rejects.toThrow("OpenAI-compatible API request failed (503): model is unavailable");
});

test("passes the signal to fetch and decodes tool-only responses", async () => {
  const controller = new AbortController();
  let receivedSignal: AbortSignal | null | undefined;
  const result = await createChatCompletion({
    baseUrl: "http://localhost/v1", model: "local", messages: [], signal: controller.signal,
  }, (async (_, init) => {
    receivedSignal = init?.signal;
    return Response.json({ choices: [{ message: { content: null, tool_calls: [
      { id: "call-1", type: "function", function: { name: "search", arguments: '{"query":"science"}' } },
    ] } }] });
  }) as typeof fetch);
  expect(receivedSignal).toBe(controller.signal);
  expect(result).toEqual({ text: "", toolCalls: [{ id: "call-1", name: "search", args: { query: "science" } }] });
});

test("rejects malformed responses instead of completing an empty turn", async () => {
  for (const response of ["invalid json", "null", JSON.stringify({ choices: [{ message: { content: null } }] }),
    JSON.stringify({ choices: [{ message: { tool_calls: [{ id: "1", type: "function", function: { name: "search", arguments: "invalid" } }] } }] })]) {
    await expect(createChatCompletion({ baseUrl: "http://localhost", model: "local", messages: [] },
      (async (_input, _init) => new Response(response)) as typeof fetch)).rejects.toThrow();
  }
});
