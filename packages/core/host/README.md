# Execution host

Both runtimes use `createHost` for completion, preparation, handoff and tool-batch execution.
It owns copied registries, child actors and cancellation. It has no persistence port or session FSM.
The agent runtime remains nonjournaled; the session runtime releases work after committed receipts.

`dispatch(command, context)` captures and freezes the prompt, permissions and projection functions
for that operation. Private sinks report correlated turn and individual tool outcomes. Reporting a
tool result does not advance its batch: `releaseTool(outcome)` is a separate, single-use operation.
The session calls it only after its append commits. Closing a host drops late outcomes and cancels
only its own children. Forks allocate independent hosts.

`ports.ts` owns `Tool`, `defineTool`, `CompletionPort`, registry copying and `completionTransport`.
The latter captures credentials, provider URL and fetch implementation in its closure. Existing agent
exports remain compatibility exports; new integrations can import the host port definitions directly.

The reusable completion/tool contract suites accept adapter factories over scripted sources. They
exercise the adapter through the same validating operation actor used by the host. Cancellation
means the signal is delivered and late results cannot settle the actor again; it does not assert
rollback or exactly-once external effects. `host.test.ts` separately verifies the tool release gate.

Tool outputs are JSON-only: null, booleans, finite numbers, strings, arrays and plain objects.
Return null instead of undefined, and explicitly convert dates or class instances to JSON data.
The host reports output validation failures through the same correlated tool-outcome path as
execution errors. Error-continuation policy can project that failure into a model tool message.

Attachment I/O is supplied through the execution context's `loadBlobs` binding. Preparation calls
it to validate projected refs. Completion calls it again after the prepared journal receipt and
passes the resulting BlobId-keyed resolver as the optional third argument to `CompletionPort`.
Each call receives its operation's AbortSignal. Bytes and resolver functions never enter prepared
snapshots, child outcomes, or journal events. The session binding owns persistence and media checks;
the host continues to own operation lifetime and cancellation.

For completion, `loadBlobs` receives `includeContinuations: true`; preparation omits it and reads
only attachment refs. After admitting completion, the host stamps continuation owner/provider and
awaits the session-supplied `storeContinuation` binding inside the completion operation. This binding
keeps small payloads inline or writes large payloads as blobs. It receives the same AbortSignal;
only a validated envelope can enter the child outcome. The host itself owns no persistence handle.

## Tool display notifications

`defineTool` accepts optional `kind` (default `other`) and a pure synchronous `locations(parsedArgs)`
callback returning `{ path, line? }[]`. Paths must be absolute; lines are nonnegative integers.
The callback receives a copy of validated input and must perform no I/O. Metadata errors omit
locations and emit a diagnostic; they do not authorize, reject, or change execution.

```ts
const readDesign = defineTool({
  input: z.object({ path: z.string() }),
  kind: "read",
  locations: ({ path }) => [{ path }],
  run: ({ path }) => Bun.file(path).text(),
});
```

The optional third sink, `createHost(bindings, { turn, tool, toolUpdate })`, receives frozen
`HostToolNotification` values. Public runtimes expose it as `RuntimeOptions.toolUpdate` or
`SessionBindings.toolUpdate` (also supported by legacy flat session options). Bindings are captured
at construction and inherited by forks. Each notification includes sessionId when available,
turnId, batchId, the provider's callId, and toolCallId (the unique operation child ID).

- `sessionUpdate: "tool_call"` is emitted on spawn with name, title (the tool name), kind,
  rawInput, and status `pending`.
- After input validation, `tool_call_update` supplies locations before `tool.run` is invoked.
  Invalid input produces `failed` without deriving locations or running the tool.
- Operation transitions emit `in_progress`, then `completed` or `failed`; output validation
  remains in progress. Cancellation maps to failed. Repeated status values are suppressed.
- Terminal updates supply rawOutput: the validated, normalized tool-result string on success,
  or `{ error: message }` for failure/cancellation. Updates omit unchanged fields.

This is best-effort display data, not a journal event or permission gate. Callback exceptions,
rejected promises, and pending promises do not affect operation results or delay dependent work.
The completed notification can arrive before the result append commits; only `tool` and
`releaseTool` advance the batch. Replay/restore emits no historical tool updates. Closing the host
suppresses further notifications; cancellation while open emits one terminal update, ignoring late
validation/output. Consumers should use session snapshots for authoritative state.

ACP tool notifications and once-only permission requests are implemented in process.
The separate [ACP stdio adapter](../../acp/README.md) carries them over JSON-RPC.
Streaming uses the same notification-only helper through a fourth sink, `streamUpdate`.
It receives frozen `HostStreamNotification` values with sessionId, turnId, completionId (child ID),
generation, and `sessionUpdate: "completion" | "completion_update"`. Status transitions are
pending → in_progress → completed/failed; cancellation maps to failed. Intermediate updates carry
append-only text/thinking strings or provider-native usage fields, omitting unchanged fields.
CompletionPort's optional fourth argument receives these deltas without ownership or journal data.
The host validates delta shape, adds identity, and drops notifications after cancellation/settlement.

Only the final assembled body is decoded and admitted. Completed display status follows admission
and any continuation blob storage but does not certify a journal receipt. Incomplete/error streams
fail the completion child and never publish a successful partial model_settled. Stream callbacks,
like tool callbacks, cannot fail operations or hold the execution gate. Both runtimes capture the
optional streamUpdate binding; session provider profiles opt into streaming through policy.

## Permission requests

`ExecutionBindings.requestPermission(request, signal)` is an authoritative port, separate from the
four notification/outcome sinks. Context `permissions: "ask"` inserts `awaiting_permission` between
an admitted tools completion and `run_tools`. Without that setting, execution retains its existing
behavior. The nonjournaled runtime opts in when `RuntimeOptions.requestPermission` is supplied;
sessions use an explicit policy setting.

Requests carry sessionId, turnId, requestId, a pending toolCall (including kind, rawInput and parsed
locations), and the two options `allow-once` / `allow_once` and `reject-once` / `reject_once`.
Return `{ outcome: { outcome: "selected", optionId: "allow-once" } }` (or `reject-once`), or
`{ outcome: { outcome: "cancelled" } }`. Unknown options, malformed responses and callback failures
fail closed. Remembered choices are not supported.

Calls are presented in admitted order. Every call must be allowed before any tool in the batch runs.
A rejection fails the turn; cancellation aborts it. Neither fabricates a tool result for an unrun
call. Pending tool notifications and permission requests share the eventual tool child ID. Permission
approval does not mark a tool in_progress: that transition still belongs to actual execution.

Input parsing occurs before asking and its exact result is held in host memory for execution after
approval. Parsers and location callbacks must not perform tool effects. Locations remain display
metadata, not a filesystem sandbox. Runtime functions, parsed inputs and grants never enter the
journal. Abort/close revoke grants and signal the pending callback; late responses cannot run tools.
The port receives a frozen request. Unlike display sinks, its response is awaited and validated.
