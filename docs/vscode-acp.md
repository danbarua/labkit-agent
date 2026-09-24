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

This example uses **process-local memory journals and blobs** and warns on stderr. It does not
advertise session loading. Restart loses conversations. Durable file persistence is a later step;
there is no restart-recovery claim in this launch example.

## Attachments and validation

The adapter accepts local `resource_link` prompt blocks as session attachments, rejecting outside
paths and never fetching HTTP URLs. Direct image/audio/embedded blocks remain unsupported. ACP
Client 0.2.0 lists file attachment UI as not yet functional; local resource ingestion can be exercised
by another ACP host or the adapter tests until that client exposes it.

Automated coverage exercises JSON-RPC, workspace boundaries, attachment storage, permissions,
streaming, and cancellation. No live VS Code UI test runs in CI. ACP Client 0.2.0 was installed for
local validation, but this environment's computer-use configuration and macOS automation access
prevented the visible UI pass. The steps above remain the manual acceptance check; a stdio test
alone does not establish that the client's permission card and file locations render correctly.

A separate live stdio smoke test passed using the workspace example with Anthropic: the model
requested `read_file` for the absolute README path, received an `allow_once` reply, emitted
pending/in-progress/completed tool updates and streamed a grounded answer, then returned
`end_turn`. This verifies the real provider and protocol path, not the VS Code rendering.
