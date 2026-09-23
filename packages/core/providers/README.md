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

Each profile has pure encode(request) and decode(response) methods. Encoding returns a
relative POST path, non-secret protocol headers, and a body. The transport attaches the
origin and credentials and makes one HTTP attempt. There are no retries or SDK dependencies.
Decode rejects malformed, truncated, refused, built-in-tool, and unsupported continuation
data where exposed by the dialect. The host validates completion shape and permissions.

The four built-in IDs are openai-chat@1, openai-responses@1, anthropic-messages@1, and
google-generate@1. Responses sends the complete projected input with store:false and
never sends previous_response_id or a server conversation reference. Anthropic combines
tool results into user content blocks. Google emits function declarations using
parametersJsonSchema and pairs function responses with call IDs and names. When Google
omits a call ID, the profile derives one from the response part index; identities remain
scoped to the domain tool batch.

Anthropic requires max_tokens; its profile uses maxOutputTokens or an explicit profile
default of 1024. This default is part of anthropic-messages@1's versioned behavior.

## Handoff and persistence

handoff_to is a reserved protocol tool. It is advertised only for nonempty successors,
decoded into the existing handoff outcome, and never dispatched to a tool implementation.
Mixed handoff/tool batches and unauthorized targets fail. Agent definitions may set
successors:[] to prohibit handoff or list allowed agents. Omission retains the legacy
permission to hand off to any registered agent, including when upgrading an old journal.
Successors are registry capabilities; changing them requires a compatible new session,
not mutating an existing registry.

Provider-aware sessions write v3 records. Existing v1/v2 streams retain their original
bytes. A first provider policy patch appends the explicit v3 policy boundary; a v1 stream
first includes its existing v2 policy upgrade in the same atomic append. Prepared events
capture effective model, provider/settings, successors, and policy version. Replay checks
these against the captured policy and registry. Commit-before-dispatch, recovery without
replaying effects, and independent fork/compaction streams remain unchanged.

Legacy createChatCompletion and completionTransport remain convenience wrappers around
openai-chat@1 and the shared HTTP transport. Only that compatibility wrapper accepts
the old custom-server message.handoff field and retains the old HTTP error-body message.
New profiles use the reserved tool and status-only HTTP errors. Legacy callback connection
fields exist only at the callback adapter boundary, not in prepared snapshots.

## Thinking and streaming follow-up

This increment accepts only stream:false and thinking:"off" (or omitted settings).
Anthropic explicitly disables thinking; Google sends thinkingBudget:0, which requires
a model that supports disabling thinking. Responses reasoning items and Anthropic/Google
thinking/signature blocks are rejected instead of losing replay-required information.
For OpenAI profiles, explicit thinking:"off" maps to effort "none"; omission leaves that
parameter absent for compatibility. It does not promise that every model disables thinking.

Thinking support will require versioned assistant continuation metadata that survives
admission, journaling, projection, fork, compaction, and restore. It is not a new turn phase.
Do not enable thinking merely by deleting the response-validation checks.

Streaming can later add transport accumulation and an optional composition-root notification
sink. Incremental text, thinking, and usage notifications will be non-authoritative; one
assembled response still goes through decode and produces one settled completion.
Cancellation and incomplete streams stay operation/transport concerns. Neither extension
requires a second tool loop.

## Verification and sources

The reusable profileContract runs exact encode vectors, decode vectors, malformed-output,
unsupported-settings, correlation, and handoff cases. Transport tests cover credentials,
single attempts, late cancellation, and binding isolation. Session tests cover all four
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
- [Google thought signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures)
