# Core FSM runtime

The runtime is a conversation containing a chain of independent turn machines. State entry starts asynchronous work; that work posts a result event. The host does not decide the next phase.

## Ownership

| Component | Owns |
| --- | --- |
| `packages/core/fsm/fsm.ts` | Legal transitions, guards, exit/effect/entry order, a serialized event mailbox |
| `packages/core/agent/agent-fsm.ts` | One turn's phases, pending tool set and terminal reason |
| `packages/core/agent/agent-conversation.ts` | Serialized child dispatch, immutable completed turns, child replacement |
| `packages/core/agent/agent-runtime.ts` | Injected completion and tool actions, operation cancellation, callback correlation and prompt projection |
| `packages/core/agent/agent.ts` | One cancellable, nonstreaming HTTP completion |

## Using the runtime

```ts
import { createAgentRuntime } from "../packages/core/agent/agent-runtime.ts";

const conversation = createAgentRuntime({
  agent: "writer",
  agents: new Map([
    ["writer", { model: "local-model", systemPrompt: "Write clearly.", tools: ["lookup"] }],
    ["reviewer", { model: "local-model", systemPrompt: "Review the supplied draft." }],
  ]),
  tools: new Map([
    ["lookup", {
      description: "Look up a reference",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      async run(args: unknown, signal: AbortSignal) {
        // Validate each tool's arguments at its boundary.
        if (!args || typeof args !== "object" || !("id" in args) || typeof args.id !== "string") {
          throw new Error("lookup requires a string id");
        }
        const response = await fetch(`https://example.com/references/${encodeURIComponent(args.id)}`, { signal });
        if (!response.ok) throw new Error(`Lookup failed: ${response.status}`);
        return response.json();
      },
    }],
  ]),
  baseUrl: "http://localhost:8000/v1",
  budget: { steps: 6, usd: 0 },
});

await conversation.fire({ type: "user", text: "Draft a summary." });
// fire resolves after the transition, not after the full turn's I/O finishes.
// Read conversation.snapshot for the live child and completed turn records.
// await conversation.fire({ type: "abort" }); cancels the current turn.
```

`fetch` is injectable. Alternatively, supply `complete(request): Promise<Completion>` to adapt another completion source. It receives the projected messages, active model, tool definitions and operation signal. Results contain `text`, optional `toolCalls: { id, name, args }[]`, or an optional `handoff` agent ID. A result cannot both call tools and hand off.

The HTTP adapter translates `tool_calls` and correlated tool messages. It returns a structured completion instead of the old string result. Handoff is an adapter contract: the HTTP client also accepts an optional `message.handoff` extension, but does not assume ordinary chat-completion providers produce it. A provider-specific `complete` adapter can map that provider's handoff mechanism to this contract.

## Transition and cancellation rules

- `idle + user` enters `awaiting_model`.
- Entry to `awaiting_model` allocates an operation and starts one completion if budget remains.
- `awaiting_model + user` reenters the state: cancel once, append the new instruction, start the replacement completion.
- A tool-bearing completion enters `executing_tools`. Entry fans out the batch through the registry. Intermediate results are internal transitions; the final result reenters `awaiting_model`.
- A handoff changes the active agent and reenters `awaiting_model` immediately.
- A final answer, cancellation, exhausted budget or failure enters `done` with an explicit outcome.

Each model request and each tool batch has its own AbortController. All tools in a batch share that batch's signal. Exiting the work state aborts and clears its operation. Tool implementations must cooperate with the signal; late callbacks are ignored even if they do not.

The conversation checks both turn ID and operation ID when dequeuing runtime callbacks. Old completions, abort errors and tool results cannot affect replacement work. Duplicate tool results do not advance the pending set. Unknown tools, duplicate call IDs and unknown handoff targets fail the turn before execution.

The generic machine's `on(trigger, target, effect?)` reenters when the target is the current state. `onIf` adds a guard. `internal(trigger, effect?, guard?)` skips exit and entry. Effects may be asynchronous, but must never await events they enqueue into their own mailbox. Transitions are non-atomic on lifecycle failure. If exit throws, state and context references remain at their pre-exit values. If effect throws, the source state and successful exit context remain. If entry throws, the target state and successful effect context remain. In all cases, in-place mutations and external side effects persist; the rejected `fire()` does not roll them back. Later queued events run against that partial snapshot. Actions should return new contexts and convert expected failures into domain events. Runtime I/O and projector failures follow that event-based policy.

## History and policy

Messages remain turn-local. Each terminal record contains the complete transcript, final agent and outcome (`completed`, `aborted`, `exhausted` or `failed`), plus an error string for failures. Records, their nested tool arguments, and the log array are frozen. The next child starts idle with empty messages and tools, no operation or outcome, and a fresh step allowance. It retains the last active agent.

The default prompt projector combines completed turn logs and current messages, prefixed by the active agent's system prompt. Only the final tool exchange in an aborted, failed or exhausted turn may omit missing results from the projected protocol messages; the original record remains intact. Missing results in a completed turn, an earlier exchange, the current turn or a handoff packet raise a projection error. Orphan, duplicate and unmatched tool results also raise errors. The default projector validates the source transcript even when using a handoff packet. Runtime projection errors fail the new turn before sending a model request, so unexpected history loss is visible. Override `projectPrompt` to implement a different history policy.

The default handoff packet contains the most recent user instruction and the assistant's handoff response. That packet becomes the turn's projected context for the successor, while the full transcript is preserved. Subsequent messages append to both views. Override `projectHandoff` to provide a domain-specific summary or context packet. A new turn returns to the normal history projector.

A step is one launched model operation. Initial requests, barge-in replacements, handoffs and post-tool continuations all consume one step. No request starts when the allowance is zero. The allowance resets for each new turn. `usd` remains informational; monetary enforcement requires usage and pricing inputs.

Streaming is deferred: there is no unused `model_delta` event. User barge-in is legal while awaiting the model; use explicit abort to interrupt a tool batch. There is no automatic retry policy.

## Verification

Run `bun test packages/core` and `./node_modules/.bin/tsc --noEmit`.

Integration tests drive inputs and resolve controlled I/O, with no host switch deciding the workflow. They cover history across turns, immediate handoff, tool fan-out and resumption, actual fetch-signal cancellation, stale callbacks, exhaustion and failure outcomes.
