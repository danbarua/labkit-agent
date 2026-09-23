import { expect, test } from "bun:test";
import { openaiChat } from "./openai-chat.ts";
import { openaiResponses } from "./openai-responses.ts";
import { anthropicMessages } from "./anthropic-messages.ts";
import { googleGenerate } from "./google-generate.ts";
import { profileContract, request } from "./testing/profile-contract.ts";

const parameters = {
  type: "object",
  properties: { query: { type: "string" } },
  required: ["query"],
};
const chatCall = (id: string, query: string) => ({
  id,
  type: "function",
  function: { name: "lookup", arguments: JSON.stringify({ query }) },
});
const chat = (message: unknown, finish_reason = "stop") => ({
  choices: [{ message, finish_reason }],
});
profileContract(openaiChat, {
  answer: chat({ content: "done" }),
  calls: chat(
    { content: "", tool_calls: [chatCall("c1", "a"), chatCall("c2", "b")] },
    "tool_calls",
  ),
  handoff: chat(
    {
      tool_calls: [
        { id: "h", type: "function", function: { name: "handoff_to", arguments: '{"agent":"b"}' } },
      ],
    },
    "tool_calls",
  ),
  invalid: [
    {},
    chat({ content: "partial" }, "length"),
    chat({ content: null }),
    chat({ refusal: "no" }),
    chat({
      tool_calls: [{ id: "c", type: "function", function: { name: "lookup", arguments: "{" } }],
    }),
    chat({ tool_calls: [chatCall("c1", "a"), chatCall("c1", "b")] }),
  ],
  expectedBody: {
    model: "test-model",
    messages: [
      { role: "system", content: "Be concise" },
      { role: "user", content: "Find it" },
      { role: "assistant", content: "", tool_calls: [chatCall("c1", "a")] },
      { role: "tool", content: "found", tool_call_id: "c1" },
    ],
    tools: [{ type: "function", function: { name: "lookup", parameters } }],
  },
});
const responseCall = (id: string, query: string) => ({
  type: "function_call",
  call_id: id,
  name: "lookup",
  arguments: JSON.stringify({ query }),
});
const responses = (output: unknown[]) => ({ status: "completed", output });
profileContract(openaiResponses, {
  answer: responses([
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
  ]),
  calls: responses([responseCall("c1", "a"), responseCall("c2", "b")]),
  handoff: responses([
    { type: "function_call", call_id: "h", name: "handoff_to", arguments: '{"agent":"b"}' },
  ]),
  invalid: [
    {},
    { status: "incomplete", output: [] },
    responses([{ type: "web_search_call" }]),
    responses([{ type: "reasoning", encrypted_content: "signature" }]),
    responses([{ type: "function_call", call_id: "c1", name: "lookup", arguments: "{" }]),
  ],
  expectedBody: {
    model: "test-model",
    store: false,
    stream: false,
    input: [
      { role: "system", content: "Be concise" },
      { role: "user", content: "Find it" },
      responseCall("c1", "a"),
      { type: "function_call_output", call_id: "c1", output: "found" },
    ],
    tools: [{ type: "function", name: "lookup", parameters, strict: false }],
  },
});
const anthropicCall = (id: string, query: string) => ({
  type: "tool_use",
  id,
  name: "lookup",
  input: { query },
});
const anthropic = (content: unknown[], stop_reason = "end_turn") => ({
  role: "assistant",
  content,
  stop_reason,
});
profileContract(anthropicMessages, {
  answer: anthropic([{ type: "text", text: "done" }]),
  calls: anthropic([anthropicCall("c1", "a"), anthropicCall("c2", "b")], "tool_use"),
  handoff: anthropic(
    [{ type: "tool_use", id: "h", name: "handoff_to", input: { agent: "b" } }],
    "tool_use",
  ),
  invalid: [
    {},
    anthropic([{ type: "text", text: "partial" }], "max_tokens"),
    anthropic([{ type: "thinking", thinking: "hidden", signature: "opaque" }]),
    anthropic([{ type: "server_tool_use", id: "c", name: "web_search", input: {} }]),
  ],
  expectedBody: {
    model: "test-model",
    max_tokens: 1024,
    system: [{ type: "text", text: "Be concise" }],
    messages: [
      { role: "user", content: [{ type: "text", text: "Find it" }] },
      { role: "assistant", content: [anthropicCall("c1", "a")] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "found" }] },
    ],
    tools: [{ name: "lookup", input_schema: parameters }],
    thinking: { type: "disabled" },
    stream: false,
  },
});
const googleCall = (id: string, query: string) => ({
  functionCall: { id, name: "lookup", args: { query } },
});
const google = (parts: unknown[], finishReason = "STOP") => ({
  candidates: [{ finishReason, content: { role: "model", parts } }],
});
profileContract(googleGenerate, {
  answer: google([{ text: "done" }]),
  calls: google([googleCall("c1", "a"), googleCall("c2", "b")]),
  handoff: google([{ functionCall: { id: "h", name: "handoff_to", args: { agent: "b" } } }]),
  invalid: [
    {},
    google([{ text: "partial" }], "MAX_TOKENS"),
    google([{ text: "thinking", thought: true }]),
    google([{ ...googleCall("c1", "a"), thoughtSignature: "opaque" }]),
    google([{ executableCode: { code: "hidden tool" } }]),
  ],
  expectedBody: {
    contents: [
      { role: "user", parts: [{ text: "Find it" }] },
      { role: "model", parts: [googleCall("c1", "a")] },
      {
        role: "user",
        parts: [{ functionResponse: { id: "c1", name: "lookup", response: { output: "found" } } }],
      },
    ],
    systemInstruction: { parts: [{ text: "Be concise" }] },
    tools: [{ functionDeclarations: [{ name: "lookup", parametersJsonSchema: parameters }] }],
    generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
  },
});
test("all profiles reject mixed handoff/tool batches", () => {
  const responsesByProfile = [
    [
      openaiChat,
      chat({
        tool_calls: [
          chatCall("c1", "a"),
          {
            id: "h",
            type: "function",
            function: { name: "handoff_to", arguments: '{"agent":"b"}' },
          },
        ],
      }),
    ],
    [
      openaiResponses,
      responses([
        responseCall("c1", "a"),
        { type: "function_call", call_id: "h", name: "handoff_to", arguments: '{"agent":"b"}' },
      ]),
    ],
    [
      anthropicMessages,
      anthropic([
        anthropicCall("c1", "a"),
        { type: "tool_use", id: "h", name: "handoff_to", input: { agent: "b" } },
      ]),
    ],
    [
      googleGenerate,
      google([
        googleCall("c1", "a"),
        { functionCall: { id: "h", name: "handoff_to", args: { agent: "b" } } },
      ]),
    ],
  ] as const;
  for (const [profile, body] of responsesByProfile)
    expect(() => profile.decode({ status: 200, headers: new Headers(), body })).toThrow("mixed");
});
test("Google allocates deterministic call IDs only when absent", () => {
  const response = {
    status: 200,
    headers: new Headers(),
    body: google([{ functionCall: { name: "lookup", args: { query: "a" } } }]),
  };
  expect(googleGenerate.decode(response)).toEqual(googleGenerate.decode(response));
});
test("handoff advertisement is conditional and names only allowed successors", () => {
  const body = JSON.stringify(openaiChat.encode({ ...request, successors: ["b"] }).body);
  expect(body).toContain("handoff_to");
  expect(body).toContain('"enum":["b"]');
  expect(JSON.stringify(openaiChat.encode(request).body)).not.toContain("handoff_to");
});
