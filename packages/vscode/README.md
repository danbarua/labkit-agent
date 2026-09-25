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
