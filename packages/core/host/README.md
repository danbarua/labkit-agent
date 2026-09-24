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
