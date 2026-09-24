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

ACP steps 1–2 are implemented in process. Request permissions and JSON-RPC are not implemented.
Streaming remains deferred; a future stream sink can use the same notification-only pattern.
