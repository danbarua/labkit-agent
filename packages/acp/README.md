# Connect an editor to a durable session

Use this adapter when an ACP client should drive core sessions over stdio. The adapter translates
protocol requests into the same session API used by embedded applications. It owns connection/UI
resources; core owns execution and persistence gates. Your factory supplies workspace-bound tools,
credentials, and storage. Avoid implementing another tool loop in the client or factory.

For a runnable agent, use [vscode-workspace.ts](examples/vscode-workspace.ts) and the
[VS Code launch instructions](../../docs/vscode-acp.md). For exact fields, limits, and supported
messages, use the [protocol and binding reference](protocol-reference.md).

## Build, test, and debug ACP from the repository root

```sh
bun run build:acp   # Bundle the CLI and workspace config into packages/acp/dist/
bun run test:acp    # Run the ACP suite; no provider credentials needed
bun run logs:acp    # Read the newest launch log; add --errors for warnings/errors
bun run debug:acp   # Build, drive real stdio, and retain failure/restore evidence
bun run dev:acp     # Run source over stdio with the workspace config
bun run start:acp   # Run the built version over stdio (build first)
```

`debug:acp` needs no editor or API key. It exercises initialization, a permission-approved
file read, a scripted HTTP failure, and restart/load. It prints a unique directory under
`.session-artifacts/acp-debug/` containing protocol replies, journals, and actual launcher logs.
The intentional HTTP 400 must appear with its provider request ID and redacted credential.
A failed check exits nonzero and keeps the evidence. Remove old debug run directories yourself.

`dev:acp` and `start:acp` are protocol servers, not interactive chat terminals. They need at least
one provider API key or a running local model server; connect them to an ACP client.
Live-launch logs default to `~/.labkit/logs/` (DEBUG, 10 MiB rotation, four backups per launch,
20 stopped launches retained); the exact file is printed on stderr. Stdout stays protocol-only.
For an editor launch, use the absolute built CLI and config paths described in
[the VS Code setup](../../docs/vscode-acp.md).

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

The workspace example offers models from the core model catalog (`catalogProviders` over the
committed models.dev snapshot), the same catalog the web console uses. It binds every provider whose
API key is set, under the key names the snapshot lists for it (for example `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `GOOGLE_API_KEY`/`GEMINI_API_KEY`, `XAI_API_KEY`). It also binds a local
OpenAI-chat-compatible server when `GET <base>/models` answers; the base is `LABKIT_LOCAL_BASE_URL`
(default `http://localhost:8000/v1`). Discovery runs once, on the first session, and is logged as
`acp.catalog.loaded` (credential variable names only, never values) and, if the local server does
not answer, `acp.catalog.localhost_unavailable`. With nothing bound, session creation fails and
names the variables checked and the local URL tried.

The Model selector groups models by provider; option values are `<provider>/<model>`. Thinking and
output-limit choices come from the selected model's catalog entry: adaptive, explicit budgets
(1024/4096/8192/16384 tokens, at least the model minimum and below the output limit) or effort
levels. Always-on models (Fable, Mythos) have no "off". The output limit covers thinking and answer
tokens and is capped at the model's limit. Changing model keeps the thinking setting when the new
model offers it, otherwise turns thinking off (or on, for always-on models), clamps the output limit
and turns streaming off when the model cannot stream. Provider adapter profiles are chosen per model
inside the binding and are never user choices.

New sessions start on `LABKIT_ACP_MODEL` when set (`<provider>/<model>` or a bare model ID), otherwise
on the first bound provider's default model (anthropic, openai, google, xai, localhost order), with
thinking off and a 32768-token output limit (lower if the model's limit is lower). An unknown
`LABKIT_ACP_MODEL` logs `acp.catalog.default_model_unresolved` and uses that default.
`LABKIT_ACP_TERMINAL=1` enables the client terminal tool.

## Derive UI configuration from committed policy

A selector's `current(policy)` must read the policy in effect; each option supplies a policy
patch. Do not maintain a parallel selected-model or permission-mode variable. Otherwise a failed
append or reload can leave the UI advertising a setting the runtime never accepted.

A configuration request waits for an active prompt to settle, commits its patch, and then returns
updated options. New prompts wait behind that commit. Core rejects unsupported model/settings
combinations. Choices may depend on policy: `options` can be a function of the policy in effect,
resolved and validated each time the adapter reports or applies configuration. If the value in effect is not one of a selector's choices, the adapter adds it as an
extra choice named `<value> (saved)` and logs `acp.session.config.unlisted_value` (info). Choosing
it again changes nothing; choosing another value commits the usual patch.
See [configuration binding details](protocol-reference.md#configuration-bindings).

## Reopen a session after the tool, agent or model registry changes

Your factory may change the tool, agent or model registry between runs. A saved session still opens
and accepts prompts after tools are added, removed or given new parameters, agents change, or the
saved model is no longer served. Reload replays the saved history unchanged. The next prompt,
configuration change or fork first records the live registry in the journal, then runs normally.
Opening alone writes nothing new. On load, `acp.session.registry_pending` (info) lists the
differences.

Saved history is a record of what happened. The next request sends all of it, including calls
to tools that are no longer registered and their results. Only live tools are offered to the model.
If the saved policy names a removed tool or an unavailable model, or the current agent was removed,
core adjusts the policy or agent in the same journal record and logs each adjustment. Selectors show
the adjusted policy from the moment the session opens.

## Publish context usage and cumulative cost

Return an `AcpSessionOptions.usage` binding when your environment can measure the current prompt
context and its effective capacity. `read({ sessionId, cwd, snapshot, model }, signal)` returns
`{ used, size, cost? }`. Include cached tokens in `used`; `cost`, when known, is the cumulative
session amount with an explicit currency such as `{ amount: 0.12, currency: "EUR" }`. It is not a
per-request charge. Return `undefined` when you cannot provide meaningful context usage and size.
The adapter does not infer capacity or prices from model names or add up response tokens as context.

The adapter reads after new/load/resume/fork and committed state changes. An optional
`subscribe(changed, signal)` tells it to read again when external accounting changes; return a
cleanup function if the subscription needs one. Superseded reads receive cancellation, and late
results cannot overwrite newer state or reach a closed session. Read/subscription failures produce
warnings and leave agent execution running. Identical values do not produce duplicate updates.
The source owns measurement and billing persistence; reopening queries it without replaying tools.

`acp.usage.updated` logs the published counts/cost with session, connection, revision and usage-request IDs.
`acp.usage.failed` explains why no replacement was sent. Core's `lastCompletionUsage` is historical
per-response evidence and is not interchangeable with this session-level measurement. The default
workspace launcher does not yet supply a context-measurement/billing source; these controls must
not be described as wired into that launcher until that integration exists.

## Tool failures go back to the model

The workspace harness reports ordinary tool failures as tool results and continues the turn.
A missing file includes its path, underlying error, and a concrete `list_dir` request for discovering
existing paths. `read_file` also accepts `line` and `limit` to read large files in sections;
those parameters are forwarded to editor reads so unsaved content remains authoritative. Invalid arguments return the validator’s field-level errors without execution or a
permission prompt; other calls in the batch finish, and the
model can choose a corrected action. Failed tool cards and original journal outcomes stay failed.
No tool is automatically retried. Permission refusal, cancellation, deadlines, and persistence
failures retain their distinct stopping behavior. Reopening an existing session preserves its
committed policy; changing the factory default does not silently rewrite that policy.

## Keep display, permission, and completion distinct

A pending tool card describes intended work. Only `request_permission` approves a call, and every
call in the batch must be approved before any tool runs. A refusal blocks the batch; a cancelled
dialog aborts the turn. The picker also offers approval of the named tool for all arguments until
the live session closes. Other tools remain unapproved. Each reuse is logged and journaled with its
grant identity; input validation and persistence gates still apply. Closing/reloading a session or
committing a permission reset or tool scope change clears these approvals. Under Tool approvals, select Ask to clear
remembered grants or explicitly allow all enabled tools without asking. The adapter maps the typed core refusal directly to ACP `refusal`.

Stream text is provisional. It can be visible before EOF exposes a malformed response, and a tool
card can show completion before its result is saved. Wait for the prompt response to decide how
the turn ended; use the core terminal outcome/logs for the underlying cause. Completed turns map
to `end_turn`, exhausted steps to `max_turn_requests`, and aborted turns to `cancelled`. Other
execution/storage failures become JSON-RPC error -32000 naming the failed operation (tool name and
call ID when present), classification and cause; after a tool or permission failure the connection
and session accept the next prompt. Explicit provider token limits map to
`max_tokens` and provider refusals to `refusal`; `_meta["labkit.dev/failure"]` retains the typed
operation failure. Neither admits a partial completion or retries the provider. Failed admission and storage settlement expose
the core structured failure in error data, including operation identity and reconciliation causes. A display notification is never a receipt.

Reload renders saved conversation data without rerunning tools or asking for old permissions.
Live terminal handles, stream callbacks, and MCP connections are recreated as needed, not recovered
from the journal. An interrupted write may have taken effect; repeating it needs a new explicit
invocation. See [session recovery](../core/session/README.md#reopen-without-repeating-effects).

## Render tool results without changing execution

`AcpSessionOptions.toolContent` maps tool names to pure display renderers. A renderer receives
`{ toolName, output }`, where `output` is the exact successful tool-result string that core saves
and sends to the model. Return ACP content blocks or file diffs. The adapter validates the complete
result against the installed ACP schema and keeps `rawOutput` available alongside the display.
Images, audio, embedded resources, resource links, annotations and `_meta` remain structured.

Bind a renderer only when you own that tool's output contract. Arbitrary JSON is not automatically
interpreted as MCP content or a diff. Discovered MCP tools receive a renderer automatically, so their
admitted text/resource blocks display directly rather than as serialized envelopes. MCP binary-result
admission remains a separate missing model-content boundary; this display binding does not enable it.

The workspace launcher binds `workspaceToolContent` for `write_file`. Its tool result records
`before` as observed text, confirmed absence, or unavailable with a reason, plus the written text.
Existing local files use an inode-checked read before truncation; exclusive creation establishes a
new file. Editor writes read the editor's buffer when that capability exists, so unsaved changes
appear in the diff. They never substitute disk contents for an unavailable editor baseline.

Baseline reads stay inside the approved write operation. Cancellation or timeout prevents dispatch
of a subsequent write. Other baseline-read failures do not deny an otherwise authorized write;
a successful write then shows why its diff is unavailable. Oversized or non-UTF-8 prior local files
have that explicit outcome. Missing editor reads do not establish that a file is new. These are
pre-write observations, not compare-and-swap protection against concurrent edits.
`workspace.write_evidence.captured` records source and byte counts; `workspace.write_baseline.failed`
retains an actual read failure, and `workspace.write_evidence.unavailable` explains the consequence.
File bodies live in the saved result, not routine diagnostics. Custom workspace factories can bind
`toolContent: workspaceToolContent` using the package export.

Renderers must use only the supplied result: no filesystem reads, network calls, tool execution or
live terminal handles. Reload runs the current renderer over saved successful results and labels
the update `_meta["labkit.dev/reconstructed"] = true`. It never reruns the tool. Preserve renderer
semantics when reopening saved sessions if identical historical presentation matters. Terminal
links remain owned by the client-terminal binding and are never reconstructed from saved IDs.

A malformed or throwing renderer leaves the execution result unchanged. The tool card explicitly
reports the display failure and retains raw output; `acp.tool_content.failed` logs the cause, tool
name and correlated session/tool-call IDs. `acp.tool_content.rendered` records successful block types
and whether the source was live or saved, without logging content bodies.

## Decide which environment owns an effect

| Integration               | Ownership and consequence                                                                                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace file tools      | Local operations enforce workspace checks. With client filesystem capability, reads/writes use editor semantics, including unsaved buffers. Client errors do not fall back to disk.           |
| Client terminal           | Opt in with `LABKIT_ACP_TERMINAL=1`; execution needs client support and permission. Cwd is not an OS sandbox, and cancellation cannot undo command effects.                                   |
| MCP tools                 | The discovered catalog is fixed for an open session and uses core permission/result gates. MCP roots are advisory, not process confinement. Restore reconnects but never repeats saved calls. |
| Attachments               | Image, audio and embedded blocks need their `promptCapabilities` flag. Bytes/local resources are stored before admission as user input, not tool execution; no permission dialog is created.  |
| Plan and progress updates | Display state only. A plan item does not execute itself or become complete because an unrelated tool succeeded.                                                                               |

The workspace example stores journals and blobs in `<cwd>/.labkit/sessions/store.sqlite`. Back it up
while stopped and retain the canonical workspace location: moving the database to another workspace
is rejected. Deleting a session removes its journal/blobs and does not delete independent fork
children. Remote/client resources have their own cleanup rules; consult the
[reference](protocol-reference.md) when adding one of these integrations.

## Architecture

`connectAcp` in [adapter.ts](adapter.ts) is the composition root. It builds one set of services
per connection, registers every handler on the SDK `agent()` app, then connects the stream. The
handlers live in `rpc/`:

| Module                                           | Responsibility                                                                                            |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| [rpc/core.ts](rpc/core.ts)                       | Connection identity and the ordered `session/update` outbox (`send`, `flushed`).                          |
| [rpc/session.ts](rpc/session.ts)                 | The per-session record and configuration/prompt serialization (`afterPrompt`, `awaitConfigurationQuiet`). |
| [rpc/connection.ts](rpc/connection.ts)           | `initialize`, `authenticate`, `logout`, the initialize/auth gate, and -32601 for unadvertised methods.    |
| [rpc/sessions.ts](rpc/sessions.ts)               | The session registry and `session/new`, `load`, `resume`, `fork`, `delete`, `list`, `close`.              |
| [rpc/open.ts](rpc/open.ts)                       | Opening a session: MCP, client resources, runtime creation or restore, replay and publication.            |
| [rpc/permission.ts](rpc/permission.ts)           | Forwarding runtime permission requests as `session/request_permission` and validating the answer.         |
| [rpc/updates.ts](rpc/updates.ts)                 | Projecting runtime snapshots, tool and stream events, and saved history to `session/update`.              |
| [rpc/config.ts](rpc/config.ts)                   | `session/set_config_option`, `session/set_mode`, and config/mode projection.                              |
| [rpc/prompt.ts](rpc/prompt.ts)                   | `session/prompt` and `session/cancel`: turn admission, settlement and stop reasons.                       |
| [rpc/mcp.ts](rpc/mcp.ts)                         | `mcp/message` requests and notifications for ACP-transported MCP servers.                                 |
| [rpc/unknown-methods.ts](rpc/unknown-methods.ts) | Logging `acp.method.unknown` for incoming methods no handler registers.                                   |

Registration order: the -32601 handlers for unadvertised methods come first, so they answer before
params, initialization, auth or session state are checked. Then come connection, MCP bridge, session
lifecycle, configuration and prompt handlers. Each `register*` returns its method names; together
with the SDK's `$/cancel_request` they form the set `rpc/unknown-methods.ts` treats as known.

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
