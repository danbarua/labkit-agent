# Connect an editor to a durable session

Use this adapter when an ACP client should drive core sessions over stdio. The adapter translates
protocol requests into the same session API used by embedded applications. It owns connection/UI
resources; core owns execution and persistence gates. Your factory supplies workspace-bound tools,
credentials, and storage. Avoid implementing another tool loop in the client or factory.

For a runnable agent, use [vscode-workspace.ts](examples/vscode-workspace.ts) and the
[VS Code launch instructions](../../docs/vscode-acp.md). For exact fields, limits, and supported
messages, use the [protocol and binding reference](protocol-reference.md).

## Configure a host

```ts
import type { AcpOptions } from "@labkit-agent/acp";

import { optionsForWorkspace } from "./agent-options.ts"; // Your application function.

export default {
  sessionOptions: ({ cwd, sessionId, signal }) => optionsForWorkspace({ cwd, sessionId, signal }),
  loadSession: true,
} satisfies AcpOptions;
```

The factory returns core `{ configuration, bindings, persistence }`, optionally with ACP selectors
and commands. Bind paths to the supplied absolute `cwd`; do not change process.cwd(), which would
affect other sessions. Honor setup cancellation: a disconnected client must not publish a late
session. The adapter closes its sessions on disconnect; your application still owns storage and
credential lifetime.

Launch the CLI with `--config /absolute/path/to/acp-config.ts`. Keep stdout exclusively for protocol
frames, including during module imports and tool execution. The CLI configures durable diagnostics
before importing the factory; use those logs or stderr for diagnostic output.

The workspace example reads `LABKIT_ACP_MODEL` and provider credentials from the environment.
`LABKIT_ACP_PROVIDER` selects `anthropic` (default), `openai`, `openai-responses`, or `google`.
`LABKIT_ACP_MODELS` declares additional selectable models; no catalog is inferred. Anthropic defaults
to native adaptive thinking; use `LABKIT_ACP_THINKING_MODE=budget` for manual 1024-token thinking.
Choose a binding whose declared capabilities match the models you offer.

## Derive UI configuration from committed policy

A selector's `current(policy)` must read the saved policy; each option supplies a policy patch.
Do not maintain a parallel selected-model or permission-mode variable. Otherwise a failed append
or reload can leave the UI advertising a setting the runtime never accepted.

A configuration request waits for an active prompt to settle, commits its patch, and then returns
updated options. New prompts wait behind that commit. Core rejects unsupported model/settings
combinations. If you remove a model or change the tool manifest, reopening an older session can
fail validation. Preserve compatible bindings for sessions you intend to reopen; this unreleased
software does not migrate historical journal formats. See
[configuration binding details](protocol-reference.md#configuration-bindings).

## Keep display, permission, and completion distinct

A pending tool card describes intended work. Only `request_permission` approves a call, and every
call in the batch must be approved before any tool runs. A refusal blocks the batch; a cancelled
dialog aborts the turn. The adapter maps the typed core refusal directly to ACP `refusal`.

Stream text is provisional. It can be visible before EOF exposes a malformed response, and a tool
card can show completion before its result is saved. Wait for the prompt response to decide how
the turn ended; use the core terminal outcome/logs for the underlying cause. Completed turns map
to `end_turn`, exhausted steps to `max_turn_requests`, and aborted turns to `cancelled`. Other
execution/storage failures become JSON-RPC errors. Failed admission and storage settlement expose
the core structured failure in error data, including operation identity and reconciliation causes. A display notification is never a receipt.

Reload renders saved conversation data without rerunning tools or asking for old permissions.
Live terminal handles, stream callbacks, and MCP connections are recreated as needed, not recovered
from the journal. An interrupted write may have taken effect; repeating it needs a new explicit
invocation. See [session recovery](../core/session/README.md#reopen-without-repeating-effects).

## Decide which environment owns an effect

| Integration               | Ownership and consequence                                                                                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace file tools      | Local operations enforce workspace checks. With client filesystem capability, reads/writes use editor semantics, including unsaved buffers. Client errors do not fall back to disk.           |
| Client terminal           | Opt in with `LABKIT_ACP_TERMINAL=1`; execution needs client support and permission. Cwd is not an OS sandbox, and cancellation cannot undo command effects.                                   |
| MCP tools                 | The discovered catalog is fixed for an open session and uses core permission/result gates. MCP roots are advisory, not process confinement. Restore reconnects but never repeats saved calls. |
| Attachments               | Supplied bytes/local resources are stored before user-input admission. They are user input, not model-requested tool execution; no tool permission dialog is created.                         |
| Plan and progress updates | Display state only. A plan item does not execute itself or become complete because an unrelated tool succeeded.                                                                               |

The workspace example stores journals and blobs in `<cwd>/.labkit/sessions/store.sqlite`. Back it up
while stopped and retain the canonical workspace location: moving the database to another workspace
is rejected. Deleting a session removes its journal/blobs and does not delete independent fork
children. Remote/client resources have their own cleanup rules; consult the
[reference](protocol-reference.md) when adding one of these integrations.

## Find an operational failure

The CLI prints the log path on stderr. By default it is
`~/.labkit/logs/acp-<pid>-<launcherId>.jsonl`, with debug-level records, 10 MiB rotation, four backups
per launch, and retention of the newest 20 stopped launches. See
[logging settings and retrieval](../../docs/vscode-acp.md#runtime-diagnostics) for overrides and
failure behavior. Custom launchers must supply their own durable logging; core does not install it.

Find the session ID, then follow `connectionId`/`rpcRequestId` into `turnId` and operation IDs.
`acp.permission.waiting` means the client owes a decision; `tool.awaiting_release` means a result
awaits its runtime gate. `child.failed` and provider events retain the actual cause. Ordinary success
should produce no warnings. Full HTTP bodies require the separate
[provider capture binding](../core/environment/README.md#retained-provider-traffic).

```sh
LOGTAPE_TEST_MODE=always LOGTAPE_TEST_LOWEST_LEVEL=debug bun test packages/acp
bunx tsc --noEmit
```

Tests drive JSON-RPC and a spawned stdio process against scripted dependencies. They do not prove
that a particular editor exposes every supported control or that a live provider accepts a model.
