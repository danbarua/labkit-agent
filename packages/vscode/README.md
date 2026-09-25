# VS Code client

This package is the tracked Labkit fork of the MIT-licensed
[ACP Client](https://github.com/formulahendry/vscode-acp), pinned initially to
`e7371659e3ac100db842b419b1361205a193032e`. The upstream copyright and license are
retained in LICENSE. The installed `formulahendry.acp-client` extension is not modified.

A client is part of the execution contract: a correct agent notification is useless if the
editor drops its contents. The inspected upstream client displayed only tool titles/status,
ignored tool content and diffs, and did not handle usage updates. This fork retains its
connection/session/configuration workflows and adds structured tool display, history restoration,
partial-update semantics, usage display and durable local diagnostics. Remote telemetry is removed.
The ACP SDK is pinned to the same version as the agent package.

Run from the repository root:

```sh
bun run build:vscode
bun run package:vscode
bun run test:vscode
bunx tsc --noEmit
```

Packaging produces `packages/vscode/dist/labkit-acp-client.vsix`.

The build produces `packages/vscode/dist/extension.cjs` and its source map. To run the development
extension, launch VS Code with `--extensionDevelopmentPath` pointing to this package. Disable the
upstream ACP Client in that development profile: both use the `acp.*` commands/settings and sidebar
IDs. Configure an agent through `acp.agents` as described in the repository's VS Code integration
guide. No default provider, model or credentials are invented by this client.

Session creation uses `acp.defaultWorkingDirectory` when configured, otherwise the active
editor’s workspace folder or the only open folder. A multi-root workspace requires a folder
selection. With no workspace or explicit setting, connection fails with an explanation; the
extension host’s process directory is never sent as the workspace.

Filesystem requests use the editor's current text, including unsaved changes and its selected
encoding. Writes apply a workspace edit and await saving before acknowledging success. A failed
save leaves the applied edit available for inspection and returns a failure with its path and
phase. If saving changes the requested text (for example, through a formatter), the client reports
that mismatch instead of claiming the exact requested content was saved. Read the file again to
inspect the resulting state; neither failure automatically retries the write. Creating a missing
file refuses to overwrite a file that appeared concurrently.

`vscode.filesystem.started`, `vscode.filesystem.completed`, and `vscode.filesystem.failed` record
the session, path, operation, byte count or failed phase and original cause. File text is excluded
from these lifecycle records. The filesystem tests use an injected editor API: native save,
format-on-save, undo and dirty-buffer behavior still require editor-host verification.

Tool cards retain the reported tool name, kind, locations, raw JSON input/output, metadata and
content. Updates replace only supplied non-null fields; `false`, `0`, and empty strings are real
values, and empty content/location arrays clear those lists. This prevents status-only updates
from erasing the evidence needed to understand a failure. The same projection runs in the host and
webview, and the full card survives webview restoration. A location button opens the absolute path
from the active session's reported locations; a webview message cannot substitute another path.
Location numbers are displayed as reported and opened as 1-based editor lines (zero selects the
first line). Native navigation still needs editor verification.

`vscode.tool.updated` records field changes and content/location counts without copying successful
payloads into lifecycle logs. `vscode.tool.failed` includes the retained title, name, IDs and latest
reported raw output, or explicitly states that none was provided. This output is evidence supplied
by the agent, not a client-inferred explanation of the failure.

Permission prompts are serialized so one request cannot hide another. Cancelling a turn dismisses
its visible and queued prompts and answers later requests from that turn with `cancelled`. A new
explicit prompt resets that cancellation state; concurrent prompts for one session are rejected.
Connection closure also settles pending prompts. The SDK request signal reaches the permission
handler, so `$/cancel_request` dismisses the matching prompt without cancelling unrelated sessions.
All four option kinds return the agent's exact option ID. The agent owns the meaning and retention
of an “always” choice; the client does not invent a broader authorization scope. Configured
`allowAll` cannot override cancellation. Refusal logs identify the tool, choice and consequence;
`vscode.permission.*` events include session, tool-call and available RPC request IDs.

The client uses the current SDK's typed connection/context API. Cancelling a terminal exit wait
returns `-32800` without killing or releasing the command; those are separate terminal operations.
In-process SDK tests and a real scripted stdio exchange exercise these cancellation boundaries.

Terminal commands use the requested executable and literal arguments. To run shell syntax, request
an explicit shell with its arguments. An omitted working directory uses the workspace selected
when connecting the agent. Output is decoded across byte chunks, updated immediately, and retained
up to `outputByteLimit` (default 1 MiB), discarding complete characters from the beginning. A zero
limit retains no output and still reports truncation. The embedded tool card shows live output,
exit status and truncation; its final display survives release and webview restoration.

Closing the editor terminal stops its command. Kill waits for process/output closure and preserves
the terminal ID for output and exit queries.
Release closes process and display resources and invalidates that ID. Connection removal, agent
exit and initialization failure all dispose their terminal handlers. On Unix, termination includes
the process group so child commands cannot keep inherited output pipes open. Windows process-tree
termination and native terminal rendering remain unverified; current Windows termination targets
the direct process. Terminal lifecycle logs use `vscode.terminal.*` with session/terminal IDs,
command, limits and exit/failure details. They exclude output text and redact credentials.

Logs are under this extension's VS Code `globalStorageUri`, in `logs/client.jsonl`; ACP: Show Log
prints the exact path. Each file rotates at 10 MiB with four backups, across restarts. A single
large protocol record can exceed that rotation threshold. DEBUG protocol summaries include request,
session and tool identities; errors retain their causes. `acp.logTraffic` also retains protocol
bodies in that bounded log and the traffic channel. Credential fields and configured secret values
are redacted. Local lifecycle events replace upstream telemetry; no telemetry service is contacted.

The webview tests execute the actual generated script in a DOM implementation. They establish
content/history behavior and injection handling, not native VS Code visual conformance. The native
UI inspection tool currently fails to start. Actual extension-host/editor integration remains to
be verified. The conformance ledger in `docs/acp-conformance.md` remains open: this source import
and the new rendering paths are not proof that all inherited handlers meet the current ACP spec.
