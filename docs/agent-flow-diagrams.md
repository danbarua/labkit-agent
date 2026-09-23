# Agent flow diagrams

Supplementary visuals for [`core-runtime.md`](./core-runtime.md).

## Message routing

```mermaid
flowchart LR
  caller[Runtime caller]
  conversation[Conversation actor]
  runtime[Runtime command dispatcher]
  preparation[Prompt preparation operation]
  completion[Completion operation]
  handoff[Handoff preparation operation]
  batch[Tool batch actor]
  tools[Tool operation actors]

  caller -->|user / abort| conversation
  conversation -->|prepare_model| runtime
  conversation -->|complete| runtime
  conversation -->|prepare_handoff| runtime
  conversation -->|run_tools| runtime
  conversation -->|cancel child| runtime

  runtime -->|start| preparation
  runtime -->|start| completion
  runtime -->|start| handoff
  runtime -->|start| batch
  runtime -->|cancel| preparation
  runtime -->|cancel| completion
  runtime -->|cancel| handoff
  runtime -->|cancel| batch

  preparation -->|prepared| runtime
  completion -->|model_settled| runtime
  handoff -->|handoff_prepared| runtime
  batch -->|batch_settled| runtime
  runtime -->|child + turnId| conversation

  batch -->|spawn_tool| runtime
  runtime -->|start| tools
  batch -->|cancel_tool| runtime
  runtime -->|cancel| tools
  tools -->|tool_settled| runtime
  runtime -->|tool_settled + callId| batch
```

## Turn state transitions

```mermaid
stateDiagram-v2
  [*] --> idle

  idle --> preparing_model: user [steps remain]
  idle --> done: user [no steps]
  idle --> done: abort

  preparing_model --> awaiting_model: prepared / succeeded
  preparing_model --> preparing_model: user / replace child
  preparing_model --> done: user [no steps]
  preparing_model --> done: abort or failed or cancelled

  awaiting_model --> done: model_settled / answer
  awaiting_model --> executing_tools: model_settled / tools
  awaiting_model --> preparing_handoff: model_settled / handoff
  awaiting_model --> preparing_model: user / replace child
  awaiting_model --> done: user [no steps]
  awaiting_model --> done: abort or failed or cancelled

  preparing_handoff --> preparing_model: handoff_prepared / succeeded [steps remain]
  preparing_handoff --> done: handoff_prepared / succeeded [no steps]
  preparing_handoff --> preparing_model: user / replace child
  preparing_handoff --> done: user [no steps]
  preparing_handoff --> done: abort or failed or cancelled

  executing_tools --> preparing_model: batch_settled / succeeded [steps remain]
  executing_tools --> done: batch_settled / succeeded [no steps]
  executing_tools --> done: batch_settled / failed or cancelled
  executing_tools --> cancelling_tools: abort

  cancelling_tools --> done: batch_settled / preserve accepted results

  done --> idle: record turn / increment sequence / reset allowance
```

## Operation actor transitions

```mermaid
stateDiagram-v2
  [*] --> ready
  ready --> validating_input: start
  validating_input --> running: input_valid
  running --> validating_output: returned
  validating_output --> succeeded: output_valid

  ready --> cancelled: cancel
  validating_input --> cancelled: cancel
  running --> cancelled: cancel
  validating_output --> cancelled: cancel

  ready --> failed: failed
  validating_input --> failed: failed
  running --> failed: failed
  validating_output --> failed: failed

  succeeded --> [*]
  failed --> [*]
  cancelled --> [*]
```

## Tool batch transitions

```mermaid
stateDiagram-v2
  [*] --> ready
  ready --> running: start / spawn_tool for each call
  running --> running: tool_settled / accept result and remove pending call
  running --> running: tool_settled / ignore unknown or duplicate callId
  running --> settled: last tool succeeded / notify batch success
  running --> settled: tool failed or cancelled / cancel pending tools
  running --> settled: cancel / cancel pending tools
  settled --> [*]
```

## Barge-in and stale outcomes

```mermaid
sequenceDiagram
  autonumber
  participant U as Runtime caller
  participant C as Conversation actor
  participant R as Runtime dispatcher
  participant Old as Previous child
  participant New as Replacement child

  U->>C: user
  C->>C: commit replacement childId
  C->>R: cancel(previous childId)
  C->>R: prepare_model(replacement childId)
  R->>Old: cancel
  R->>New: start
  New-->>R: prepared(replacement childId)
  R-->>C: child(turnId, prepared)
  C->>C: accept matching turnId + childId
  Old-->>R: late terminal outcome(previous childId)
  R-->>C: child(turnId, late outcome)
  C->>C: ignore stale childId
```

## Tool cancellation with partial results

```mermaid
sequenceDiagram
  autonumber
  participant U as Runtime caller
  participant C as Conversation actor
  participant B as Tool batch actor
  participant T1 as Tool operation A
  participant T2 as Tool operation B

  C->>B: start(calls A, B)
  B->>T1: spawn_tool / start
  B->>T2: spawn_tool / start
  T1-->>B: tool_settled(A, succeeded)
  B->>B: retain result A; #B remains pending
  U->>C: abort
  C->>C: executing_tools → cancelling_tools
  C->>B: cancel
  B->>T2: cancel_tool / cancel
  B->>B: settle cancelled with result A
  B-->>C: batch_settled(cancelled, partial results)
  C->>C: append result A; #record aborted turn
```

## Fork publication boundary

```mermaid
sequenceDiagram
  autonumber
  participant U as Runtime caller
  participant C as Source conversation actor
  participant Child as Active child
  participant R as Runtime dispatcher
  participant F as Forked runtime

  U->>C: request(fork or compact)
  C->>C: queue request while turn is active
  Child-->>C: child(turnId, terminal outcome)
  C->>C: record turn + install idle turn
  C->>C: capture fork snapshot + drain request
  C->>C: commit source state
  C->>R: reply(captured snapshot)
  R->>F: construct independent runtime
  R-->>U: resolve fork or compact promise
```
