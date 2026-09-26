# Completion and tool integration

The host owns the lifetime of external work for both session and in-memory runtimes. Put tools,
completion adapters, and permission UI here through bindings. Do not put controllers or callbacks
in snapshots, and do not add a second execution loop in a UI or protocol adapter: two loops could
execute the same admitted tool call twice.

Most consumers only need `defineTool` and `CompletionPort`, exported by the session API. Direct
`createHost` integration is for runtime authors who also take responsibility for outcome routing
and the result-release gate described below.

## Implement a tool

```ts
import { isAbsolute } from "node:path";

import { defineTool } from "@labkit-agent/core";
import { z } from "zod";

const readDesign = defineTool({
  input: z.object({ path: z.string().refine(isAbsolute, "Use an absolute path") }),
  kind: "read",
  locations: ({ path }) => [{ path }], // Validated absolute display path, not authorization.
  async run({ path }, signal, context) {
    signal.throwIfAborted();
    return Bun.file(path).text();
  },
});
```

Input is validated before execution. Output must be JSON: use null instead of undefined and convert
dates/classes explicitly. Output validation can fail after the tool's external effect has happened;
a failure therefore does not imply rollback. Keep parsing and `locations` pure, since the host may
use them before permission is granted. Enforce filesystem or service access rules inside your tool;
display locations are not a sandbox.

Pass the operation's AbortSignal into downstream I/O. `ToolRunContext` supplies `sessionId`,
`turnId`, `batchId`, provider `callId`, and unique operation `toolCallId`. Use it for nested request
capture or resources such as a terminal. Names and argument equality do not distinguish repeated
calls. Context is not an approval token, and a tool called directly outside the host has no context.

## Implement a completion binding

`CompletionPort(request, signal, blobs?, onDelta?, correlation?)` receives a validated prepared
request. Return `{ completion, continuationPayload?, usage? }`; the host validates the untrusted response
before accepting it. The public request/response types and the
[executable exchange](../session/examples/completion-binding.ts) show tool arguments and messages.
Use [provider bindings](../providers/README.md) for supported HTTP dialects. Before invoking the
completion port, the host logs its full ordered system messages as `completion.system_prompt`
at INFO. This shows the instructions actually supplied to that operation, including committed
shared-instruction changes; restoration alone does not emit a fictitious completion.

Use the supplied blob resolver for attachments and continuations; it is scoped to that operation.
Do not retain it in domain state. The session arranges blob storage and loading while the host owns
cancellation. A continuation write failure prevents a successful completion outcome, so tools
cannot run from a response whose required context could not be saved.

Optional `usage` is serializable response accounting, exported as `CompletionUsage` from the
session entry point. Keep missing counters absent and preserve native counters. The host carries
it with the admitted completion; it cannot release accounting ahead of that completion's receipt.
`completion.usage.received` identifies validation at the operation boundary. The session separately
logs `completion.usage.committed` after persistence. Neither means a cumulative bill or a count of
current context tokens.

Optional deltas are for display. A stream still needs one complete validated response: partial text
cannot authorize tool execution or count as a successful answer. Pass correlation into transport
capture so a bad response can be identified without reconstructing the request from the journal.

## Permission and display ports

`requestPermission(request, signal)` is authoritative. With `permissions: "ask"`, the host validates
inputs and resolves approval for calls in order. Under `return-error-and-continue`, an invalid input
records an `invalid_input` decision without asking permission. After that decision commits, the
host reports a failed tool result containing the validation cause; the invalid call never runs.
Valid siblings still require approval. The model receives all committed results to choose its next
action. `tool.input_rejected` explains the invalid call and consequence in diagnostics. Return `allow-once`, `allow-session`, `reject-once`, or a
cancelled outcome. Every call must be allowed before the batch runs. A malformed response or callback
failure fails closed; cancellation discards uncommitted grants, and late approval cannot start a tool.
`allow-session` approves the named tool for all arguments in this host's live session. The host
installs that grant only when the committed permission outcome releases the batch. Later calls
still validate inputs and commit permission outcomes, with the original grant ID and `remembered`
source. Other tools still need approval. Rejection/cancellation discards uncommitted grants.
Closing the host, explicitly committing permission mode, or changing allowed tools clears remembered grants; restore does not resurrect
them. `permission.granted`, `permission.reused`, and `permission.grants_cleared` explain this at INFO.
Model, thinking, and limit changes retain approvals. Direct host consumers call `resetPermissions`
after committing an explicit permission reset or changed tool scope; dispatch does not infer
authorization changes from a general policy revision.
An existing committed grant survives cancellation of a later turn; cancellation stops work rather
than changing the user's authorization. Select Ask in ACP Tool approvals to revoke remembered grants.

`toolUpdate` and `streamUpdate` are best-effort display subscribers. Their exceptions or pending
promises cannot block execution. Use their operation IDs to update existing cards/chunks. Tool updates include the known tool name
so adapters can select display bindings without recovering it from a journal or another callback. Restore
emits no historical host notifications; render saved history from session state instead.

| Signal              | Suitable use                               | Authority it does not provide                   |
| ------------------- | ------------------------------------------ | ----------------------------------------------- |
| Pending tool card   | Show intended work and resolved locations. | Permission to execute.                          |
| Completed tool card | Show the locally validated result.         | Proof that the result was saved.                |
| Stream delta        | Show provisional text or thinking.         | A complete answer or admitted tool call.        |
| Permission response | Allow this call within its batch.          | A journal receipt or approval for another call. |

## Why a tool result has a separate release gate

A session must save each tool result before a batch can use it. Otherwise the next model request
could depend on a result that disappears after a crash. The host reports the result to the runtime,
then waits for `releaseTool(outcome)`. The session calls that method only after the matching append
receipt. The in-memory runtime releases immediately because it makes no persistence promise.

Direct host consumers must release each correlated result at most once. Do not release from a
notification callback or infer a commit from logging. See the
[tool-result diagram](../../../docs/session-runtime.md#save-each-tool-result-before-continuing).

## Cancellation is a settlement rule, not rollback

The host captures optional completion/tool deadlines when spawning work. Expiry sends cancellation
with classification `timeout` and its limit. Explicit cancellation has a different reason. Timers
are cleared on settlement/close; permission waiting has no deadline in core.

An operation settles once. A tool that ignores cancellation may still change the outside world, but
its late result cannot complete a replacement operation or restart the loop. Batch failure cancels
unfinished siblings with the initiating failure attached, preserving which call caused the stop.
There is no implicit retry. Forks own separate hosts, so closing one does not cancel another.

## Find the cause of a stopped operation

`child.failed` records the originating validation/execution phase and diagnostic cause;
`child.timed_out` adds the configured limit. `tool.awaiting_release` means execution finished but
the runtime has not released its result. For a session, investigate storage when that wait persists.
`permission.waiting` instead means the entire batch awaits a user decision. These waits require
different interventions and must not be presented as a generic “tool running” state.

Public failures preserve serializable operation identity and cause; runtime logs additionally carry
stacks. Configure the [environment sink](../logging/README.md) and join records by session/turn/child
and batch/call IDs. Inspect real success and failure paths with:

```sh
LOGTAPE_TEST_MODE=always LOGTAPE_TEST_LOWEST_LEVEL=debug bun test packages/core/host packages/core/session/consumer-contract.test.ts
```

## Module map

| Module                   | Contents                                                                          |
| ------------------------ | --------------------------------------------------------------------------------- |
| `host.ts`                | Public types and `createHost`: dispatch checks, the table call, public methods    |
| `context.ts`             | `HostContext`: registries, children, grants, sinks, and the `spawn`/`cancel` core |
| `commands/index.ts`      | The handler table keyed by turn command type, plus `cancel`                       |
| `commands/model.ts`      | `prepare_model` and `complete`                                                    |
| `commands/handoff.ts`    | `prepare_handoff`                                                                 |
| `commands/permission.ts` | `request_permission`: input validation and permission grants                      |
| `commands/tools.ts`      | `run_tools`: the tool batch actor and each tool call                              |
| `ports.ts`               | Binding types, `defineTool`, and registry validation                              |
| `notifications.ts`       | Best-effort delivery to display sinks                                             |
| `testing/`               | Contract suites for completion bindings and tools                                 |
