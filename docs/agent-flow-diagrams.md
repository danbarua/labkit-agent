# Operation identity and cancellation

These diagrams explain actor behavior shared by both runtimes. Actor commit installs immutable
state; it does **not** mean journal persistence. The session adds the
[receipt gates](session-runtime.md) before commands execute. Dashed returns below are outcomes,
not permission to bypass those gates.

## A turn has a permission phase

```mermaid
stateDiagram-v2
  [*] --> idle
  idle --> preparing_model: user, steps remain
  idle --> done: user, no steps / exhausted
  idle --> done: abort
  preparing_model --> awaiting_model: prepared / consume step
  awaiting_model --> done: answer
  awaiting_model --> awaiting_permission: tools, permissions ask
  awaiting_model --> executing_tools: tools, permissions off
  awaiting_permission --> executing_tools: every call approved
  awaiting_permission --> done: refusal, failure, or cancellation
  awaiting_model --> preparing_handoff: handoff
  preparing_handoff --> preparing_model: prepared, steps remain
  preparing_handoff --> done: prepared, no steps / exhausted
  executing_tools --> preparing_model: batch success, steps remain
  executing_tools --> done: batch success, no steps / exhausted
  executing_tools --> done: batch failure or cancellation
  executing_tools --> cancelling_tools: abort
  cancelling_tools --> done: batch outcome, preserve accepted results
  preparing_model --> done: failure or cancellation
  awaiting_model --> done: failure or cancellation
  preparing_handoff --> done: failure or cancellation
  done --> idle: record terminal turn and reset allowance
```

Replacement input is omitted from this diagram for readability; the sequence below covers it.
Permission refusal fails the whole turn before any tool starts. Permission-dialog cancellation
aborts it. The distinction must survive into a client-facing result.

## Replace model work without accepting its late answer

```mermaid
sequenceDiagram
  participant A as Application
  participant C as Conversation
  participant H as Shared host
  participant O as Old operation
  participant N as New operation
  A->>C: replacement user input
  C->>C: install new child identity in the same turn
  C->>H: cancel old child; start replacement
  H->>O: abort signal
  H->>N: start
  N-->>H: result for new child
  H-->>C: correlated outcome
  C->>C: accept matching turn and child
  O-->>H: late result, if adapter ignored signal
  H->>H: ignore already-cancelled operation result
  Note over C,H: Conversation also rejects mismatched turn or child identities.
```

Both inputs settle with the same terminal turn. Under the default policy, replacement applies to
preparation/completion/handoff, not tool or permission work. A timeout uses the same cancellation
machinery with a distinct typed reason; it does not spawn a replacement automatically.

## Cancelling a batch preserves what was accepted

```mermaid
sequenceDiagram
  participant A as Application
  participant C as Conversation
  participant H as Host
  participant B as Tool batch
  participant T as Tools A and B
  H->>T: start both calls
  T-->>H: A succeeds
  Note over H,B: Session saves A's result before release.<br/>In-memory runtime releases immediately.
  H->>B: accept A result
  A->>C: abort
  C->>C: enter cancelling_tools
  C->>H: cancel batch
  H->>B: cancel
  B->>H: cancel unfinished B
  H->>T: abort B signal
  B-->>C: cancelled batch with A result, through host
  C->>C: record aborted turn with accepted result
```

Tool B may already have changed an external service. Its cancellation is not proof that nothing
happened. On failure, unfinished siblings receive the initiating call's cause so the public outcome
and logs can explain why the rest of the batch stopped.

## An operation settles once

```mermaid
stateDiagram-v2
  [*] --> ready
  ready --> validating_input: start
  validating_input --> running: valid input
  running --> validating_output: returned
  validating_output --> succeeded: valid output
  validating_input --> failed: invalid input
  running --> failed: execution failure
  validating_output --> failed: invalid output
  ready --> cancelled: cancel
  validating_input --> cancelled: cancel
  running --> cancelled: cancel
  validating_output --> cancelled: cancel
  succeeded --> [*]
  failed --> [*]
  cancelled --> [*]
```

Cancellation carries a reason. The surrounding host/turn translates a timeout reason into a failed
terminal outcome with classification `timeout`; user cancellation remains distinguishable. A
terminal actor does not accept a late success. Keep arbitrary Error objects and AbortControllers
outside snapshots; retain serializable causes and operation identity inside outcomes.
