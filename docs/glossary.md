# Glossary

These are the canonical meanings of Labkit's domain terms. Use them in code, docs, plans and agent
prompts. When existing code uses a word differently, the "Code today" note says so. Those uses are
naming debt, not alternative definitions.

## Conversation structure

**Turn.** Everything from a user prompt until the model stops. After that the conversation waits for
the next prompt. One turn can contain hundreds of steps and last an hour.
Code today: `TurnState` (`packages/core/agent/agent-fsm.ts`). ACP and VS Code call a turn a "prompt".
Not to be confused with the provider stop reason `end_turn`.

**Step.** One LLM call. The model emits narrative and tool-call decisions. The harness dispatches those
tool calls and gathers their results, and the results go back to the model in the next step.
Code today: "step" in `docs/core-runtime.md` and the policy's `steps` allowance. `TurnData.generation`
is not a step counter; it counts child operations and rises two or three times per step.

**Step boundary.** The point where the next completion request is assembled from history, the current
turn and any new context. This is where interjections are inserted.
Code today: prompt projection (the `prepare_model` child and the policy `project` resolver, such as
`history@1`). The provider profile's `encode` only formats the request; it adds no content.

**Settled step.** A step whose model output is committed to the journal (`model_settled`). Queued
notices wait for this point. Other things also "settle" (operations, tool batches, turns, append
receipts); always name which one.

**Tool call / tool batch.** A tool call is one invocation proposed by a step. The tool batch is all
calls proposed by one step. Code today: the next step waits until the whole batch has settled. That
is current behaviour, not a requirement (see Backgrounded tool call).

## Getting context to the model mid-turn

**Interjection.** Context that arrives while a turn is running and is delivered to the model at the
next step boundary. The turn continues. There are four kinds:

- **Steering:** input from the user.
- **Advisory:** guidance from an advisor reviewing the work.
- **System notice:** code-based rules, TODO-list reminders, messages from other sessions or agents.
- **Memory recall:** memories surfaced by what the agent is doing, such as reading or editing a file.

An interjection that has gone stale should be dropped or re-checked before delivery. A note is stale
when its subject changed after it was written.
Status: not implemented. There is no interjection event type. User input during tools is rejected
under `default@1`, and at best (`queue-user`) it waits until the turn ends. `system` events are
refused while a turn is active.

**Backgrounded tool call.** A tool call that is still running when the next step starts. The model
receives a placeholder result ("running in the background") so that the interjection can be
delivered, and the real result arrives later as ordinary content.
Status: not implemented. The turn machine holds one child operation at a time and moves on only
after the whole batch settles.

**Barge-in.** Cancelling a live completion, streaming or not, and re-issuing that step with the new
context. This is a separate feature from interjection at the step boundary.
Code today: the `bargeIn` policy flag; some docs call it "replacement". It is implemented only for
user input while a step is preparing or awaiting the model. The partial stream is discarded, and
the re-issued call uses up a step.

**Queued input.** User input held for delivery after the current turn (`pendingInputs`, the
`queue-user` policy). It is not an interjection: it waits for the end of the turn, not for the next
step.

## Configuration and history

**Configuration.** The user-selectable settings of a session: provider, model, thinking, output limit,
streaming, permissions, tool scope and tool-failure handling. Configuration can change at runtime. A
change is committed to the journal and applies from the next turn. A turn already in progress keeps
the settings it started with. Users choose providers and models by name. Adapter profile versions
(such as `anthropic-messages@4`) are internal and are never offered as choices.
Code today: journaled as `policy` records and changed by policy patches.

**Model catalog.** The list of providers and models the environment can use, together with each
model's thinking choices and output limit. It is built from the committed models.dev snapshot, plus a
localhost server if one is reachable (`packages/core/providers/catalog.ts`).

**Registry.** The live tool and agent definitions a session runs with. When a session is reopened, a
registry that differs from the saved one is adopted: the first new work records the live registry in
the journal, and the saved history stays unchanged.

**History.** The committed record of what happened: prompts, model output, tool calls and results,
and configuration changes. History is a record of facts. Reopening a session must never require
today's models, tools or settings to match those of the past.

**Load.** Rebuilding session state from the journal. This is a fold over committed records, checked
for integrity (ordering, revision continuity, identifiers, schema).
Code today: `replay()` in `session-log.ts`. It also re-runs some commit-time checks, such as the
captured prompt against its projection. Checks that the current environment has the right bindings
were removed.

**Recovery.** Closing a turn that was interrupted by process exit when the session is reloaded. External
effects are not repeated. Do not confuse it with **reconciliation**, which resolves a storage append
whose outcome was uncertain.

## Words with more than one meaning in code today

Qualify these words, or rename them in new code:

- **admission:** a durable input receipt, the policy field for handling input during a turn, and
  staging failures. Prefer "input receipt" and "mid-turn input policy".
- **batch:** a tool batch, and a journal append batch (`CommittedBatch`).
- **child:** a child operation of a turn, and a child session created by fork or compaction.
- **settle(d):** operation, tool batch, turn, and append receipt.
- **pending / queue:** durable queued inputs, the in-memory submissions awaiting a storage receipt, and
  staged appends.
- **projection:** the prompt projection, and the web UI's view of a session.
- **continuation:** a provider continuation payload (thinking signatures), the next step of a turn,
  and continuing after a tool error.
- **system:** standing session instructions (`systemInputs`), an agent's `systemPrompt`, and the
  `system` chat role. None of these is a system notice.
- **replacement:** barge-in, compaction context, and registry replacement.
