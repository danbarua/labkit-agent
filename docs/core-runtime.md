# Core actor runtime

The domain is a composition of typed state machines. A synchronous, pure decision returns the entire next state and commands. The actor mailbox commits and freezes that state before dispatching commands. Asynchronous work reports outcomes as new mailbox events.

## Ownership and state invariants

| Component | Responsibility |
| --- | --- |
| `fsm/fsm.ts` | Typed transition tables, serialized mailboxes, immutable state and post-commit command dispatch |
| `agent/agent-fsm.ts` | Turn decisions, typed active child references, required terminal outcomes |
| `agent/agent-conversation.ts` | Atomic turn reduction, terminal recording and next-turn initialization |
| `agent/operation-actor.ts` | Input validation, I/O execution, output validation, failure and cancellation |
| `agent/tool-batch.ts` | Child tool commands, nonempty outstanding calls and correlated batch outcomes |
| `agent/agent-runtime.ts` | Registries, adapter resources, spawning children and routing private outcomes |
| `agent/agent.ts` | HTTP transport and provider-response decoding |
| `agent/prompt.ts` | History validation and provider-message projection |

`TurnState` is a discriminated union. Idle contains its identity, agent and step allowance. Preparation, completion, handoff and tool phases require their own distinct child-reference kinds. Done requires a complete turn record with an outcome. There is no independent phase/context pair or optional active operation.

Each completion, prompt preparation, handoff preparation and individual tool invocation is an operation actor. Its states are ready, validating input, running, validating output, succeeded, failed and cancelled. Only running carries request identity. Success requires a validated value; failure requires an error. AbortControllers belong to execution adapters and never enter domain snapshots.

A tool batch has ready, running and settled states. Running requires a validated nonempty set of pending calls. Each tool gets its own actor and cancellation signal. Intermediate outcomes remove exactly one outstanding call; duplicate and unknown IDs are ignored. Successful settlement requires a nonempty result set validated against every original call ID exactly once. Cancellation or failure cancels outstanding children and preserves results already accepted by the batch mailbox.

The turn receives a batch outcome instead of maintaining tool bookkeeping itself. `cancelling_tools` waits for that outcome so the terminal record retains partial results.

## Validation boundaries

Zod validates configuration, public user events, tool arguments, projected prompts, handoff packets and completion responses. Branded IDs, allowances, admitted completions, nonempty call sets and complete result sets represent validated domain values. Dynamic admission checks permitted tool names and known handoff targets against copied registries. `defineTool` infers the tool input type from its schema and derives its advertised JSON Schema.

The public runtime accepts only user input and abort events. Child events use a private mailbox. Turn identity and active child identity are checked when messages are processed. Old successes, failures and cancellations cannot satisfy a replacement request, even if an adapter ignores its AbortSignal.

Types enforce payload structure. Zod constructors and mailbox checks enforce facts such as membership, uniqueness, correlation and remaining allowance. TypeScript alone cannot prove those runtime facts.

## Using the runtime

```ts
import { z } from "zod";
import { createAgentRuntime, defineTool } from "../packages/core/agent/agent-runtime.ts";

const runtime = createAgentRuntime({
  agent: "writer",
  agents: new Map([
    ["writer", { model: "local-model", systemPrompt: "Write clearly.", tools: ["lookup"] }],
    ["reviewer", { model: "local-model", systemPrompt: "Review the supplied draft." }],
  ]),
  tools: new Map([
    ["lookup", defineTool({
      description: "Look up a reference",
      input: z.object({ id: z.string().min(1) }),
      async run({ id }, signal) {
        const response = await fetch(`https://example.com/references/${encodeURIComponent(id)}`, { signal });
        if (!response.ok) throw new Error(`Lookup failed: ${response.status}`);
        return response.json();
      },
    })],
  ]),
  baseUrl: "http://localhost:8000/v1",
  steps: 6,
});

await runtime.fire({ type: "user", text: "Draft a summary." });
// Resolves after processing this event, not after completing the turn's I/O.
const { conversation, children } = runtime.snapshot;
// conversation.turn is the current typed state; conversation.log holds terminal records.
// children exposes live operation/batch state snapshots without adapter resources.
await runtime.fire({ type: "abort" });
```

Inject `fetch` to replace HTTP transport, or `complete(request)` to adapt another completion source. The latter receives projected messages, the active model, tool definitions and an AbortSignal. Its untrusted output is validated as exactly one of:

```ts
{ kind: "answer", text: "Final answer" }
{ kind: "tools", text: "Searching", calls: [{ id: "call-1", name: "lookup", args: { id: "ref-1" } }] }
{ kind: "handoff", text: "Review this draft", agent: "reviewer" }
```

The HTTP adapter translates provider `tool_calls` and tool-result messages. It also accepts the optional provider `message.handoff` extension. Ordinary providers need a custom adapter if they express handoffs differently. Tool outputs must be JSON-compatible; strings remain strings and other JSON values are serialized for prompt messages.

This replaces the previous API: `steps` replaces `budget`, tagged completions replace optional `toolCalls`/`handoff` fields, and `snapshot.conversation.turn` replaces `agentContext`. The unused monetary allowance has been removed. Generic asynchronous lifecycle hooks and the old `configure` API have been replaced by `defineMachine` and `Actor`.

## Decisions and cancellation

- User input from idle starts prompt preparation when steps remain.
- Successful preparation consumes one step and starts a completion child.
- Barge-in during preparation, completion or handoff atomically replaces the child reference and emits commands to cancel the previous child and start its replacement.
- A handoff completion changes the agent and handoff child reference in the same decision, then prepares the successor's prompt.
- A tool completion starts one batch, whose successful outcome continues the model loop.
- A final answer, abort, exhausted allowance or failure produces a required terminal outcome. The conversation records it and installs a fresh idle turn in one decision.

User input during tool execution/cancellation is rejected; abort the batch first. Cancellation is cooperative for external work, but terminal child actors ignore late adapter responses. The runtime does not wait indefinitely for cancelled I/O to settle. After aborting a tool batch, wait for the conversation's idle state before submitting another user input.

A nonnegative integer step allowance is validated at runtime construction. Zero immediately produces an exhausted turn without launching a request. Initial requests, replacements, handoffs and post-tool continuations consume steps; preparation failures do not. Each new turn gets the configured allowance. There is no automatic retry or streaming policy.

If a pure decision throws, the previous state remains committed and no commands are dispatched. The mailbox can process subsequent events. A synchronous command-dispatch failure becomes another event; asynchronous adapter failures become child outcomes. This provides atomic domain-state transitions, not transactional external effects. Crash recovery between commit and command dispatch would require a durable outbox and idempotency rules; this runtime is in memory.

## History and prompt policy

A terminal record contains the full turn transcript, final agent and an outcome tagged completed, aborted, exhausted or failed. Failed outcomes require an error message. Snapshots and nested records are frozen; earlier snapshots remain unchanged after later turns. The next idle turn retains the last active agent.

The default projector combines validated session context, logged turns and the current transcript, prefixed by the active system prompt. Only an incomplete final tool exchange in an interrupted logged turn may omit unmatched calls from provider messages. It preserves matched results and never edits the stored transcript. Missing results in completed turns, earlier exchanges, the current turn or a handoff packet raise errors. Orphan, duplicate and unmatched results also raise errors. These failures become preparation-child failures before HTTP starts.

The default handoff packet contains the latest user instruction and assistant handoff message. Subsequent messages append to both the packet and the full transcript. A new turn returns to normal history projection. Override `projectPrompt` or `projectHandoff` for a different policy; both run as cancellable operations and their outputs are validated.

## Session forks and context compaction

Each conversation has a branded UUID session identity. Turn and child identities are namespaced under it. A fork inherits configuration, the final active agent, the configured per-turn allowance, context and immutable turn records, but gets a fresh identity and independent mailbox and adapters. Frozen history can be shared safely; live requests, cancellation signals and queued fork requests are never inherited.

```ts
const fork = await runtime.fork();
await fork.fire({ type: "user", text: "Explore another approach." });

const compacted = await runtime.compact([
  { role: "user", text: "Summary: the experiment uses dataset A; next compare B." },
]);
await compacted.fire({ type: "user", text: "Continue from this summary." });
```

`fork()` and `compact(messages)` return promises for new runtimes. If the source turn is active, the requests wait in its session mailbox until the turn reaches Done, including any tool results and subsequent model continuation. Child outcomes continue to be processed while these requests wait. Completed, failed, exhausted and explicitly aborted turns all release pending forks. An idle source can fork immediately. Neither operation starts I/O; the new runtime is ready for its next user message.

Existing barge-in and abort behavior is unchanged. A barge-in can replace model work while a fork waits; the fork includes the eventual terminal record. Explicit abort can terminate that turn and release the fork. User input during tool execution remains rejected under the existing policy. Forking itself neither aborts the source nor repeats its tools.

The pure conversation decision records the terminal turn, creates the next idle turn, and captures all waiting fork snapshots atomically. Reply commands publish those snapshots only after commit. They use the captured snapshot, not a later read of the source, so a subsequent queued user event cannot leak into a fork. `ForkSnapshot` requires an idle turn and an empty request queue. `origin` records the parent identity, kind of fork and source sequence at the boundary. Ordinary forks retain the sequence; compacted forks restart at one.

Compaction replaces the new session's prior context and transcript with the supplied messages and an empty log. It retains the final active agent and configured allowance. The source and earlier ancestors keep their original histories. Replacement messages pass Zod structural validation and complete tool-result correlation checks, then are frozen; invalid replacements reject before queueing a fork or changing source state. Empty replacement context is allowed as an explicit reset.

The caller supplies the replacement context; this operation does not generate a model summary automatically. If requested during an active turn, that supplied replacement is still what the new session receives at the terminal boundary. Custom prompt projectors receive the replacement in `PromptInput.context` and must incorporate it according to their policy. The default slim handoff packet policy remains unchanged.

## Verification

Run `bun test packages/core` and `bunx tsc --noEmit`. Tests cover pure decisions, commit ordering, cancellation races, stale messages, tool correlation, validation failures, history, handoff, fork isolation, boundary races and context replacement. Compile-time assertions verify that invalid state payloads and mismatched actor-reference kinds are rejected.
