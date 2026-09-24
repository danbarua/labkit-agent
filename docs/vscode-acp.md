# Launch Labkit in VS Code through ACP

Install [ACP Client by formulahendry](https://marketplace.visualstudio.com/items?itemName=formulahendry.acp-client)
and run `bun install` in the Labkit checkout. This uses ACP stdio, not VS Code Agent Host/AHP.
The web console remains the in-repo harness; no Labkit chat extension is required.

ACP Client 0.2.0 uses an **object keyed by agent name** for `acp.agents`
([setting schema](https://github.com/formulahendry/vscode-acp/blob/main/package.json)).
Add this to your VS Code user settings, replacing the absolute checkout paths and model:

```json
{
  "acp.agents": {
    "Labkit": {
      "command": "bun",
      "args": [
        "/ABS/labkit-agent/packages/acp/cli.ts",
        "--config",
        "/ABS/labkit-agent/packages/acp/examples/vscode-workspace.ts"
      ],
      "env": {
        "LABKIT_ACP_MODEL": "YOUR_ANTHROPIC_MODEL_ID"
      }
    }
  },
  "acp.autoApprovePermissions": "ask"
}
```

Use an absolute Bun executable path if the GUI's PATH does not include Bun. Start VS Code from
an environment with `ANTHROPIC_API_KEY` available to its child processes. Do not commit credentials
in workspace settings. Bun also loads environment files from the launched process's working
directory; the adapter never changes that directory. File operations use the absolute cwd from
`session/new`, independently of the process cwd. Leave `acp.defaultWorkingDirectory` unset to use
the opened workspace. Other provider profiles and credentials are listed in the
[ACP README](../packages/acp/README.md#workspace-agent-for-vs-code).

## First conversation

1. Open the Labkit repository as your VS Code workspace.
2. Run **ACP: Open Chat Panel**, then **ACP: Connect to Agent**, and select Labkit.
3. Start a new conversation and ask: “Read packages/acp/README.md using read_file. What does it
   claim is unimplemented?”
4. Check that the permission card identifies a read at the absolute path to that README.
   Allow once. Inspect the tool call and streamed answer, grounded in the file contents.
5. Ask for a small file write and reject its permission: no file should be created or modified.
   Use **ACP: Cancel Current Turn** to interrupt an active turn, including one awaiting permission.

All three file tools require approval. They provide absolute file locations before execution.
File tools check workspace paths. Advertised client filesystem methods enable editor-aware reads
and writes. Command execution is disabled by default.
Client-supplied stdio, HTTP, and SSE MCP servers are connected. Remote servers use supplied
authentication headers; OAuth and ACP-proxied MCP remain unsupported. MCP tool
calls use the same once-only permission picker and journaled results. External servers execute
with their own process access; the workspace file sandbox does not constrain them. Read-only
mode excludes MCP tools. Remembered approvals are not implemented. **ACP: Set Agent Mode** switches between read-only
and edit access; both still require approval. Hosts with configuration-selector support also expose
model and thinking choices. Set `LABKIT_ACP_MODELS` to a comma-separated list of additional model
IDs for the same provider before launch. Configuration changes during a turn wait for settlement,
and replies are sent only after the policy journal commit. The installed client's older model UI
may not expose the newer `session/set_config_option` method; mode selection has the legacy alias.

The example now persists journals and blobs in `.labkit/sessions/store.sqlite` inside the opened
workspace and advertises session loading. Restart the agent to pick up this configuration change;
old memory-only conversations cannot be recovered. Use ACP Client's saved session entry to reopen
a newly persisted conversation. Loading requires the same compatible agent/model/tool configuration
and workspace cwd. **ACP: Refresh Sessions** can now discover saved sessions through `session/list`.
Unfiltered discovery covers the launch cwd and workspaces opened in the current agent process;
a cwd filter can address another workspace directly. The adapter also supports `session/resume`
for hosts that already retain history and do not want replay. Runtime files are ignored by this repo and blocked from the file tools. Other workspaces should
also add `.labkit/` to their `.gitignore`.

For the denial check, ask: “Use write_file to create acp-deny-check.txt containing DENY_CHECK.”
Choose **Reject** in the permission picker. The adapter returns `stopReason: "refusal"`; the file
must remain absent (or unchanged if it already exists). The exact refusal rendering is client-owned.

## Attachments and validation

The adapter accepts local `resource_link` prompt blocks as session attachments, rejecting outside
paths and never fetching HTTP URLs. It also accepts PNG/JPEG images and embedded text or binary
resources supported by the selected provider, storing supplied bytes as session blobs. Embedded
URIs are labels and need not point inside the workspace; they are never read or fetched. Audio
remains unsupported. ACP
Client 0.2.0 lists file attachment UI as not yet functional; local resource ingestion can be exercised
by another ACP host or the adapter tests until that client exposes it. In the installed client,
`Attach File to Prompt` posts a `file-attached` message with no receiving webview handler; it does
not send a `resource_link`. Typing `@file` as plain text does not attach bytes. Do not count a
model-initiated `read_file` call as attachment ingestion.

The protocol form is:

```json
{
  "sessionId": "SESSION_ID",
  "prompt": [
    { "type": "text", "text": "Review the attached design" },
    { "type": "resource_link", "name": "DESIGN.md", "uri": "file:///ABS/workspace/DESIGN.md" }
  ]
}
```

Send this as `session/prompt` from an ACP host that supports resource links. Tests verify that
only refs enter the journal, that stored bytes remain usable after the original file is deleted,
and that idle reload performs no blob reads. Persistence tests include a killed writer with an
uncommitted transaction and independent-reader checks; they do not simulate hardware power loss.

Automated coverage exercises JSON-RPC, workspace boundaries, attachment storage, permissions,
streaming, and cancellation. No live VS Code UI test runs in CI. A user-operated manual check on
2026-09-24 with ACP Client 0.2.0 and `claude-sonnet-5` confirmed the `read_file` permission picker
(allow once / reject), a completed tool call, and a README-grounded answer in VS Code chat.
The supplied screenshots do not establish how absolute file locations render in the client;
those locations were verified in protocol traffic. UI denial and cancellation remain separate
manual checks.

A separate live stdio smoke test passed using the workspace example with Anthropic: the model
requested `read_file` for the absolute README path, received an `allow_once` reply, emitted
pending/in-progress/completed tool updates and streamed a grounded answer, then returned
`end_turn`. This verifies the real provider and protocol path, not the VS Code rendering.

A follow-up live stdio check with `claude-sonnet-5` passed local resource-link ingestion,
process exit/restart plus `session/load` after deleting the source attachment, and rejection of a
`write_file` call. The denied prompt returned `refusal` and created no file. These were protocol
checks; the client attachment UI limitation and manual refusal-rendering check remain separate.

A live configuration check also passed: the host selected read-only mode and an alternate
Anthropic model, completed an attachment prompt, restarted the agent, and received the same
mode/model in `session/load`. Switching back to edit mode then reached the write permission
request, whose rejection still returned `refusal` without creating a file.

Stdio MCP was also verified with a live Anthropic turn and a local fixture server supplied in
`session/new`: the model selected the namespaced echo tool, requested once-only approval, and
returned the actual server result. The server confirmed that the provider API key was absent from
its environment. Automated tests cover refusal before remote invocation, invalid arguments,
reconnect without replaying calls, cancellation, and subprocess cleanup on failed/disconnected opens.

When ACP Client advertises filesystem capabilities, `read_file` uses `fs/read_text_file`
(including unsaved editor text), and `write_file` uses `fs/write_text_file`. Each method falls
back to local files only when its capability is absent. Permission cards still precede access;
client errors do not trigger a second local write. The client controls delegated file resolution
and editor write semantics. Directory listings and resource-link attachment reads remain local.

To enable client terminal commands, add `"LABKIT_ACP_TERMINAL": "1"` to the agent environment.
`run_command` is offered only when the client advertises terminal support, and only in edit mode.
Approval precedes terminal creation. Commands use the workspace cwd but can access resources
outside it; this is not a command sandbox. The client owns process execution. Each operation
releases its terminal, with kill/release on cancellation and no local shell fallback. Commands
have a 120-second limit and 256 KiB of retained output. Live terminals attach to their own tool
cards; final content keeps that reference alongside captured output. Reload shows journaled
output without recreating terminals. Preserve opt-in and client capability when
reloading a session, since they affect the immutable tool manifest.

For multi-step tasks, the workspace agent can call `update_plan` to publish task status to hosts
that render ACP plans. Each update replaces the entire list, including an empty list to clear it.
The tool remains available in read-only mode and uses the existing permission policy. Plans are
display data, not execution instructions or commit receipts. On reload, prior plan tool output is
replayed as history; the plan panel is established by the next plan update.

The agent advertises `/review`, `/explain`, and `/plan` to clients with command pickers. You can
also type them directly, followed by a file, question, or task. Attached context is retained.
These are prompt shortcuts through the same journaled, permission-gated flow; they do not execute
commands or grant file access on their own. Reload preserves the already-expanded prompt history.

The example also advertises experimental `session/fork` for live or saved sessions. A fork waits for
an active turn to finish, inherits committed history/configuration and copied attachment blobs,
and then runs independently. It does not rerun historical tools. Use the same cwd and MCP
bindings. A saved parent is restored privately and released without replaying its history into
the client; supply its original MCP descriptors when applicable. Hosts without a fork UI can call the protocol method directly.
Cancellation after publication is not rollback: a durable branch may remain in session discovery.

`session/delete` is also advertised. It closes active work before deleting the workspace session's
journal, metadata, and blobs in one transaction. A tombstone blocks stale writes to that ID; forked
children remain independent. Saved IDs can be deleted within the launch workspace or workspaces
already opened/discovered by this agent process. Unknown IDs are no-ops, with no new store created.
Cancellation after dispatch is not rollback, and the session stays unavailable while deletion is
unsettled. SQLite row deletion does not securely erase underlying disk pages.

Session titles and activity timestamps also arrive as ACP `session_info_update` notifications
after committed changes. They match session-list metadata; the title comes from the first
committed user text. Metadata failures do not interrupt chat, and stale async replies are ignored.
