# Model bindings and provider transport

Use provider bindings when you want the session to make HTTP model calls. Use a custom
`CompletionPort` when your application already has a completion source. Both return through the
same admission and persistence gates; neither should execute model-requested tools itself.

A user selects a provider, model, and settings. The environment resolves those into a wire model ID
and an encoder/decoder profile. This keeps adapter revisions out of your UI while retaining the
implementation identity needed to diagnose a bad request. Declare the models you support: core
cannot infer from a model name whether your endpoint supports adaptive thinking or images.

## Declare the selection your application offers

```ts
import { createSession } from "../session/index.ts";
import { anthropicMessagesV4 } from "./index.ts";

const session = await createSession({
  persistence,
  configuration: {
    agent: "researcher",
    agents: new Map([["researcher", { model: "reviewer", tools: [], successors: [] }]]),
    steps: 8,
    policy: {
      provider: "anthropic",
      model: "reviewer",
      thinking: "adaptive",
      maxOutputTokens: 32768,
      stream: true,
    },
  },
  bindings: {
    providers: new Map([
      [
        "anthropic",
        {
          profile: anthropicMessagesV4,
          models: new Map([
            ["reviewer", { wireModel: configuredModelId, profile: anthropicMessagesV4 }],
          ]),
          transport: {
            baseUrl: "https://api.anthropic.com/v1",
            headers: { "x-api-key": anthropicKey },
            capture: run.capture,
          },
        },
      ],
    ]),
  },
});
await session.updatePolicy({ model: "reviewer", thinking: "off", permissions: "off" });
```

Supply exactly one completion port or provider registry. A provider-bound session requires an
explicit provider policy. A model registry requires an explicit model selection and rejects unknown
names with the supported alternatives. Bindings without a model registry accept the requested wire
model directly, using their declared profile. Binding keys need not match profile IDs. Registries,
capabilities, profiles and transport settings are captured at construction; credentials and origins
are never journal data. Restore validates persisted selections before external work.

## Choose settings without silently changing their meaning

| Setting           | What the binding must promise                              | Why rejection matters                                                 |
| ----------------- | ---------------------------------------------------------- | --------------------------------------------------------------------- |
| Adaptive thinking | Native adaptive capability.                                | A fixed token budget is a different user choice.                      |
| Budget thinking   | Caller-selected token budget.                              | Send the requested budget exactly; never substitute the minimum.      |
| Streaming         | A supported dialect and complete-response assembler.       | Visible text alone cannot establish a valid answer or tool call.      |
| Media             | Support for the supplied media in the bound model/profile. | A stored attachment ref does not mean its contents reached the model. |

Switching model and incompatible settings should be one policy patch. Unsupported combinations
fail before HTTP, so the caller gets a configuration error instead of paying for a request the
adapter cannot represent. Binding declarations remain your responsibility: local validation does
not prove that a remote model deployment accepts them.

## Implemented dialects

All existing encoder/decoder implementations remain available to environment authors:

| Profile                   | Thinking        | Streaming | Continuations            |
| ------------------------- | --------------- | --------- | ------------------------ |
| openai-chat@1 / @2        | effort          | @2        | none                     |
| openai-responses@1        | off             | no        | none                     |
| openai-responses@2 / @3   | effort          | @3        | encrypted reasoning      |
| anthropic-messages@1      | off             | no        | none                     |
| anthropic-messages@2 / @3 | explicit budget | @3        | signed/redacted thinking |
| anthropic-messages@4      | native adaptive | yes       | signed/redacted thinking |
| google-generate@1         | off             | no        | none                     |
| google-generate@2 / @3    | explicit budget | @3        | signed model parts       |

For manual thinking, set `thinking: "budget"`, `thinkingBudgetTokens`, and `maxOutputTokens`.
The output limit must exceed the thinking budget so an answer has room. Anthropic's manual minimum
is 1024; that is a validation floor, not a default or a useful workload recommendation. The encoder
sends the caller's number unchanged. Google manual budgets likewise use the caller's number.

All Anthropic bindings require an explicit `maxOutputTokens`, including when thinking is off or
adaptive. There is no hidden 1024-token output cap. Adaptive sends no manual budget. A selected
model's declared budget/output maxima are validated before admission and again before HTTP. The
application must declare model-specific constraints; the adapter cannot infer them from a name.
Clear a manual budget with `thinkingBudgetTokens: null` when selecting another thinking mode.

For example, `{ thinking: "budget", thinkingBudgetTokens: 8192, maxOutputTokens: 32768 }` requests
an 8192-token thinking budget inside a 32768-token total output ceiling. This is an explicit example,
not a claim that those values fit every task. Output exhaustion still fails with the provider stop
reason; the runtime does not accept a truncated answer or retry it automatically.

Provider references: [Anthropic extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)
and [Gemini thinking](https://ai.google.dev/gemini-api/docs/generate-content/thinking).

Responses always sends store:false
and the complete projected input, never previous_response_id or a server conversation reference.
`handoff_to` is reserved for agent routing; do not register a tool with that name. Mixed handoff/tool
output is rejected because a single completion cannot both transfer control and start a local batch.

Profiles encode/decode only. The shared transport makes exactly one HTTP attempt with the operation
AbortSignal. Base URLs include /v1 or /v1beta. Origins, keys and fetch implementations are bindings.
Profile paths are relative and cannot redirect credentials. The nonjournaled Chat convenience port
uses the same HTTP transport; its custom-server handoff field is isolated from provider profiles.

## Port and continuation contracts

`CompletionPortRequest`, `CompletionPortResponse` and `CompletionPort` are exported from the session
entry point. Prepared requests contain projected role/content messages, JSON argument strings,
correlated tool_call_id values and tool advertisements. `canonicalRequest` converts these into domain
messages with parsed arguments for profiles. See the executable
[completion binding example](../session/examples/completion-binding.ts) and
[consumer acceptance tests](../session/consumer-contract.test.ts).

Some providers require opaque signed or encrypted context from a previous response. Preserve it
through `continuationPayload`; do not turn it into visible reasoning or manufacture a replacement.
The host assigns provider and completion ownership, and the session saves it with the outcome
before tools may run. Projection selects only envelopes belonging to retained assistant messages
and the selected provider. Switching providers does not send another provider's opaque payloads.

Large payloads use session blobs rather than oversized journal fields. Fork retains the required
context; compaction drops it with prior assistant history. Restore rebuilds ownership without
calling a model or reading blobs. See [storage limits](../../../docs/session-persistence.md).

## Streaming and evidence

Streaming profiles use operation-local SSE assemblers. Chat requires finish_reason and [DONE];
Anthropic requires closed blocks, stop_reason and message_stop; Google requires finishReason STOP;
Responses requires response.completed. Malformed JSON/UTF-8, truncated frames, provider errors or
missing terminal evidence fail the completion. SSE frames are capped at 16,777,216 characters.
Only the final assembled body is decoded and admitted. Deltas are best-effort display data and never
release tools, certify receipts or become a successful partial completion.

`TransportBinding.capture` receives actual HTTP request/response bodies and completion metadata,
including endpoint, selected/wire model, profile, status, upstream request ID, stop reason, usage,
parse stage and errors. Request evidence precedes fetch; malformed JSON and partial SSE remain
available on failure. Transport excludes credential headers and redacts configured credential values.
The environment-owned [disk capture sink](../environment/provider-capture.ts) writes a unique run
manifest and per-call report linking retained bodies. Supply tool context correlation to nested
requests. No reconstructed traffic is presented as actual HTTP.

Diagnostic event families include `provider.completion.*`, `provider.http.*`, `provider.stream.*`,
`child.failed`, and `child.settled`. They retain session/turn/child IDs, timing, actual provider errors and cancellation.
Terminal failures carry serializable causes, HTTP status/request ID and parsing phase. Mutable Errors
and stacks stay outside snapshots. Inspect the launcher's durable diagnostic files; deterministic
consumer runs retain diagnostics and full traffic under `.session-artifacts/consumer*/<run-id>` and
`.session-artifacts/peer-review/<run-id>`. WARNING/ERROR records explain failures; routine success
emits no warning. Capture storage is caller-owned and separate from bounded diagnostic logging.

## Attachments

Check `session.model.capabilities.media` before offering attachment choices. Even supported text
has a representation limit: a large document may be represented by a hash stub instead of its full
contents. An application that needs extraction must arrange it explicitly; attachment support is
not an automatic document-reading workflow.

Every profile accepts text/plain and text/markdown. Anthropic @2–@4 additionally support user PNG,
JPEG and PDF as base64 blocks. Google profiles support user audio as native `inlineData` parts,
including WAV, MP3/MPEG, AIFF, AAC, OGG, FLAC, M4A, L16, Opus, A-law, μ-law and WebM. The MIME type
and bytes are preserved; no transcription or text stub is substituted. See Google's
[audio input documentation](https://ai.google.dev/gemini-api/docs/generate-content/audio).
The environment must bind a model that supports the declared media. Other profiles still reject
audio before HTTP. Tool-result blobs and other unsupported media fail before HTTP.
Attachment bytes are verified by hash/length through an operation-local resolver. Inline UTF-8 text
is limited to 65,536 bytes; larger text becomes a named SHA-256 stub, not its full contents. No implicit
summarization, path reading, PDF conversion or Files API is performed. Attachment refs and continuation
refs use the same journal format as text and permissions.

## Verification

```sh
bun test packages/core/providers packages/core/session/consumer-contract.test.ts
LOGTAPE_TEST_MODE=always LOGTAPE_TEST_LOWEST_LEVEL=debug bun test packages/core/providers
bunx tsc --noEmit
```

Tests use injected responses and make no paid provider calls. Exact wire vectors, cancellation,
credential redaction, streaming EOF, model selection, restoration and nested request sizes are covered.

Explicit provider token limits and refusals remain failed completions. Their public failure carries
`providerStop: { category: "token_limit" | "refusal", reason }`, where `reason` is the provider's
terminal value. Consumers can report the limit or refusal without parsing English error messages.
This field survives streamed failures and HTTP error translation. Partial answers and tool calls are
not admitted, and the runtime does not retry. Unknown stop reasons and truncated streams remain
ordinary failures; they must not be labelled as a known token limit without provider evidence.
