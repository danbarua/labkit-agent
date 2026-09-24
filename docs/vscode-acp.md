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
Only workspace files are accessible; there is no shell or client filesystem/terminal delegation.
Client MCP servers remain rejected. Remembered approvals and model/mode controls are not implemented.

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
paths and never fetching HTTP URLs. Direct image/audio/embedded blocks remain unsupported. ACP
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
