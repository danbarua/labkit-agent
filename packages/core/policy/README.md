# Versioned policy

Policy is immutable JSON data. Functions are bound separately through `PolicyResolvers`, copied at
session construction. Pack/projection/handoff identifiers include a revision such as `history@1`.
Keep implementations pure, synchronous and behaviorally compatible when restoring the same IDs.
Missing IDs reject restore before new work is admitted.

Built-in packs are `default@1`, `strict@1` (no barge-in), `queued@1` (queue user input), and
`tolerant@1` (return tool errors to the model). Selecting a different pack resets its behavior fields;
explicit patch fields then override them. Allowance and tool restrictions remain session data.
Unknown packs/resolvers, contradictory queue/barge-in settings and undeclared tools are rejected.

`history@1` retains legacy history/handoff projection. `context-only@1` omits completed conversation
history but keeps configured/session system messages, replacement context and all current-turn
messages, including correlated tool exchanges. Handoff resolvers include `handoff-slim@1` and
`handoff-history@1`; custom resolvers must preserve valid exchanges. All final provider messages are
schema- and correlation-validated. No projection may run I/O or summarize implicitly.

Patches commit at idle boundaries, considering both durable and staged turn state and durable queued
inputs. Steps update both allowance and the idle turn; permission sets constrain both advertised
provider tools and returned tool calls. Active-agent changes remain handoffs.

`queue-user` stores distinct pending inputs in the journal and starts them in admission order after
terminal commit. This is separate from the session storage queue. `abort-tools-on-user` journals the
new input before cancelling the old batch; the successor starts only after the aborted terminal
commits. Abort alone cancels the active turn, not already accepted queued successors. Close settles
live callers; restore records cancellation of queued inputs and never starts them automatically.

For tool-error continuation, the journal retains the raw failure. `effectiveToolResult` deterministically
projects it as JSON text `{ "error": "message" }` for batch correlation and model context. Both live
release and replay use this function. Successful siblings continue; cancellation is not an error result.

Malformed tool-call arguments in a custom projection are prompt-preparation failures, not executed
tool failures. Malformed provider arguments are rejected during completion decoding. Neither case
synthesizes a tool result for an unadmitted call; tool-error continuation applies to admitted tool
operations, including their output-validation failures.
