# Session runtime

An immutable, actor-driven session with an append-only journal and an injected persistence port.
There is no default store, database dependency, or durable backend. The testing adapter is explicitly
process-local. Both the session and nonjournaled agent runtime use the shared execution host.

## Public API

```ts
import { completionTransport } from "../host/ports.ts";
import { createSession, defineTool, restoreSession } from "./index.ts";
import { createMemoryPersistence } from "./testing/memory-persistence.ts";

const persistence = createMemoryPersistence(); // tests / process-local experiments only
const options = {
  persistence,
  configuration: {
    agent: "researcher",
    agents: new Map([["researcher", { model: "your-model", systemPrompt: "Be precise." }]]),
    steps: 8,
    systemInputs: ["Use SI units."],
    policy: { id: "default@1" },
  },
  bindings: {
    complete: completionTransport({ baseUrl: "https://your-provider.example/v1" }),
  },
};
const session = await createSession(options);
const turn = session.input("Describe the experiment.");
const receipt = await turn.accepted; // accepted only after the input batch commits
const outcome = await turn.settled; // correlated terminal record, storage failure, or close

const child = await session.fork();
const compacted = await child.compact([{ role: "user", text: "Validated replacement context" }]);
await compacted.updateSystem(["Use SI units.", "Keep answers short."]);
const sessionId = session.snapshot.durable.conversation.sessionId;
await session.close();
const reopened = await restoreSession(options, sessionId);
```

`fire({type: "user", text})` and `fire({type: "abort"})` return typed command receipts.
`input(text)` additionally exposes terminal settlement. Barge-in inputs join the active turn and
settle with that turn's terminal record. Input during tool execution returns a failed receipt; abort
first. Validation errors at public schema boundaries throw before admission. Child messages have no
public entry point.

`updateSystem` replaces the ordered session inputs and appends the next system version. It returns
`busy` at an active boundary or while durable accepted inputs are waiting to start. Even between
turns, those queued inputs keep their accepted configuration; drain or close the session before
changing it. Every accepted event captures the version at its serialized boundary,
including inputs queued behind an idle system update. Prompt order is configured agent system text,
ordered session system inputs, then the existing context/history/current-turn or handoff projection.

Snapshots expose `durable` separately from `pending.next` while `committing` or `reconciling`.
Controllers, adapters, functions, and registries are outside snapshots. A command receipt is distinct
from terminal settlement. `close()` stops admission, signals owned operations and settles callers;
it does not close the caller's store or assert that a pending append was rolled back. A store may
finish that append after the runtime closes, so reopen through `restoreSession` to learn its outcome.

## Persistence contract

Implement `SessionPersistence` in `persistence.ts` and inject it. Its journal and blob operations accept an
`AbortSignal`. Loads return a consistent committed stream and revision, not mutable domain objects.
Appends accept serialized record strings, an expected revision, a session ID, and a stable append ID.

- Revision zero creates an absent stream. Revisions count records, independently of turn sequence.
- A batch commits atomically, with exactly the expected previous revision.
- Identical append retries return the original receipt, even after later writes. Reusing an append ID
  with different metadata or bytes is rejected. The adapter retains append IDs for its storage lifetime.
- `conflict` and `rejected` certify that this request did not commit. `indeterminate` does not.
  Thrown append errors, including cancellation errors, are conservatively indeterminate.
- After an indeterminate operation settles, a consistent load must permit reconciliation. An adapter
  cannot later commit an outstanding request after returning a load that reports it absent.
- Values crossing the port are immutable serialized data. Retaining caller array aliases is invalid.

The runtime dispatches dependent work only after validating a matching receipt. On an indeterminate
outcome, it loads and checks the stable append ID and identical payload. If absent at the expected
revision it retries once with the same ID and bytes; repeated uncertainty, changed content, competing
writers, and load failures stop the session. Restore is explicit after storage failure. There is no
claim of multi-writer progress or automatic merging.

`testing/persistence-contract.ts` exports `persistenceContract(name, factory)`. The factory supplies a
writer and an independent-reader factory sharing the same test storage. Implement the interface, run
this suite, and inject the adapter; session decisions, codec and replay need no changes. Add real
process-crash/disk-durability tests for a durable adapter. The memory implementation and fault wrappers
prove protocol behavior only, not crash durability.

## Journal and recovery

Version-one and version-two records have session, append and entry identities, contiguous journal revisions, and
strict Zod payload schemas. The codec validates session/append/entry continuity, turn/child identities,
system versions, terminal records, actual projected messages, and individual/batched tool correlation.
Replay calls pure conversation decisions and freezes reconstructed state; it executes no commands.
Terminal records summarize the same accepted interactions and are validated against reduction; they
are not applied as additional messages.

Creation stores a self-contained idle seed, configuration manifest, lineage, history, context,
allowance, active agent, next turn sequence, and system version. Supplied agent definitions and tool
parameter schemas must match the saved manifest, including registry order. Code, tool implementations,
credentials, provider URL and fetch adapters are supplied anew. Their behavioral compatibility is the
caller's responsibility; the journal does not serialize executable code.

Restoring idle sessions performs no completion/tool work. Restoring interrupted sessions appends one
explicit recovery record and a failed terminal record in one atomic batch. Durable successful tool
results are preserved in arrival order; unfinished intents remain evidence of uncertain external
effects. Outstanding completions/tools are never automatically replayed. Lost recovery receipts use
the stable recovery append ID. Controllers, pending branch callbacks, and live operations are not
restored.

Ordinary forks use the exact conversation-provided boundary, inheriting history/context/sequence.
Compaction substitutes validated context only in the child, clears inherited history and starts at
sequence one. Empty context explicitly resets the child. Neither operation edits ancestor records.
Each child commits its self-contained creation before publication. Parent request records retain the
child session identity; creation uses `initialize/<child session ID>`. If publication is interrupted,
inspect that request and restore the same persisted child ID rather than requesting another branch.
No cross-stream transaction or atomic parent/child publication is claimed. A branch requested during
an active turn waits for its terminal boundary; queued next input is excluded from that capture.

## Executable examples and inspection reports

Start with [the public-API usage examples](fixtures/usage.ts): configure a session, wait for
admission and settlement, restore history, and approve or deny a typed tool. The session API
calls are in the scenario body. Helpers capture evidence and supply deterministic dependencies;
they do not interpret a second operation language. See [the example guide](fixtures/README.md)
for the remaining scenarios, simulated boundaries, and assertion conventions.

```sh
bun test packages/core/session/session-fixtures.test.ts -t usage-
bun run packages/core/session/fixture-runner.ts
bun run packages/core/session/fixture-runner.ts --v2
cat .session-artifacts/latest-v2/README.md
cat .session-artifacts/latest-v2/usage-approve-tool/README.md
cat .session-artifacts/latest-v2/usage-approve-tool/transcript.md
cat .session-artifacts/latest/interrupted-recovery/evidence/journal-restored.jsonl
```

Each run has an index. Each scenario has a `README.md` explaining its purpose, environment,
actions and executed checks; a conversation `transcript.md`; actual runtime `diagnostics.log`
and `diagnostics.jsonl`; and an `evidence/` directory explaining its journals, requests,
receipts, snapshots and assertion values. The report links back to executable source.
A scenario can pass while deliberately exercising a failed turn: its named assertions explain
why that outcome is expected. An unexpected failure retains the partial report, error cause,
stack, journal and cleanup diagnostics before failing the test.

Snapshots and transcripts describe the end of the scenario body, **before cleanup**. Logs also
include cleanup. Reopened views with identical durable evidence share one transcript; recovery
and different captured revisions are labeled explicitly. Agent labels explain stable fixture
IDs (`a` is the primary assistant; `b` is the handoff specialist). The introductory examples use
`reviewer` directly.

The original 17 v1 and 22 v2 cases retain exact comparisons of requests, receipts/results and
states, including embedded journal records, against the existing JSON baselines. Historical
`inputs` in those baselines are no longer executable instructions or compared evidence. Three
additional v2 usage examples use explicit behavioral assertions. Presentation is covered by
renderer/report tests, separately from behavioral baselines. Repeated runs must produce identical
machine evidence and transcripts; run IDs and timestamps appear only in diagnostic/run metadata.

For an intentional behavioral change only, `--update` replaces structured baselines; review the
diff. Normal runs never update them. The obsolete Markdown baselines are no longer used.
No ordering, correlation, lineage or outcome fields are normalized away. Transport settings and
credentials are excluded from captured provider requests; a sentinel-key assertion remains.
Provider payload fixtures are data, while TypeScript scenarios are the executable specification.

## Shared execution and public events

The formerly copied turn dispatcher now lives once in `../host/host.ts`. It owns children,
registries, completion/handoff/preparation execution and tool batches. Session owns storage actors,
receipts, terminal waiters, branch publication and the individual tool-result commit gate. Existing
agent-runtime APIs and behavior are preserved through the same host. No new wrapper FSM was added.

`fire(event)` admits any validated `EnvEvent`: user, abort, system, policy, fork, compact or close.
`dispatch(event)` returns `{ accepted, settled }`; awaiting `accepted` never waits for a turn or child
publication. User settlement contains a correlated terminal, branch settlement contains the published
child, and configuration operations settle with their receipt. Close returns `close_acknowledged`,
not a fabricated persistence receipt. Existing convenience methods use this same submission path.

Bindings can include `observe(snapshot)`. Notifications contain frozen pending/durable snapshots and
run outside decisions. Exceptions or rejected observer promises do not fail the session; reentrant
submissions enter the mailbox. The environment module provides a reference event-source/render loop.

## Policy and journal compatibility

The explicit `configuration`/`bindings` API creates version-two streams. Legacy flat `SessionOptions`
remain a compatibility adapter and create version-one streams, preserving their fixture bytes.
Executable callbacks, credentials and persistence resources are never journaled.

`updatePolicy(patch)` or `fire({type:"policy", patch})` journals an idle-boundary change. The effective
policy is immutable and versioned; each event captures that version. Capability manifests stay
immutable while per-agent permitted names may be restricted within those capabilities. Step patches
apply to subsequent turns; active-agent transitions remain handoffs. See the policy module for packs,
queue behavior and error continuation.

Updating policy in a version-one stream appends an explicit version-two upgrade record and resolved
policy record atomically. Historical bytes are never rewritten; version-one replay uses the original
projection semantics. Raw legacy handoff callbacks must be migrated to named bindings before upgrade.
A restored session requires compatible capability data and all referenced pure policy implementations.
Replay executes pure projection validation but no external work.

Restoration also cancels durable pending inputs with explicit records. It never auto-runs a queued
input, even if the interruption happened at an idle boundary before dequeue. The historical accepted
input remains evidence. Ordinary forks inherit policy/system versions; compaction affects child
context/history only and does not inherit the parent's pending input queue.

Version-two fixtures are separate from the unchanged version-one baselines:

```sh
bun run packages/core/session/fixture-runner.ts --v2
bun run packages/core/session/fixture-runner.ts --v2 --update
bun test packages/core/host packages/core/policy packages/core/environment packages/core/session
```

`--v2` compares behavioral evidence against `fixtures/expected-v2.json`, emitting under
`.session-artifacts/latest-v2`. Neither command without `--update` changes an approved baseline.

## Journal v4 continuations

Non-off thinking and completion continuation envelopes require v4. An envelope is committed
with its successful model_settled event and keyed by completion owner `{ turnId, generation }`.
Replay checks the owner against the active child and validates its provider. Inline payloads
retain the 65,536 JSON-character cap; larger payloads use v5 blob references. Assistant owner metadata survives prompt projection; prepared envelopes must
match the stored set for projected owners and the captured provider. Array order is irrelevant.
Restore reconstructs this state without executing completions. Fork seeds retain envelopes for
copied assistant messages; compaction seeds drop envelopes. Switching providers preserves stored
envelopes but removes them from the next request to another provider. Indeterminate appends use
the existing stable append-ID reconciliation, including the envelope bytes.

## Attachments and journal v5

Store bytes before submitting refs. `input` accepts a string or `{ text?, attachments? }`;
`dispatch({ type: "user", text?, attachments? })` uses the same validation. Supply nonempty text
or at least one attachment. A ref contains SHA-256 ID, media type, byte count, and optional name.

```ts
const sessionId = session.snapshot.durable.conversation.sessionId;
const ref = await persistence.putBlob(
  sessionId,
  new TextEncoder().encode("# DESIGN\nPinned review document"),
  { media: "text/markdown", name: "DESIGN.md" },
  new AbortController().signal,
);
await session.input({ text: "Review this design", attachments: [ref] }).settled;
```

The session journals refs as user content parts, including queued/barge-in input. `text` remains
the concatenation of explicit text parts; the document bytes are never added to journal records.
Blob-bearing events, prepared prompts, seeds and terminal messages require v5. Streams remain at
v5 after upgrading. A legacy v1 stream first commits its existing v2 policy upgrade at an idle
boundary before admitting attachments; an active legacy turn must settle before this upgrade.
Text-only v1–v4 records and fixtures retain their bytes.

After projection, prepare checks the bound profile's media capabilities and reads/verifies only
cited refs. Missing bytes or unsupported media fail preparation without HTTP. Completion reloads
bytes under its own cancellation signal after the prepared append commits; the resolver is an
operation-local resource, not a snapshot field. Idle restore and journal replay never call getBlob.

Fork publication copies referenced blobs into the child's session scope before its creation is
published. Compaction copies only refs in its replacement context, so those bytes exist in the
child before it can prepare. Replacement refs must be available in the parent for this copy.
Unreferenced blobs are not copied; parent blobs are never deleted. Copy/creation is not a
cross-session transaction: failed publication may leave unreferenced child blobs, and retrying
copies is idempotent. See [persistence details](../../../docs/session-persistence.md).

Continuation payloads use exactly one of `payload` or `payloadBlob`. Session storage serializes
oversized JSON as UTF-8 `text/plain` under the same session before model_settled can be journaled.
Blob references in settled events, prepared prompts, or seeds require v5. Preparation attaches refs
using `matchingContinuations` without loading payload bytes. Only the completion operation loads
and verifies these blobs; missing bytes fail completion before HTTP. Forks copy payload blobs for
retained owners before child creation; compaction drops continuation refs. Idle restore does no
blob I/O. Write failure/cancellation prevents settlement and tool release; append failure may leave
an unreferenced blob. The existing 8 MiB cap also applies to continuation blobs.

## Tool lifecycle display

`bindings.toolUpdate(notification)` receives non-authoritative `tool_call` / `tool_call_update`
notifications from the shared host. Flat legacy options also accept `toolUpdate`. Tools can declare
`kind` and pure `locations(parsedArgs)` metadata. Locations arrive before execution; the pending
notification cannot occur until the admitted tools completion's append receipt releases the
permission phase or run_tools.
Completed/failed display notifications do not certify persistence: the existing per-tool result
receipt still gates batch release. Notifications are not journaled or replayed, cannot decide turn
state, and callback failures are isolated. Forks inherit the captured sink and report their own
session/operation IDs. See [host notification contract](../host/README.md#tool-display-notifications).

## Streaming completion display

Set policy stream:true with a streaming profile and optionally bind `streamUpdate(notification)`.
The callback is captured like toolUpdate, inherited by forks, and never journaled or replayed.
Prepared stream settings commit before fetch. Text/thinking/usage updates are non-authoritative;
only an assembled, decoded and admitted completion produces a successful model_settled, whose
receipt still gates tools. Interrupted streams fail/cancel with no partial assistant message or
continuation. Idle restore emits no stream updates and performs no HTTP. Barge-in keeps its existing
same-turn semantics while cancelling the old completion reader. See [provider streaming](../providers/README.md#streaming).

## Permission requests and journal v6

Set `configuration.policy.permissions: "ask"` and bind `bindings.requestPermission`:

```ts
const requestPermission = async (request, signal) => {
  // Display request.toolCall and request.options; resolve when the user chooses.
  const optionId = await promptUser(request, signal);
  return { outcome: { outcome: "selected", optionId } };
};
```

Options are `allow-once` and `reject-once`; `{ outcome: { outcome: "cancelled" } }` cancels the turn.
All calls must be approved before any call runs. A reject fails the turn without tool results, even
under tolerant tool-error policy. Omitted/off keeps existing behavior. Legacy flat options must
migrate to configuration/bindings to enable permissions. See the [host port](../host/README.md#permission-requests).

The successful tools model_settled captures `permissionRequired: true`. Its receipt releases the
permission child. The correlated permission_settled records ordered call IDs and once-only choices;
its receipt releases run_tools only after all calls were allowed. Replay checks the captured policy,
child identity, call order, completeness and refusal boundary. These new policy/event semantics
require v6; old record versions and fixture bytes remain unchanged. Streams remain v6 after opt-out.

Host-owned parsed inputs and grants are never persisted. Interrupted permission requests, including
an approval committed before execution, restore through ordinary failed recovery without reasking
or running tools. Lost approval receipts use normal reconciliation. Forks/compaction inherit policy
and the captured callback, but each new call needs a fresh choice. Idle restore emits no prompts.
Remembered approvals remain unimplemented. The separate [ACP stdio adapter](../../acp/README.md)
translates session and permission operations without changing journal semantics.

## Runtime diagnostics

`session.transition` reports changes to storage status or turn phase, including the prior state,
revision and the reason for a pending append/reconciliation gate. Repeated observations of the same
state are suppressed. Append attempts and classified outcomes carry append IDs, expected/actual
revisions, duration and failure details; an indeterminate result never claims rollback or commit.
`tool.receipt_committed` joins a batch/call to its append receipt before release. `policy.committed`
reports the effective policy only after persistence. `turn.settled` includes the committed append,
step limit and explicit exhaustion/failure reason. Restore failures preserve the original cause;
recovery identifies the interrupted phase and states that external effects will not be replayed.

These diagnostics are separate from journal authority. Core does not configure logging or own a
file sink; the launcher supplies durable output. The observability test exercises actual runtime
logging for permission waits/refusal, cancellation, lost receipts, exhausted allowance and failed
restore. Run it with debug capture to inspect what an operator will see, not just fixture output.

### Inspect fixture runtime logs beside journals

Both fixture commands print their artifact directory before executing scenarios. The defaults are
`.session-artifacts/latest` and `.session-artifacts/latest-v2`. Each scenario directory contains
`diagnostics.jsonl` (structured debug-and-higher runtime records) and `diagnostics.log` (readable
records), with journals under `evidence/journal-<alias>.jsonl`. `evidence/session-aliases.json` maps each real session ID to the
journal aliases, including restored sessions. Root `run.json` identifies the run; each diagnostic
carries that run ID, scenario name and fixture version.

These files capture real host/session/provider/persistence instrumentation, including failure and
close events. Capture is scoped to the scenario and still forwards records to the configured test
reporter; it does not replace the journal, reset global logging, or change approved fixture baselines.
Failures retain their diagnostic files. Re-running the same artifact directory replaces that run's
logs; use `runFixtures({ artifactDirectory: "..." })` to retain separate runs. Read a failure with
`cat .session-artifacts/latest/failure/diagnostics.log`, then join its session/turn/append IDs to the
journal in that directory. The fixture artifacts supplement, rather than replace, launcher logs.
