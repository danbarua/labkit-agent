# Choosing behavior for the next turn

Policy is the saved answer to “what is this session allowed to do?” Bindings provide executable
implementations and credentials. Keeping those separate makes a model/permission change auditable
without putting functions or secrets into the journal.

Use `session.updatePolicy(patch)` and check its receipt. Changing configuration is two transitions.
Selecting validates the patch against the live registry and stores the result in the session's
configuration store at once, at any time, including while a turn runs; it is never `busy`. Applying
records a "configuration applied" `policy` record at the next boundary between turns, before any
queued input starts, so a running turn keeps the settings it started with. The receipt is `accepted`
when the conversation was idle and the record committed, `selected` when a turn is running and the
change waits for it to end, `ignored` when the selection matches the policy in force, and `failed`
when the patch is rejected or cannot be stored. `session.selectedPolicy` is what the next turn runs
under; `session.policy` is what is in force now. Mutating an options object does nothing to an open
session.

## Choose how new input interacts with work

| Choice                               | When it fits                                              | Consequence to handle                                                                                                                             |
| ------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `default@1`                          | Interactive replacement of a model request.               | Input can replace a step in flight (including a handoff successor's step) in the same turn; input during tools/permission waiting is rejected.    |
| `strict@1`                           | Each active turn must finish unchanged.                   | New input cannot barge in.                                                                                                                        |
| `queued@1`                           | Every accepted input needs its own turn.                  | Inputs persist in order; aborting the current turn does not discard its queued successors.                                                        |
| `abort-tools-on-user` input behavior | A new instruction should stop tool work first.            | The successor is saved before cancellation and starts only after the aborted turn commits. Already-started effects cannot be undone.              |
| `tolerant@1`                         | The model can use a tool error to choose its next action. | Tool input and execution failures, including an expired tool deadline, become error results; permission refusal and cancellation still stop work. |

Selecting a pack resets its behavior fields; fields explicitly supplied in the same patch override
that pack. Inspect the resulting committed policy rather than maintaining a second mutable copy.
Steps and tool restrictions remain session configuration. Tool restrictions affect both the tools
advertised to the model and the returned calls that can be admitted.

`steps` bounds model requests in a turn, including replacements, handoffs, and continuations after
tools. It is not a token/cost budget or wall-clock limit. Use optional `completionTimeoutMs` and
`toolTimeoutMs` for operation deadlines; null disables them. A deadline does not authorize a retry.
Permission waiting remains untimed.

## Choose what history the model sees

`history@1` includes completed history. `context-only@1` omits completed turns while retaining
configured/session instructions, replacement context, and the current turn's messages. Use the
latter only when your application deliberately supplies sufficient context: the journal can retain a
fact that the model does not see.

Handoff projection is separate. `handoff-slim@1` gives the successor the latest user instruction and
handoff message; `handoff-history@1` carries history. Slim handoff reduces input but requires the
handoff to contain what the successor needs. Neither setting generates a summary. On a handoff
step the projection receives the packet plus the messages added since as `input.handoff`, and
`project` decides what to send: `history@1` sends that packet; `context-only@1` ignores it and
sends the replacement context and the current turn's messages, as on any other step.

Custom projectors must be pure and preserve correlated tool exchanges and desired attachment refs.
They may select/rearrange valid context, but cannot fetch files or call another model. Invalid
projected calls fail the step before HTTP. Malformed provider calls fail completion admission;
neither becomes a tolerant tool result because no tool operation was admitted.

## Model settings and permission scope

Select a provider binding name and declared model. Capabilities come from that model's bound profile,
not from guesses based on its name. Unsupported thinking, streaming, or media combinations reject
before HTTP, including on configuration changes. Patch incompatible settings together when switching
models. A restored session whose saved selection is no longer bound is not rejected: replay ignores
live availability, and the next work first journals a reconciled policy (see
[registry adoption](../../../docs/session-runtime.md#restore-adopts-the-live-registry-and-bindings)).
See [model binding examples](../providers/README.md).

Thinking `adaptive` means native adaptive support. Manual `budget` requires an explicit
`thinkingBudgetTokens` and a larger `maxOutputTokens`; the runtime never substitutes 1024.
Anthropic always requires an explicit output limit. Clear a manual budget with null when changing
thinking modes. Effort values are limited to the bound profile's declared
values. `off` or omission disables thinking. These settings are distinct, not approximations.

`permissions: "ask"` requires a permission binding. Valid tool calls need explicit approval or a
previous live-session approval for that tool; invalid arguments do not request permission under
`return-error-and-continue`.
`off` permits immediate execution after the intent receipt. Permission scope is a turn-boundary
choice; a tolerant tool-error policy cannot override a user's refusal.

## Version behavior, not saved credentials

Policy/projection/handoff resolver IDs such as `history@1` name behavior supplied by the environment.
Restore does not require them: a saved ID the live environment lacks is reconciled to the value a new
session would get, and the next work journals that change (see
[registry adoption](../../../docs/session-runtime.md#restore-adopts-the-live-registry-and-bindings)).
If you change a custom resolver's meaning, give it a new ID rather than making saved sessions
silently project different requests.
The policy revision records committed configuration changes; it is independent of the journal's
single format identifier. Thinking, attachments, and permissions do not select journal versions.

Test policy changes through a session as well as the pure resolver. The important assertion is which
request is dispatched after the receipt, and that work already in flight keeps its captured settings:

```sh
LOGTAPE_TEST_MODE=always LOGTAPE_TEST_LOWEST_LEVEL=debug bun test packages/core/session/policy-runtime.test.ts packages/core/session/consumer-contract.test.ts
```

Look for `configuration.selected` and `configuration.applied` in the environment diagnostics; they
share a `selectionId`, and `configuration.applied` names the append, revision, version and changed
fields. A selected UI value is not evidence that the configuration applied.

A continued tool failure projects both the readable `error` and structured `failure` into the model
result, including operation identity and the original cause. This lets the model distinguish a
missing path from a provider/client error instead of seeing only a generic message. The original
failed outcome remains in the journal; continuing does not retry the operation.
