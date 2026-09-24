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

Provider bindings supply `providerCapabilities` to policy validation. Thinking may be omitted,
`off`, `low`, `medium`, `high`, or `adaptive`. Off/omitted is always legal; effort values require
an effort capability listing that value, and adaptive requires an adaptive or budget capability. For budget
profiles, adaptive selects the versioned default budget; there is no numeric policy value. Unsupported settings fail closed during policy
validation and again before transport fetch. Policy packs may supply the same thinking field.
Provider switches must explicitly patch thinking to a supported value when necessary.

Message projections preserve optional content parts alongside legacy text. Built-in history and
context-only policies keep refs on retained messages; slim handoff keeps refs on the last user and
assistant only. Capability checks and blob reads occur after projection. Projectors perform no I/O:
text attachment inlining (up to 64 KiB) or named hash stubs are produced at encode time through an
operation-local resolver. Custom projections should retain parts for attachments they intend to send.

`providerStreams` records each bound profile's stream capability and assembler availability.
`stream: true` requires a matching supported provider; off/omitted retains nonstream behavior.
Policy validation (including restore and patches) and transport independently reject unsupported
streaming before HTTP. Switching to a nonstream profile requires patching stream:false. Stream
notifications remain outside policy/turn decisions; the captured prepared request controls the
operation and one assembled completion determines its outcome.

`permissions: "ask"` enables once-only permission requests for every admitted tool call. It requires
an environment `requestPermission` binding; create, restore and policy patches reject a missing
binding. Omitted/`off` preserves immediate execution after the intent receipt. Changes commit only at
idle boundaries. `queue-user` and `abort-tools-on-user` also apply during `awaiting_permission`;
default admission rejects new user input there. Tool-error continuation never overrides permission
rejection. No remembered grants or new policy enum for individual answers are introduced.
