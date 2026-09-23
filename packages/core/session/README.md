# Session runtime

An immutable, actor-driven session with an append-only journal and an injected persistence port.
There is no default store, database dependency, or durable backend. The testing adapter is explicitly
process-local. Both the session and nonjournaled agent runtime use the shared execution host.

## Public API

```ts
import { createSession, restoreSession, defineTool } from "./index.ts";
import { completionTransport } from "../host/ports.ts";
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
const outcome = await turn.settled;  // correlated terminal record, storage failure, or close

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

Implement `SessionPersistence` in `persistence.ts` and inject it. Its two operations accept an
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

## Inspection artifacts

```sh
bun run packages/core/session/fixture-runner.ts
bun run packages/core/session/fixture-runner.ts --update # explicitly replace approved baselines
bun test packages/core/session
bun test packages/core
bunx tsc --noEmit

diff -u packages/core/session/fixtures/expected.json .session-artifacts/latest/actual.json
diff -u packages/core/session/fixtures/expected.md .session-artifacts/latest/actual.md
cat .session-artifacts/latest/interrupted-recovery/journal-restored.jsonl
cat .session-artifacts/latest/successive-compaction-empty-reset/transcript.md
```

The runner reads declarative scenarios, injects deterministic identities, and controls deferred work.
Each scenario emits its inputs, codec-produced journal JSONL for each branch, actual projected requests,
command/terminal outcomes, durable states, and readable transcripts. Failed scenarios retain partial
traces and an error file. A mismatch also leaves actual aggregate outputs for diffing. Normal commands
never update expectations. The initial checked-in baselines are generated implementation evidence for
review; intentional behavior changes require the explicit update command and review of both diffs.

No ordering, tool correlation, lineage, or outcome fields are normalized away. Advertised tool
order is part of the captured provider request and must match the ordered policy tool list on
replay; transports must not rewrite persisted request records. Tests compare repeated
runs byte-for-byte. Transport settings and credentials are excluded through explicit DTO projection;
the fixture suite checks a sentinel API key is absent. As with any transcript, caller-supplied message
and tool-result content is recorded verbatim and should not contain secrets intended to stay private.
Generated artifacts are ignored; approved scenario/baseline files stay tracked.

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

`--v2` compares `fixtures/expected-v2.json` and `fixtures/expected-v2.md`, emitting under
`.session-artifacts/latest-v2`. Neither command without `--update` changes an approved baseline.
