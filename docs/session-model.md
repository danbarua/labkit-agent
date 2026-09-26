# Session model: facts, projections, effects and decisions

This is the reference for how a session records what happened and how every view of it is produced.
When code or another document disagrees with this page, the code is wrong and the page wins. The
"Code today" notes list the known divergences; the correction work removes them.

## Four concerns

| Concern        | What it is                                  | Where it lives                                                                | Example                                                              |
| -------------- | ------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Fact**       | Something that happened in the conversation | The session journal, written once                                             | the user's text and attachments, the model's output, a tool's result |
| **Projection** | A view computed from facts                  | Nowhere; it is recomputed when needed                                         | the next LLM prompt, the VS Code transcript, `/export`               |
| **Effect**     | An interaction with the outside world       | The effect stream: logs, traces, subscribers                                  | an HTTP request and response, token usage, raw tool output           |
| **Decision**   | A choice made at a named decision point     | Pluggable policy code; its outcome is a fact when it changes the conversation | permission, provider selection, a budget veto                        |

The journal is the input to every projection. It never stores projections. It holds facts and,
separately typed, the effects the environment chooses to record. Decisions read facts,
configuration and data gathered from effects, and they never re-derive a stored value in order to
refuse a write.

## Facts: the session journal

A fact is recorded once, in the order it happened, and never rewritten. Content is recorded as typed
parts: text, thinking, tool calls, and blob references for anything binary.

| Fact                      | Records                                                                                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session created           | origin (root, fork of a parent, compaction of a parent), inherited or seeded context, starting configuration                                              |
| Configuration applied     | the settings in force from the next turn (provider, model, thinking, output limit, streaming, permissions, tool scope, tool-failure handling, projection) |
| User input                | text and blob references                                                                                                                                  |
| Model output              | typed parts (text, thinking with any provider signature, tool calls, handoff), and which provider and model produced it                                   |
| Tool result               | the call it answers, and succeeded (typed parts), failed (failure), cancelled, refused by permission, or running in the background (placeholder)          |
| Permission decision       | what the user decided for each call                                                                                                                       |
| Decision outcome          | a decision point's outcome that changed the conversation, for example a vetoed step with its reason                                                       |
| Turn ended                | the outcome: completed, aborted, exhausted or failed, with the failure                                                                                    |
| Interruption and recovery | a turn closed on reload after process exit                                                                                                                |
| Standing instructions     | a new list of session instructions                                                                                                                        |
| Registry adopted          | the live agents and tools a reopened session continues with                                                                                               |

These are **not** facts:

- the prompt sent for a step (a projection; its HTTP body is an effect);
- a copy of a turn's messages (derived from the facts above);
- values derived from other facts (a tool batch's collected results, whether a step needs permission,
  the step allowance);
- token usage, cache reads and writes, cost, stop details, request IDs, timings (effects).

Provider continuation data (for example a thinking signature or an encrypted reasoning item) is part
of the model output fact, because the next prompt to that provider needs it.

### Recorded effects

There is one journal, and each record is typed as a fact or an effect. The conversation fold reads
facts only. Effect records are checked for integrity and nothing else; they never gate load or new
work. The environment chooses which effects to record. The default records, for each step, what the
provider reports: token usage including cache reads and writes, the stop reason, the provider request
ID, and cost only when the provider reports it (the runtime never estimates it). Request and
response bodies are side-car logging: an optional event subscriber writes them to a separate, dense
log file for debugging. They are not a core concern, and the journal does not reference them.

Any view of recorded effects is a projection, and what to show the user is a UI decision. For
example, usage after a restore is shown from the recorded usage effects. A decision can read them
too: a drop in cache reads to zero after a long pause shows that the provider's prompt cache has
expired, which is the point where a compact-and-fork policy can discard stale context without losing
a warm cache.

### Blobs

Binary content is stored once, addressed by its SHA-256, and referenced from facts by a structured
blob reference (hash, media type, size, optional name). Its URI form is `blob://<sha256>.<ext>`. The
harness resolves a blob URI against whatever store holds the bytes. A model that reads a `blob://` URI
with a tool receives the content.

## Projections

A projection is a pure function of facts and its own inputs. It is never journaled, never compared
with a stored copy, and can change between versions without affecting load.

**The next LLM prompt** is `project(facts, target, projection)`:

1. `target` is the provider and model the step will call, with that model's capabilities. Each
   capability is three-valued: supported, unsupported, or unknown.
2. The projection selects the history the policy asks for (full history, context only, or a handoff
   packet computed from the handoff fact).
3. Each part is rendered for the target. A part the target supports is kept. A part the target does
   not support, or might not support, becomes a pointer, for example
   `[image/png, 68 KiB: blob://9f86d0….png]`. The model can read the pointer with a tool.
4. Provider continuation data is kept only for the provider that produced it.
5. The system prompt, standing instructions and the live tool list are added.
6. The provider adapter encodes the result. How a kept blob is sent (inline base64, a files endpoint,
   a URL) is the adapter's choice.

Other projections read the same facts: ACP `session/load` replay and live updates, the VS Code and
web transcripts, `/export` Markdown and JSONL, session titles, and `.session-artifacts/` dumps. They
share one message projection instead of each deriving conversation history separately.

**Compaction** creates a new session whose seed is a lossy, possibly non-deterministic projection of
the parent (a summary, old images as pointers). The seed is a fact in the child and a projection of
the parent, which is why compaction creates a new session.

## Effects

Events are effects. Every event the runtime emits describes something it did to the outside world,
and it is emitted at the point where that happens: the host's operation boundary, the provider
transport around fetch, the tool runner, the permission and client ports, blob I/O and journal
appends. The emitter is supplied by the environment through session bindings. Pure decisions and the
journal fold never emit events; the fold also runs on load, where nothing happens. Committing a fact
emits a "fact committed" event after the append, which is how live views learn about it; the fact
itself is in the journal, not in the event stream.

Effect events carry correlation IDs (session, turn, step, operation, tool call, HTTP request, append).
Typical events: the rendered request and its digest, the provider response or stream, token usage and
cost, tool start and end with a reference to raw output, permission requests, client file and
terminal calls.

Subscribers are cross-cutting and optional: diagnostic logging, provider request/response capture,
usage and cost accounting, auditing, and hooks. Adding a subscriber changes no core code.

## Decisions

A decision point is a named seam where a policy chooses what happens next. Core ships default
policies; an environment can replace or add them without changing core. A policy may read facts,
configuration, and aggregates built from effects (for example usage totals kept by an accounting
subscriber).

| Decision point              | Default                                               | Example replacement                                                           |
| --------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| input during a turn         | barge-in while waiting for the model; otherwise queue | deliver as an interjection at the next step boundary                          |
| before a step is dispatched | proceed with the configured target                    | veto when a provider budget is exhausted; choose another provider from a list |
| tool permission             | ask the user, or allow                                | allow by rule                                                                 |
| tool failure                | return the error to the model and continue            | fail the turn                                                                 |
| unknown capability          | render a pointer                                      | send and let the provider's error surface                                     |

A decision that changes the conversation is recorded as a fact: a vetoed step, a refused permission,
and the provider and model that produced an output. A decision that only chooses how to render or
encode something is not recorded.

Usage and cost are effects. They become input to a decision only through a policy that reads them,
for example "use no more than 80% of my Anthropic subscription", followed by a provider selector
that picks the next provider to try. Core never refuses work on its own account because of an
effect.

## Configuration

Changing configuration is two transitions:

1. **Select.** The user's choice is committed to the session's configuration store immediately, at
   any time, including while a turn is running.
2. **Apply.** At the next boundary between turns, the runtime compares the selection with the
   configuration in force and, when they differ, records a "configuration applied" fact. The next
   turn runs with it; a running turn keeps the settings it started with.

Views show both: the selected configuration and the configuration the transcript ran under.

## Load

Loading is a fold over the journal, checked for integrity only: record format, revision and batch
continuity, identities, the creation record first, and correlation (every result names a call, turn
or input that exists). It does not re-run commit-time rules or recompute projections. Reopening a
session never requires today's models, tools or settings to match those of the past.

## Invariants that stay

- A tool result answers exactly one call of the step that proposed it; a call is answered once.
- The next step waits for its inputs: every call of the previous step has a result or a placeholder.
- A fact is committed before any work that depends on it is released.
- Credentials never enter facts, projections or effect events; effect subscribers redact.

## Code today

The correction work tracks these divergences:

- Every step journals its full prepared prompt, and staging refuses unless it equals a fresh
  projection (`session/journal/domain-event.ts`). Handoff packets are journaled the same way.
- Turn messages, tool batch results, the policy patch result, the permission-required flag and the
  step allowance are stored as copies next to the facts they derive from, checked on write, and the
  stored copy wins on load.
- Token usage is stored inside the model output fact on `model_settled` instead of as a typed effect
  record.
- Projection does not know the target model; media support is checked over the whole history after
  projection and again when input arrives. Capability is per provider profile and yes/no only.
- Tool results are text only, so binary MCP results are refused.
- A refused permission fails the turn.
- Configuration changes during a turn are refused as `busy`; there is no configuration store.
- Effects are logged with `diagnostic()` at scattered sites; provider capture exists but no launcher
  binds it.
- Consumers derive history separately. `journalMarkdown` and `journalJSONL`
  (`session/journal/render.ts`) exist but only the fixture runner uses them.
