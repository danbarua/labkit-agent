// Canned provider wire responses, not session operations. Real profiles and transport decode these.
export const thinkingContinuationBranchesSwitchV2Responses = [
  {
    role: "assistant",
    stop_reason: "tool_use",
    content: [
      {
        type: "thinking",
        thinking: "private",
        signature: "signature-0",
      },
      {
        type: "tool_use",
        id: "c0",
        name: "echo",
        input: {
          text: "result-0",
        },
      },
    ],
  },
  {
    role: "assistant",
    stop_reason: "tool_use",
    content: [
      {
        type: "thinking",
        thinking: "private",
        signature: "signature-1",
      },
      {
        type: "tool_use",
        id: "c1",
        name: "echo",
        input: {
          text: "result-1",
        },
      },
    ],
  },
  {
    role: "assistant",
    stop_reason: "end_turn",
    content: [
      {
        type: "thinking",
        thinking: "private",
        signature: "signature-2",
      },
      {
        type: "text",
        text: "Done",
      },
    ],
  },
  {
    role: "assistant",
    stop_reason: "end_turn",
    content: [
      {
        type: "thinking",
        thinking: "private",
        signature: "signature-3",
      },
      {
        type: "text",
        text: "Done",
      },
    ],
  },
  {
    role: "assistant",
    stop_reason: "end_turn",
    content: [
      {
        type: "thinking",
        thinking: "private",
        signature: "signature-4",
      },
      {
        type: "text",
        text: "Done",
      },
    ],
  },
  {
    candidates: [
      {
        finishReason: "STOP",
        content: {
          role: "model",
          parts: [
            {
              text: "Google answer",
            },
          ],
        },
      },
    ],
  },
];

export const markdownAttachmentRestoreForkCompactV2Responses = [
  {
    choices: [
      {
        message: {
          content: "Reviewed",
        },
      },
    ],
  },
  {
    choices: [
      {
        message: {
          content: "Fork review",
        },
      },
    ],
  },
  {
    choices: [
      {
        message: {
          content: "Compact review",
        },
      },
    ],
  },
];

export const googleThinkingParallelToolsV2Responses = [
  {
    candidates: [
      {
        finishReason: "STOP",
        content: {
          role: "model",
          parts: [
            {
              text: "private",
              thought: true,
            },
            {
              text: "work-0",
              thoughtSignature: "text-sig-0",
            },
            {
              functionCall: {
                id: "c0-0",
                name: "echo",
                args: {
                  text: "result-0-0",
                },
              },
              thoughtSignature: "call-sig-0-0",
            },
            {
              functionCall: {
                id: "c0-1",
                name: "echo",
                args: {
                  text: "result-0-1",
                },
              },
              thoughtSignature: "call-sig-0-1",
            },
          ],
        },
      },
    ],
  },
  {
    candidates: [
      {
        finishReason: "STOP",
        content: {
          role: "model",
          parts: [
            {
              text: "private",
              thought: true,
            },
            {
              text: "work-1",
              thoughtSignature: "text-sig-1",
            },
            {
              functionCall: {
                id: "c1-0",
                name: "echo",
                args: {
                  text: "result-1-0",
                },
              },
              thoughtSignature: "call-sig-1-0",
            },
            {
              functionCall: {
                id: "c1-1",
                name: "echo",
                args: {
                  text: "result-1-1",
                },
              },
              thoughtSignature: "call-sig-1-1",
            },
          ],
        },
      },
    ],
  },
  {
    candidates: [
      {
        finishReason: "STOP",
        content: {
          role: "model",
          parts: [
            {
              text: "Done",
              thoughtSignature: "answer-sig",
            },
          ],
        },
      },
    ],
  },
];

export const responsesThinkingToolsV2Responses = [
  {
    status: "completed",
    output: [
      {
        type: "reasoning",
        id: "rs_0",
        summary: [],
        encrypted_content: "encrypted-0",
      },
      {
        type: "function_call",
        call_id: "c0",
        name: "echo",
        arguments: '{"text":"result-0"}',
      },
    ],
  },
  {
    status: "completed",
    output: [
      {
        type: "reasoning",
        id: "rs_1",
        summary: [],
        encrypted_content: "encrypted-1",
      },
      {
        type: "function_call",
        call_id: "c1",
        name: "echo",
        arguments: '{"text":"result-1"}',
      },
    ],
  },
  {
    status: "completed",
    output: [
      {
        type: "reasoning",
        id: "rs_2",
        summary: [],
        encrypted_content: "encrypted-2",
      },
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "Done",
          },
        ],
      },
    ],
  },
];

export const thinkingParityProviderSwitchV2Responses = [
  {
    candidates: [
      {
        finishReason: "STOP",
        content: {
          role: "model",
          parts: [
            {
              text: "Google answer",
              thoughtSignature: "google-owned",
            },
          ],
        },
      },
    ],
  },
  {
    status: "completed",
    output: [
      {
        type: "reasoning",
        id: "rs_0",
        summary: [],
        encrypted_content: "encrypted-0",
      },
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "Responses answer",
          },
        ],
      },
    ],
  },
  {
    candidates: [
      {
        finishReason: "STOP",
        content: {
          role: "model",
          parts: [
            {
              text: "Google again",
              thoughtSignature: "google-second",
            },
          ],
        },
      },
    ],
  },
];

export const streamOpenaiChat2V2Responses = [
  {
    sse: 'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Hello "},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{"content":"🌍"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"echo","arguments":"{\\"text\\":"}}]},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Hello 🌍\\"}"}}]},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: {"choices":[],"usage":{"completion_tokens":4}}\n\ndata: [DONE]\n\n',
  },
  {
    sse: 'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Hello "},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{"content":"🌍"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"completion_tokens":4}}\n\ndata: [DONE]\n\n',
  },
];

export const streamAnthropicMessages3V2Responses = [
  {
    sse: 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg","role":"assistant","content":[],"stop_reason":null,"usage":{"input_tokens":1}}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Considering"}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"signature"}}\n\nevent: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hello "}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"🌍"}}\n\nevent: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"c1","name":"echo","input":{}}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"text\\":"}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"\\"Hello 🌍\\"}"}}\n\nevent: content_block_stop\ndata: {"type":"content_block_stop","index":2}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":4}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
  },
  {
    sse: 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg","role":"assistant","content":[],"stop_reason":null,"usage":{"input_tokens":1}}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Considering"}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"signature"}}\n\nevent: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hello "}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"🌍"}}\n\nevent: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
  },
];

export const streamGoogleGenerate3V2Responses = [
  {
    sse: 'data: {"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"Considering","thought":true}]}}],"usageMetadata":{"candidatesTokenCount":4}}\n\ndata: {"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"Hello "}]}}],"usageMetadata":{"candidatesTokenCount":4}}\n\ndata: {"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"🌍"}]}}],"usageMetadata":{"candidatesTokenCount":4}}\n\ndata: {"candidates":[{"index":0,"content":{"role":"model","parts":[{"functionCall":{"id":"c1","name":"echo","args":{"text":"Hello 🌍"}}}]}}],"usageMetadata":{"candidatesTokenCount":4}}\n\ndata: {"candidates":[{"index":0,"content":{"role":"model","parts":[{"thoughtSignature":"signature"}]}}],"usageMetadata":{"candidatesTokenCount":4}}\n\ndata: {"candidates":[{"index":0,"content":{"role":"model","parts":[]},"finishReason":"STOP"}],"usageMetadata":{"candidatesTokenCount":4}}\n\n',
  },
  {
    sse: 'data: {"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"Considering","thought":true}]}}],"usageMetadata":{"candidatesTokenCount":4}}\n\ndata: {"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"Hello "}]}}],"usageMetadata":{"candidatesTokenCount":4}}\n\ndata: {"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"🌍","thoughtSignature":"signature"}]}}],"usageMetadata":{"candidatesTokenCount":4}}\n\ndata: {"candidates":[{"index":0,"content":{"role":"model","parts":[]},"finishReason":"STOP"}],"usageMetadata":{"candidatesTokenCount":4}}\n\n',
  },
];

export const streamOpenaiResponses3V2Responses = [
  {
    sse: 'event: response.created\ndata: {"type":"response.created","response":{"id":"resp","status":"in_progress","output":[]}}\n\nevent: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"Considering"}\n\nevent: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello "}\n\nevent: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"🌍"}\n\nevent: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","delta":"{\\"text\\":"}\n\nevent: response.function_call_arguments.done\ndata: {"type":"response.function_call_arguments.done","arguments":"{\\"text\\":\\"Hello 🌍\\"}"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"resp","status":"completed","usage":{"output_tokens":4},"output":[{"type":"reasoning","id":"rs_1","summary":[],"encrypted_content":"signature"},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Hello 🌍"}]},{"type":"function_call","call_id":"c1","name":"echo","arguments":"{\\"text\\":\\"Hello 🌍\\"}"}]}}\n\n',
  },
  {
    sse: 'event: response.created\ndata: {"type":"response.created","response":{"id":"resp","status":"in_progress","output":[]}}\n\nevent: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"Considering"}\n\nevent: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello "}\n\nevent: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"🌍"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"resp","status":"completed","usage":{"output_tokens":4},"output":[{"type":"reasoning","id":"rs_1","summary":[],"encrypted_content":"signature"},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Hello 🌍"}]}]}}\n\n',
  },
];

export const streamTruncatedV2Responses = [
  {
    sse: 'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Hello "},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{"content":"🌍"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"echo","arguments":"{\\"text\\":"}}]},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Hello 🌍\\"}"}}]},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: {"choices":[],"usage":{"completion_tokens":4}}\n\n',
  },
];
