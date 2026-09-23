# Session runtime

An immutable, actor-driven session with an append-only journal and an injected persistence port.
There is no default store, database dependency, or durable backend. The testing adapter is explicitly
process-local. The agent module is unchanged.

## Public API

```ts
import { createSession, restoreSession, defineTool } from "./index.ts";
import { createMemoryPersistence } from "./testing/memory-persistence.ts";

const persistence = createMemoryPersistence(); // tests / process-local experiments only
const options = {
  persistence,
  agent: "researcher",
  agents: new Map([["researcher", { model: "your-model", systemPrompt: "Be precise." }]]),
  steps: 8,
  baseUrl: "https://your-provider.example/v1",
  systemInputs: ["Use SI units."],
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
`busy` at an active boundary. Every accepted event captures the version at its serialized boundary,
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

Version-one records have session, append and entry identities, contiguous journal revisions, and
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

No ordering, tool correlation, lineage, or outcome fields are normalized away. Tests compare repeated
runs byte-for-byte. Transport settings and credentials are excluded through explicit DTO projection;
the fixture suite checks a sentinel API key is absent. As with any transcript, caller-supplied message
and tool-result content is recorded verbatim and should not contain secrets intended to stay private.
Generated artifacts are ignored; approved scenario/baseline files stay tracked.

## Copied-code provenance

Session orchestration in `session-runtime.ts` was copied from `../agent/agent-runtime.ts` as authorized
by the session plan: registry copying/validation, child operation routing, tool batch orchestration,
handoff preparation, transport injection and cancellation. Pure decisions remain imported from
`../agent/agent-conversation.ts`; tool batching, completion admission, transport, operation actors,
and prompt correlation validation are reused. `session-operation.ts` follows
`../agent/operation-actor.ts` and uses the same serialized `Actor` mailbox, with session-specific
`load`/`append` references and cancellation that waits for the actual storage outcome.

Runtime parity and race tests accompany the copy. If agent orchestration changes, compare those sites
and rerun both suites rather than assuming the session copy automatically inherits the change.
