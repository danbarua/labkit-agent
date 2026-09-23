# Session runtime flows

These diagrams supplement the session [module guide](../packages/core/session/README.md) and
the existing [agent flow diagrams](./agent-flow-diagrams.md).

## Runtime topology

```mermaid
flowchart LR
  caller[Caller]

  subgraph session[Session runtime]
    mailbox[Session actor]
    journal[Pure journal reduction]
    storage_op[Storage operation actor]
  end

  store[(Session store)]

  subgraph host[Shared host]
    turn_ops[Turn operation actors]
    tool_batch[Tool batch actor]
    tool_ops[Tool operation actors]
  end

  subgraph provider[Provider boundary]
    port[Completion port]
    profile[Versioned provider profile]
    fetch[fetch]
  end

  caller -->|user · abort · system · policy · fork · compact| mailbox
  mailbox -->|stage| journal
  journal -->|records + deferred commands| mailbox
  mailbox -->|append / load| storage_op
  storage_op <--> store
  mailbox -->|dispatch after commit| host
  host -->|child + tool outcomes| mailbox
  turn_ops --> port
  port --> profile
  profile --> fetch
  fetch --> profile
  profile --> port
  port --> turn_ops
  mailbox -->|accepted / settled / branch| caller
```

## Session state transitions

```mermaid
stateDiagram-v2
  [*] --> ready

  ready --> committing: submit accepted / append
  committing --> committing: submit / enqueue transiently
  reconciling --> reconciling: submit / enqueue transiently

  committing --> ready: appended(committed) / promote durable, dispatch, reply, drain
  committing --> reconciling: appended(indeterminate) / load
  committing --> failed: appended(conflict or rejected) / stop

  reconciling --> ready: loaded / matching append at stream tip
  reconciling --> committing: loaded / absent at expected revision, retry once
  reconciling --> failed: loaded / conflict, changed revision, or repeat absence
  reconciling --> failed: load failed or replay invalid

  ready --> closed: close / stop
  committing --> closed: close / stop
  reconciling --> closed: close / stop
  failed --> closed: close
  closed --> [*]
```

## Commit before dispatch and settlement

```mermaid
sequenceDiagram
  autonumber
  participant C as Caller
  participant S as Session actor
  participant J as Journal reduction
  participant O as Storage operation
  participant P as Persistence port
  participant H as Shared host

  C->>S: dispatch(user)
  S->>J: stage(durable, submission)
  J-->>S: next state + records + deferred commands
  S->>S: enter committing with pending next state
  S->>O: append(request)
  O->>P: append(records, expected revision)
  P-->>O: committed(receipt)
  O-->>S: appended(committed)
  S->>S: validate receipt; durable := pending.next
  S->>H: dispatch deferred conversation commands
  S-->>C: accepted

  H-->>S: terminal child outcome
  S->>J: stage terminal event
  J-->>S: terminal record + next idle turn
  S->>O: append(terminal batch)
  O->>P: append(records, expected revision)
  P-->>O: committed(receipt)
  O-->>S: appended(committed)
  S->>S: commit terminal record
  S-->>C: settled
```

## Indeterminate append reconciliation

```mermaid
flowchart TD
  indeterminate[Append outcome is indeterminate]
  load[Load and replay the stream]
  valid{Replay valid?}
  tip{Identical append at stream tip?}
  revision{Still at expected revision?}
  retried{Already retried once?}
  committed[Promote pending state and dispatch]
  retry[Retry the identical append request and append ID]
  failed[Fail and stop the session]

  indeterminate --> load --> valid
  valid -->|no| failed
  valid -->|yes| tip
  tip -->|yes| committed
  tip -->|no| revision
  revision -->|no| failed
  revision -->|yes| retried
  retried -->|no| retry
  retried -->|yes| failed
  retry -->|committed| committed
  retry -->|indeterminate, conflict, or rejection| failed
```

## Individual tool-result commit gate

```mermaid
sequenceDiagram
  autonumber
  participant T as Tool operation
  participant H as Shared host
  participant S as Session actor
  participant P as Persistence port
  participant B as Tool batch actor

  T-->>H: tool outcome
  H->>S: submit tool(turnId, batchId, callId, result)
  S->>S: validate identities; stage tool record
  S->>P: append(tool record)
  P-->>S: committed
  S->>S: promote durable journal state
  S->>H: releaseTool(outcome)
  H->>B: tool_settled(callId, result)

  alt More calls remain
    B->>B: retain result and continue
  else Batch settles
    B-->>H: batch_settled
    H->>S: submit child(turnId, batch_settled)
    S->>P: append(batch outcome)
    P-->>S: committed
    S->>H: dispatch next conversation commands
  end
```

## Storage-operation cancellation

```mermaid
stateDiagram-v2
  [*] --> ready
  ready --> running: start / run storage request
  ready --> ready: cancel / request abort, await outcome
  running --> running: cancel / request abort, await outcome
  running --> settled: settled / notify session
  settled --> [*]

  note right of running
    Cancellation requests do not manufacture
    a terminal storage result.
  end note
```

## Transient and durable input queues

```mermaid
flowchart TD
  input[Incoming submission]
  session_busy{Session FSM ready?}
  transient[Transient SessionState.queue]
  stage[Stage against durable journal state]
  turn_active{Turn active?}
  policy{Input policy}
  pending[Durable JournalState.pendingInputs]
  append_input[Append admitted input record]
  append_queued[Append queued record]
  input_committed[Commit admitted input]
  queued_committed[Commit pending input]
  idle{Turn later becomes idle?}
  append_dequeued[Append dequeued record]
  dequeue_committed[Commit dequeue]
  dispatch[Dispatch input to shared host]

  input --> session_busy
  session_busy -->|no| transient
  transient -->|drain after current commit| stage
  session_busy -->|yes| stage
  stage --> turn_active
  turn_active -->|no| append_input
  append_input --> input_committed --> dispatch
  turn_active -->|yes| policy
  policy -->|queue-user| append_queued
  policy -->|abort-tools-on-user| append_queued
  append_queued --> pending --> queued_committed --> idle
  idle -->|yes, pending input exists| append_dequeued
  append_dequeued --> dequeue_committed --> dispatch
```

## Restore and recovery

```mermaid
flowchart TD
  load[Load journal stream]
  replay[Replay and validate without executing commands]
  valid{Replay valid?}
  bindings[Verify configuration and environment bindings]
  recover{Interrupted turn or durable inputs remain?}
  recovery[Append recovery with stable ID]
  terminal[Record active turn as failed with committed partial results]
  cancelled[Record pending inputs as input_cancelled]
  build[Build ready session runtime]
  reject[Reject restore]

  load --> replay --> valid
  valid -->|no| reject
  valid -->|yes| bindings
  bindings -->|mismatch| reject
  bindings -->|valid| recover
  recover -->|no| build
  recover -->|yes| recovery
  recovery --> terminal
  recovery --> cancelled
  terminal --> build
  cancelled --> build
```

## Persisted fork and compaction boundary

```mermaid
sequenceDiagram
  autonumber
  participant C as Caller
  participant P as Parent session
  participant PS as Parent stream
  participant CS as Child stream
  participant R as Child runtime

  C->>P: fork or compact
  P->>PS: append parent request and boundary
  PS-->>P: committed
  P->>P: commit parent transition; capture exact boundary
  P->>CS: append initialize(childId, seed)
  CS-->>P: committed
  P->>R: build from committed child seed
  P-->>C: publish child session

  Note over PS,CS: Separate streams; no cross-stream atomic transaction
  Note over P,R: Child inherits neither live work nor pending inputs
```

## Provider completion boundary

```mermaid
flowchart LR
  host[Host completion operation actor]
  port[Bound CompletionPort]
  select{request.provider}

  subgraph profiles[Pure versioned profiles]
    openai_chat[openai-chat@1]
    openai_responses[openai-responses@1]
    anthropic[anthropic-messages@1]
    google[google-generate@1]
  end

  transport[HTTP transport]
  fetch[fetch: one attempt + AbortSignal]
  admission[Host completion admission]
  outcome[model_settled]
  gate[Session journal append gate]

  host --> port --> select
  select --> openai_chat
  select --> openai_responses
  select --> anthropic
  select --> google
  openai_chat -->|encode| transport
  openai_responses -->|encode| transport
  anthropic -->|encode| transport
  google -->|encode| transport
  transport --> fetch --> transport
  transport -->|decode with selected profile| admission
  admission --> outcome --> gate
```
