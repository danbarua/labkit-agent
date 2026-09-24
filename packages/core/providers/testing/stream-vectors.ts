import {
  anthropicMessagesV3,
  googleGenerateV3,
  openaiChatV2,
  openaiResponsesV3,
  type CompletionProfile,
  type StreamEvent,
} from "../index.ts";

export const text = "Hello 🌍";
export const call = { id: "c1", name: "echo", args: { text } };
const frame = (data: unknown): StreamEvent => ({ data: JSON.stringify(data) });
const named = (data: { type: string; [key: string]: unknown }): StreamEvent => ({
  event: data.type,
  data: JSON.stringify(data),
});
export function streamVector(profile: CompletionProfile, tools = false, signature = "signature") {
  if (profile.id === openaiChatV2.id) {
    const chunk = (delta: unknown, finish_reason: string | null = null) =>
      frame({ choices: [{ index: 0, delta, finish_reason }] });
    return [
      chunk({ role: "assistant", content: "Hello " }),
      chunk({ content: "🌍" }),
      ...(tools
        ? [
            chunk({
              tool_calls: [
                {
                  index: 0,
                  id: "c1",
                  type: "function",
                  function: { name: "echo", arguments: '{"text":' },
                },
              ],
            }),
            chunk({ tool_calls: [{ index: 0, function: { arguments: '"Hello 🌍"}' } }] }),
          ]
        : []),
      chunk({}, tools ? "tool_calls" : "stop"),
      frame({ choices: [], usage: { completion_tokens: 4 } }),
      { data: "[DONE]" },
    ];
  }
  if (profile.id === anthropicMessagesV3.id)
    return [
      named({
        type: "message_start",
        message: {
          id: "msg",
          role: "assistant",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 1 },
        },
      }),
      named({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      }),
      named({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Considering" },
      }),
      named({
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature },
      }),
      named({ type: "content_block_stop", index: 0 }),
      named({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
      named({
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "Hello " },
      }),
      named({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "🌍" } }),
      named({ type: "content_block_stop", index: 1 }),
      ...(tools
        ? [
            named({
              type: "content_block_start",
              index: 2,
              content_block: { type: "tool_use", id: "c1", name: "echo", input: {} },
            }),
            named({
              type: "content_block_delta",
              index: 2,
              delta: { type: "input_json_delta", partial_json: '{"text":' },
            }),
            named({
              type: "content_block_delta",
              index: 2,
              delta: { type: "input_json_delta", partial_json: '"Hello 🌍"}' },
            }),
            named({ type: "content_block_stop", index: 2 }),
          ]
        : []),
      named({
        type: "message_delta",
        delta: { stop_reason: tools ? "tool_use" : "end_turn" },
        usage: { output_tokens: 4 },
      }),
      named({ type: "message_stop" }),
    ];
  if (profile.id === openaiResponsesV3.id)
    return [
      named({
        type: "response.created",
        response: { id: "resp", status: "in_progress", output: [] },
      }),
      named({ type: "response.reasoning_summary_text.delta", delta: "Considering" }),
      named({ type: "response.output_text.delta", delta: "Hello " }),
      named({ type: "response.output_text.delta", delta: "🌍" }),
      ...(tools
        ? [
            named({ type: "response.function_call_arguments.delta", delta: '{"text":' }),
            named({
              type: "response.function_call_arguments.done",
              arguments: JSON.stringify(call.args),
            }),
          ]
        : []),
      named({
        type: "response.completed",
        response: {
          id: "resp",
          status: "completed",
          usage: { output_tokens: 4 },
          output: [
            { type: "reasoning", id: "rs_1", summary: [], encrypted_content: signature },
            { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
            ...(tools
              ? [
                  {
                    type: "function_call",
                    call_id: "c1",
                    name: "echo",
                    arguments: JSON.stringify(call.args),
                  },
                ]
              : []),
          ],
        },
      }),
    ];
  if (profile.id === googleGenerateV3.id) {
    const chunk = (parts: unknown[], finishReason?: string) =>
      frame({
        candidates: [
          {
            index: 0,
            content: { role: "model", parts },
            ...(finishReason ? { finishReason } : {}),
          },
        ],
        usageMetadata: { candidatesTokenCount: 4 },
      });
    return [
      chunk([{ text: "Considering", thought: true }]),
      chunk([{ text: "Hello " }]),
      chunk([{ text: "🌍", ...(tools ? {} : { thoughtSignature: signature }) }]),
      ...(tools
        ? [
            chunk([{ functionCall: { id: "c1", name: "echo", args: call.args } }]),
            chunk([{ thoughtSignature: signature }]),
          ]
        : []),
      chunk([], "STOP"),
    ];
  }
  throw new Error("Unknown stream fixture profile");
}
export const streamingProfiles = [
  openaiChatV2,
  anthropicMessagesV3,
  googleGenerateV3,
  openaiResponsesV3,
];
export const sse = (events: readonly StreamEvent[]) =>
  events
    .map((event) => `${event.event ? `event: ${event.event}\n` : ""}data: ${event.data}\n\n`)
    .join("");
export function streamResponse(events: readonly StreamEvent[], byteChunks = false) {
  const bytes = new TextEncoder().encode(sse(events));
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (byteChunks) for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        else controller.enqueue(bytes);
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}
