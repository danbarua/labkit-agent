# Completion profiles and transport bindings

The environment binds provider code and credentials. Policy records only a versioned
profile ID, an optional model override, and generation settings. Host operation actors
still own admission, tool dispatch, handoff, cancellation, and settlement. Profiles
perform no I/O and never run a tool loop.

## Bind a session

This example assumes an injected SessionPersistence and tool registry:

```ts
import { createSession } from "../session/index.ts";
import { anthropicMessages, openaiResponses } from "./index.ts";

const session = await createSession({
  persistence,
  configuration: {
    agent: "researcher",
    agents: new Map([["researcher", { model: modelId, tools: ["search"], successors: [] }]]),
    steps: 8,
    policy: {
      provider: "openai-responses@1",
      stream: false,
      thinking: "off",
      maxOutputTokens: 2048,
    },
  },
  bindings: {
    tools,
    providers: new Map([
      [
        openaiResponses.id,
        {
          profile: openaiResponses,
          transport: {
            baseUrl: "https://api.openai.com/v1",
            headers: { Authorization: `Bearer ${openaiKey}` },
            fetch,
          },
        },
      ],
      [
        anthropicMessages.id,
        {
          profile: anthropicMessages,
          transport: {
            baseUrl: "https://api.anthropic.com/v1",
            headers: { "x-api-key": anthropicKey },
            fetch,
          },
        },
      ],
    ]),
  },
});

// The patch is journaled at a fully quiescent idle boundary.
const receipt = await session.updatePolicy({
  provider: "anthropic-messages@1",
  model: anthropicModelId,
});
```

Choose model IDs that support the requested settings. This library does not maintain
a model capability catalog or silently remove unsupported settings. Omit undefined
patch fields; they are not a reset operation.

Supply exactly one of bindings.complete (a custom completion port) or bindings.providers.
Provider-bound creation requires an explicit configuration.policy.provider. Restore
uses the persisted policy rather than the creation default. Bind every profile ID
referenced by the journal; missing IDs reject restore before any external work starts.
The binding registry, profile methods, and transport settings are captured at construction.
Behavioral compatibility of code behind an ID remains the caller's responsibility.
Use a new versioned ID when changing wire semantics.

Base URLs include the API version prefix: /v1 for OpenAI/Anthropic, /v1beta for Google.
Origin, headers, fetch, and keys are never policy fields. Headers are supplied by the
environment: Bearer authorization for OpenAI-compatible services, x-api-key for Anthropic,
and x-goog-api-key for Google. xAI and local servers use openai-chat@1 with their own
transport binding; no separate xAI dialect is included.

## Contracts

PreparedModel is now credential-free. Its existing projected-message DTO is retained
for compatibility with prompt policies and historical journals. At the profile boundary,
canonicalRequest converts it into CompletionRequest: domain messages with text, parsed
JSON tool arguments, correlated call IDs, advertisements, and successor names. Profiles
never see the journal or connection settings. AbortSignal is a separate port argument.

Each profile has pure encode(request, blobs?) and decode(response, request?) methods.
The transport passes the captured request to decode for request-dependent validation. Encoding returns a
relative POST path, non-secret protocol headers, and a body. The transport attaches the
origin and credentials and makes one HTTP attempt. There are no retries or SDK dependencies.
Decode rejects malformed, truncated, refused, built-in-tool, and unsupported continuation
data where exposed by the dialect. The host validates completion shape and permissions.

The built-in IDs are openai-chat@1, openai-responses@1, anthropic-messages@1,
anthropic-messages@2, google-generate@1, google-generate@2, and openai-responses@2.
Streaming adds openai-chat@2, anthropic-messages@3, google-generate@3, and openai-responses@3. Responses sends the complete projected input with store:false and
never sends previous_response_id or a server conversation reference. Anthropic combines
tool results into user content blocks. Google emits function declarations using
parametersJsonSchema and pairs function responses with call IDs and names. When Google
omits a call ID, the profile derives one from the response part index; identities remain
scoped to the domain tool batch.

Anthropic requires max_tokens; its profile uses maxOutputTokens or an explicit profile
default of 1024. This default is part of anthropic-messages@1's versioned behavior.

## Streaming

Enable `policy.stream: true` with a streaming-capable profile. Bind the optional
`bindings.streamUpdate(notification)` callback to render progress. The fourth host sink carries
completion ID, turn/generation and session identity, pending/in_progress/completed/failed status,
and incremental `text`, `thinking`, or `usage` fields. Text/thinking values append; usage objects
are provider-native snapshots/updates. These are display data, never journal evidence. Consumers
can discard them; the completion still assembles and settles normally without a callback.

| New streaming profile  | Base nonstream dialect | Required terminal evidence                                  |
| ---------------------- | ---------------------- | ----------------------------------------------------------- |
| `openai-chat@2`        | `openai-chat@1`        | Valid finish_reason followed by `[DONE]`                    |
| `anthropic-messages@3` | `anthropic-messages@2` | Closed content blocks, valid stop_reason, then message_stop |
| `google-generate@3`    | `google-generate@2`    | Candidate finishReason STOP                                 |
| `openai-responses@3`   | `openai-responses@2`   | response.completed with complete output                     |

Existing IDs still reject stream:true. New profiles retain their base nonstream wire shapes when
stream is off/omitted, including thinking, attachment and continuation rules. Their envelopes use
the new provider ID and join only to that exact ID. Switching between IDs does not inject old
continuations into the new profile.

Each profile's `stream()` creates a fresh operation-local assembler. Transport performs one fetch
and parses SSE across arbitrary byte/UTF-8/line boundaries. Chat assembles indexed function-call
argument fragments; Anthropic assembles content blocks, JSON arguments and signatures. Google
preserves streamed parts, attaching a signature-only fragment to its preceding part. Responses
uses the complete output from response.completed, retaining encrypted reasoning. Only the assembled
body passes through `decode`, once. No tool or handoff can execute from a delta.

OpenAI and Anthropic use stream:true on their usual endpoints; Chat also requests usage. Google
uses streamGenerateContent with alt=sse. Neither retries nor server conversation IDs are introduced.
Malformed/unsupported events, invalid UTF-8, provider errors, missing terminal evidence, or a
truncated SSE frame fail the completion. SSE frames are capped at 16,777,216 characters. Cancellation
uses the completion child's AbortSignal and cancels the body reader. Failed/cancelled operations
never publish a successful partial completion or continuation. Closing/barge-in suppresses late data.

The host emits completed only after final decode, completion admission and continuation storage;
the journal still commits one model_settled event per operation. The display status can precede its
append receipt, so dependent tools wait for the existing receipt gate. Policy and transport both
reject unsupported streaming before fetch. Prepared records capture stream:true using the existing
provider-settings journal gate (v3 or later); there is no new journal version or turn phase.

Wire references: [OpenAI streaming](https://developers.openai.com/api/docs/guides/streaming-responses),
[Anthropic streaming](https://platform.claude.com/docs/en/build-with-claude/streaming), and
[Google streamGenerateContent](https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent).

## Handoff and persistence

handoff_to is a reserved protocol tool. It is advertised only for nonempty successors,
decoded into the existing handoff outcome, and never dispatched to a tool implementation.
Mixed handoff/tool batches and unauthorized targets fail. Agent definitions may set
successors:[] to prohibit handoff or list allowed agents. Omission retains the legacy
permission to hand off to any registered agent, including when upgrading an old journal.
Successors are registry capabilities; changing them requires a compatible new session,
not mutating an existing registry.

Provider-aware sessions start at v3, use v4 for non-off thinking or continuations, and
upgrade to v5 for blob refs. A journal never downgrades its record version. Existing v1/v2 streams retain their original bytes. A first provider
policy patch appends the explicit v3/v4 policy boundary; a v1 stream
first includes its existing v2 policy upgrade in the same atomic append. Prepared events
capture effective model, provider/settings, successors, and policy version. Replay checks
these against the captured policy and registry. Commit-before-dispatch, recovery without
replaying effects, and independent fork/compaction streams remain unchanged.

Legacy createChatCompletion and completionTransport remain convenience wrappers around
openai-chat@1 and the shared HTTP transport. Only that compatibility wrapper accepts
the old custom-server message.handoff field and retains the old HTTP error-body message.
New profiles use the reserved tool and status-only HTTP errors. Legacy callback connection
fields exist only at the callback adapter boundary, not in prepared snapshots.

## Thinking and continuation envelopes

Profiles declare `capabilities.thinking`, `capabilities.stream`, and `capabilities.media`.
Policy validation and transport reject unsupported thinking before HTTP. All profiles accept
plain text and markdown attachments; additional media and replay support are versioned:

| Profile                | Enabled thinking policy      | Continuation replay         | Additional user media |
| ---------------------- | ---------------------------- | --------------------------- | --------------------- |
| `openai-chat@1`        | low, medium, high            | None                        | None                  |
| `openai-responses@1`   | None                         | Rejects reasoning items     | None                  |
| `openai-responses@2`   | low, medium, high            | Encrypted reasoning items   | None                  |
| `google-generate@1`    | None                         | Rejects thoughts/signatures | None                  |
| `google-generate@2`    | adaptive → 1024-token budget | Signed model parts          | None                  |
| `anthropic-messages@1` | None                         | Rejects thinking blocks     | None                  |
| `anthropic-messages@2` | adaptive → 1024-token budget | Signed/redacted thinking    | PNG, JPEG, PDF        |

The ACP permission/JSON-RPC adapter is **not done**.
The shared host now provides in-process tool lifecycle notifications (ACP steps 1–2). No profile starts a server conversation or uses a Files API.
OpenAI Chat remains unchanged: off maps to none; omission leaves effort absent.

`google-generate@2` declares `{ mode: "budget", maxTokens: 1024 }`. Policy adaptive enables the
versioned 1024-token default; off/omitted sends `thinkingBudget: 0`. Decode excludes thought text
from the domain completion and preserves the model parts list, including text/function-call
signatures. With thinking enabled, every function call must have a nonempty `thoughtSignature`.
Encode replays each owner's parts without concatenating signed parts or adjacent model messages.
Function responses still use the domain call IDs/names. No Interactions API or stored conversation
is used.

`openai-responses@2` maps low/medium/high to `reasoning.effort`, off to none, and omission to no
effort field. It always sends `store: false`; unless explicitly off it requests
`include: ["reasoning.encrypted_content"]`. Decode preserves encrypted reasoning and its item ID;
an ID without encrypted content fails closed. Encode inserts these reasoning input items
immediately before that owner's message/function calls, never as `previous_response_id`.
See [OpenAI stateless reasoning](https://developers.openai.com/api/docs/guides/reasoning).

`anthropic-messages@2` accepts policy `thinking:"adaptive"`. Its frozen wire behavior targets
models supporting manual extended thinking (for example Claude Sonnet 4.5):
`thinking:{type:"enabled",budget_tokens:1024}` and an explicit `maxOutputTokens > 1024`.
The off/omitted path sends disabled thinking and defaults max_tokens to 1024. Models requiring
native adaptive thinking use `anthropic-messages@4`; this profile never switches wire
shapes based on model names. See [Anthropic extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking).

`anthropic-messages@4` supports streaming and sends `thinking: { type: "adaptive" }` for policy
adaptive, without `budget_tokens` or the manual budget's output-token minimum. Off/omitted explicitly
disables thinking; the default max_tokens remains 1024. It reuses @3's signed continuation, media,
and stream assembly contracts, with envelopes owned by the new profile ID. Choose this profile for
native-adaptive models such as Sonnet 5, which rejects manual extended thinking. Existing @2/@3
wire behavior is unchanged. The caller selects a compatible model; no model-name inference is used.

Decode returns `{ completion, continuationPayload? }`; transport validates JSON and freezes it.
Profiles stay owner-blind. The host admits completion and stamps the payload with the profile ID
and the active completion child's `{ turnId, generation }`. Session storage keeps serialized
payloads of at most 65,536 JSON characters inline as `{ provider, owner, payload }`. Larger payloads
are UTF-8 JSON blobs stored under the same session before settlement, with an envelope
`{ provider, owner, payloadBlob }` and no inline payload. The 8 MiB raw blob cap still applies.
Blob-backed envelopes require journal v5; inline continuations require at least v4.

Prepare uses `matchingContinuations` to join by owner and exact provider, retaining references
only. Completion resolves payload blobs through its operation-local resolver after the prepared
append commits. Replay and idle restore never load payload bytes. Missing/corrupt bytes fail
completion before HTTP. Request parsing rejects orphan or foreign-provider envelopes.
Anthropic inserts thinking before the owner's text/tool-use blocks and refuses adjacent assistant
merges involving thinking, so blocks never move across another assistant's content.

One model_settled event commits the completion and envelope in the same append. Dependent tools
wait for that receipt. A failed/cancelled blob write cannot publish the envelope; a failed journal
append can leave an unreferenced blob. Provider switches retain stored envelopes without injecting
them into another profile. Forks copy envelopes and payload blobs for inherited assistant owners;
compaction drops them. Prepared replay compares envelopes as a keyed set, independent of array order.
Existing v1/v2/v3 bytes remain compatible.

## Verification and sources

The reusable profileContract runs exact encode vectors, decode vectors, malformed-output,
unsupported-settings, correlation, and handoff cases. Transport tests cover credentials,
single attempts, late cancellation, and binding isolation. Session tests cover provider
profiles through tools/handoff, policy changes, restore, fork/compaction, recovery,
uncertain/rejected appends, and journal tampering.

```sh
bun test packages/core/providers packages/core/session/provider-runtime.test.ts
bun test packages/core
bunx tsc --noEmit
```

Tests use fixture bodies and injected fetch functions, not paid live API calls.

Wire references checked during implementation:

- [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)
- [OpenAI Responses migration and stateless input](https://developers.openai.com/api/docs/guides/migrate-to-responses)
- [Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create)
- [Google GenerateContent](https://ai.google.dev/api/generate-content)
- [Google thinking budgets](https://ai.google.dev/gemini-api/docs/generate-content/thinking)
- [Google thought signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures)

## Attachment media and operation-local bytes

Every profile declares `capabilities.media`. All built-ins accept `text/plain` and `text/markdown`.
Anthropic `@2` additionally accepts user-message PNG/JPEG refs as base64 image blocks and PDF refs
as `{ type: "document", source: { type: "base64", media_type: "application/pdf", data } }`.
PDF/image refs on other profiles and tool-result blob parts are unsupported. PDFs are never decoded
as text or sent using URL/file_id sources. The 8 MiB raw blob cap remains unchanged; byte count
cannot establish PDF page count or token/context fit, which the caller must consider.

Domain and prepared messages contain optional text/blob parts. When parts are present, their text
parts concatenate to the legacy text field. Default history and slim handoff projections retain
parts on the messages they keep. The canonical request keeps refs even when encoding text inline.
`encode(request, blobs?)` receives a synchronous BlobId-keyed resolver supplied by the host's
completion operation; neither profiles nor projection policies read persistence themselves.

Inline text shape is versioned wire behavior. OpenAI Chat `@1`, Responses/Google `@1` and `@2`, and
Anthropic `@1` combine explicit text and attachment text into one string, separated by a newline.
Anthropic `@2` preserves separate text blocks: `Review` plus a small DESIGN.md produces two blocks.
The encode vectors intentionally lock this difference; do not normalize `@2` to match `@1`.

Text blobs of at most 65,536 bytes are decoded as UTF-8 and inlined. Larger text uses
`[attached: NAME sha256:FULL_HASH]`; the ref remains on the request. This includes markdown on
Anthropic `@2`: a 70 KiB DESIGN.md sends only the hash stub, not its contents or a document block.
The model cannot review those omitted contents. Raising the inline cap or adding markdown document encoding
requires an explicit versioned profile change (a later Anthropic revision); current profiles never
silently decode text beyond 64 KiB. No summarization, filesystem path reads, model calls, or implicit
PDF conversion occur. Invalid UTF-8 or mismatched bytes fail encoding before HTTP. Existing
text-only encode vectors remain unchanged.

Preparation checks media and existence after projection; completion reloads immutable bytes after
the prepared record commits. Canonical requests and all journal records store refs only. Blob
storage is session-scoped, content-addressed and owned by the persistence adapter.
