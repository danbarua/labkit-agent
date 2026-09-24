# Integrating a session

Use a session when your application needs to explain what happened after a disconnect, crash, or
storage failure. The session records accepted work before starting it and records results before
using them. This gives you a durable account of execution; it cannot make a remote API call or file
write transactional with the journal.

The caller supplies configuration, executable bindings, and persistence separately. Configuration
expresses what the session may do. Bindings supply how it does it: tools, provider credentials,
permission UI, and observers. Keeping bindings out of saved state lets you reopen a session without
serializing credentials or resurrecting old network connections.

## Submit work and interpret the result

```ts
import { createSession } from "@labkit-agent/core";
import { createMemoryPersistence } from "@labkit-agent/core/testing";

const session = await createSession({
  persistence: createMemoryPersistence(), // Process-local demonstration, not durable storage.
  configuration: {
    agent: "reviewer",
    agents: new Map([["reviewer", { model: "scripted" }]]),
    steps: 4,
  },
  bindings: {
    complete: () => ({ completion: { kind: "answer", text: "Review complete" } }),
  },
});
const command = session.input("Review this result.");
const receipt = await command.accepted;
const result = await command.settled;
if (result.kind === "terminal") {
  const outcome = result.record.outcome;
  if (outcome.kind === "failed") console.error(outcome.error);
} else {
  console.error(result.kind, result.message); // Storage/admission failure or session close.
}
await session.close();
```

There are three different observations; choose the one that answers your application's question:

| Observation                        | What you can conclude                | What to do with it                                                                         |
| ---------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------ |
| Successful `accepted` receipt      | The input was committed.             | Show it as accepted; keep listening for cancellation and output.                           |
| Tool/stream notification           | Execution has made visible progress. | Update the UI. Do not start dependent work from it.                                        |
| `settled`, with `kind: "terminal"` | The turn's outcome was committed.    | Inspect `record.outcome`; a settled turn may have failed, aborted, or exhausted its steps. |

Inspect the receipt's discriminant: a resolved promise alone does not mean admission succeeded.
Malformed public input can throw before admission. A storage failure or close can settle a command
without a terminal record. Failed receipts and settlements carry the same structured `error`,
including storage operation identity, original cause, and reconciliation evidence. `message` is its
human-readable summary. `snapshot.durable` is committed state; `pending.next` is only a proposal
waiting for storage. Do not persist pending state as a successful result.

The host owns the completion/tool loop. Your completion binding returns an answer, tool calls, or a
handoff; it must not execute the returned tool calls itself. Run the
[completion binding example](examples/completion-binding.ts) to see the exact messages, argument
strings, tool results, and response envelope at this boundary:

```sh
bun packages/core/session/examples/completion-binding.ts
```

## Change the next turn, not an operation in flight

Call `updatePolicy(patch)` to change model, thinking, streaming, allowed tools, permission mode, or
limits. Call `updateSystem(inputs)` to replace session instructions. Both require an idle boundary
with no accepted queued inputs; check for a `busy` receipt. Wait for the current work to settle,
then commit the change before submitting the next input. ACP performs that sequencing for its
configuration controls.

This prevents a single turn from starting under one permission/model configuration and finishing
under another. Mutating the original options map does not reconfigure an open session: bindings
are captured at construction. `session.model` exposes the resolved selection and capabilities;
[provider bindings](../providers/README.md) explain how to declare them.

The default input policy allows replacement during model preparation/completion/handoff and rejects
input during tools or permission waiting. Replacement joins the active turn; both callers receive
that turn's eventual terminal record. Choose a [queue policy](../policy/README.md) if every accepted
input must become a separate turn. Abort does not discard already accepted queued successors.

## Permission requests

Set `permissions: "ask"` and supply `bindings.requestPermission`. Every call in a batch must receive
approval before any call runs. `allow-session` remembers approval for the named tool and all its
arguments until this live session closes or tool scope changes or permissions are explicitly reset; `allow-once` covers only this call. A refusal therefore blocks the entire batch, including
calls approved earlier. The failure identifies the refused call; no tool result is invented for it.
A cancelled dialog aborts the turn. Without the binding, this policy is rejected before execution.

Use `bindings.toolUpdate` for display only. A pending card is not a permission request, and a completed
card is not a durable result. The authoritative permission response and journal receipt both precede
execution. See the [host port contract](../host/README.md#permission-and-display-ports).

## Decide what to do after work stops

A failed operation carries a serializable `error`: classification, message, operation identity,
phase, and available original cause details. Tool name/call ID and provider status/request ID survive
when known. Use these fields to explain the failure; do not parse English messages or search the
journal to decide whether a user refused permission.

| Outcome                             | Meaning for the caller                                                                                         |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Failed, `permission_refused`        | No tool in that batch ran. Ask for a new explicit action if appropriate.                                       |
| Failed, `timeout`                   | The configured completion/tool deadline expired. The signal was aborted; an external effect may already exist. |
| Aborted, with reason                | Cancellation ended the turn. Inspect the reason for its initiating operation.                                  |
| Failed, `interrupted` after restore | Work was active when the saved execution stopped. Its external result may be unknown.                          |
| Exhausted                           | The turn used its allowed model steps. This is a limit, not a provider failure.                                |

`completionTimeoutMs` and `toolTimeoutMs` are optional policy limits in positive integer milliseconds
(maximum 2,147,483,647); null or omission disables them. Permission waiting is untimed. Deadlines
are captured when an operation starts. Timeout does not become a tolerant tool-error message and
never causes an automatic retry. Cancellation rejects late results locally; it cannot undo a write
or force an uncooperative tool to stop. Tool implementations should honor their AbortSignal.

## Inspect response accounting

`session.lastCompletionUsage` exposes `{ turnId, operationId, usage }` for the latest committed
completion that supplied accounting. Read `usage.status` before using counters: `reported` contains
validated known counters and native fields; `invalid` contains the original accounting and its
validation error. Both keep HTTP provenance when supplied by provider bindings. This is immutable
public state; consumers do not need to search journal records. Pending receipts, partial streams,
failed operations and cancellation cannot publish a new value. Restore reconstructs it without
calling the provider. A newly created fork or compaction has no completion of its own to report.

The value describes an observed response, not the current projected prompt or cumulative cost.
It remains historical when configuration or input changes. Missing accounting leaves the last
observed record available with its original operation ID. `completion.usage.received` and
`completion.usage.committed` distinguish observed from persisted evidence in launcher logs.

## Reopen without repeating effects

Save the session ID and call `restoreSession(options, sessionId)`. Supply the original compatible
agent/tool-schema manifest and the required current bindings. Code is not journaled: replacing a
tool implementation under the same schema is your responsibility.

Restore invokes no completion, tool, or permission callback. An interrupted turn is closed with an
explicit recovery failure; committed partial tool results survive. Accepted queued inputs are
cancelled rather than started. This deliberate stopping rule avoids repeating an external write
whose acknowledgement was lost. To repeat an action, submit a new input explicitly after inspecting
the outcome. Tools do not need to be idempotent for recovery to be safe from automatic replay.

`close()` cancels owned work and settles callers, but leaves the caller's persistence store open.
A dispatched append may still commit after close. Restore to discover its result; do not treat close
as rollback. See [receipt and recovery diagrams](../../../docs/session-runtime.md).

## Supply persistence with the required guarantees

Implement `SessionPersistence` and run its
[contract suite](testing/persistence-contract.ts). An append must atomically accept the complete
batch at its expected revision. Its stable append ID must recognize identical retries and reject
changed bytes. A lost acknowledgement is `indeterminate`, not proof of failure.

Persistence adapters can return a serializable `error` alongside a failed/rejected/indeterminate
message to preserve database codes and nested causes. Thrown exceptions are captured by the storage
operation boundary. A reconciliation failure also retains the preceding uncertain append failure,
so the public result explains both the lost acknowledgement and why execution could not continue.

The session reconciles uncertainty with a consistent load before releasing work. If the append is
absent at the expected revision, it may retry the _same storage append_ once. This never retries the
completion or tool. A store that can commit an old append after reporting it absent violates the
contract and can cause execution to proceed from false evidence. Add crash tests for your real
storage engine; the memory adapter only tests the protocol.

All new records use one current format (`version: 1`), independently of configuration revisions or
features. Historical formats are not supported. See [journal and blob storage](../../../docs/session-persistence.md)
for bytes, hashing, limits, and persistence lifetime.

## Branches and attachments

`fork()` waits for the active turn's terminal boundary and creates an independent session with its
history. `compact(messages)` creates a child whose context is your replacement and whose prior turn
log is empty. It does not ask a model to summarize. Neither changes the parent or carries live work
into the child. Await publication before using the child: its seed and referenced blobs must exist.
Parent and child writes are separate transactions; interrupted publication can leave a saved child.
Use the child ID recorded in the parent request to restore it instead of creating another branch.

Store attachment bytes with `persistence.putBlob` before submitting their refs via
`input({ text, attachments })`. A successful restore proves the journal is valid, not that all blobs
are still available: bytes are checked when needed for a new completion. Unsupported media or
missing bytes fail before HTTP. Forks copy referenced blobs; compaction copies only replacement
context refs. Continuation payloads are provider-owned context, retained for matching assistant
messages; compaction drops them. Applications should not manufacture or edit their contents.

## Diagnose and verify an integration

Configure [environment logging](../logging/README.md) before creating sessions. Follow a terminal
failure's session/turn/operation IDs to `child.failed` and provider records for stack and transport
details. For exact request/response bodies, bind [provider capture](../environment/README.md#retained-provider-traffic);
`completion.system_prompt` logs the full ordered system messages at INFO before each completion,
with session, turn, agent, model, and operation IDs. The readable journal includes configured agent
prompts and the committed shared-instruction history. User/file contents and full HTTP bodies remain
in the journal or provider capture. Core owns neither sink nor retention.

```sh
LOGTAPE_TEST_MODE=always LOGTAPE_TEST_LOWEST_LEVEL=debug bun test packages/core/session/consumer-contract.test.ts
bun run packages/core/session/fixture-runner.ts
bun run packages/core/session/fixture-runner.ts --v2
```

The inspector prints a unique run directory with linked journals and `diagnostics.log` / `.jsonl`.
Default runs cover all scenarios; `--v2` selects the policy group, not a different journal format.
Consumer tests retain actual scripted HTTP traffic under `.session-artifacts/consumer*/<run-id>` and
`.session-artifacts/peer-review/<run-id>`. Read the [fixture guide](fixtures/README.md) before updating
baselines. Tests use scripted responses and establish no live-provider or disk-durability guarantee.
