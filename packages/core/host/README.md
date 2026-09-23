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
