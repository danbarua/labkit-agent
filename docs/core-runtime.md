# Why the runtime uses actors

An external operation can finish after the caller has cancelled it, replaced it, or closed the
session. The runtime must decide whether that outcome still belongs to current work. Serialized
actor mailboxes and explicit operation identities provide that decision boundary.

Use the [session API](../packages/core/session/README.md) for durable integrations. The `/agent`
runtime uses the same host but keeps history in memory. Its event-processing acknowledgement does
not promise that a turn has finished, and it has no crash-recovery guarantee.

## Commit a decision before starting its effects

A decision returns the complete next state and commands synchronously. The mailbox freezes that
state before dispatching commands. If a fast adapter reports back immediately, it therefore sees
the operation that the decision actually installed. Mutating state later or starting I/O inside a
decision would break this ordering and make replay depend on timing.

Runtime authors should keep controllers, callbacks, credentials, and resource handles in the host.
Snapshots contain immutable data; holding an old snapshot remains safe while the runtime advances.
Session commit additionally means a validated storage receipt. In-memory actor commit only means
that the next state is installed; the two guarantees are different.

## Correlate work by identity, not by timing

Every child outcome carries its turn and operation identity. The active state names the child it
will accept. Barge-in during model work installs a replacement child before cancelling the old one.
A late response from the old child cannot become the replacement's answer, even if its adapter
ignored cancellation. Do not bypass this check by routing completion callbacks directly into a UI's
conversation history.

User input cannot replace tool execution under the default policy: a tool may already have changed
the outside world. Explicit abort stops the batch locally and preserves accepted partial results.
The session policy layer can queue successor input or request tool cancellation before starting it.
[Actor diagrams](agent-flow-diagrams.md) illustrate the distinction.

## Validate at the point where trust changes

Model output is untrusted even if its JSON parses. Completion admission checks tool names, handoff
targets, and call correlation before creating tool work. Each tool then validates arguments and
output. An output-validation failure can occur after an external effect, so it must carry the same
identity and diagnostic cause as execution failures.

A batch owns call membership and partial results. It ignores duplicate/unknown outcomes; successful
settlement requires every original call exactly once. The turn owns only the batch outcome. This
keeps parallel-call bookkeeping out of turn decisions and gives cancellation one place to preserve
results. Sessions additionally commit individual results before releasing them to the batch.

## Preserve the difference between history and a model request

Stored history records what occurred. Projection chooses what a model needs now. In an interrupted
historical tool exchange, the default projection can omit calls without results so the next request
is valid; it does not rewrite the stored evidence. Missing results in a completed exchange are an
error rather than context to silently discard.

A step is one model attempt after successful preparation, including replacement/handoff/tool-loop
continuation. Preparation failure uses no step. Zero allowance exhausts the turn without dispatch.
This bounds a loop, not tokens, elapsed time, or external effects. Model settings, projection, and
input admission are described in the [policy guide](../packages/core/policy/README.md).

## Fork at a completed boundary

A fork waits for the active turn to end, captures that exact boundary, and receives independent
execution resources. Reading the parent's snapshot later would let a subsequent input leak into
the child. Compaction is the same boundary with caller-supplied replacement context, not an
implicit model summary. For persisted publication and interrupted creation, use the
[session diagrams](session-runtime.md#branch-publication-has-two-persistence-boundaries).

When changing this machinery, test immediate replies, late replies after cancellation, duplicate
call IDs, partial tool results, and a queued event at the fork boundary. Happy-path transcripts
alone cannot establish these ordering guarantees.
