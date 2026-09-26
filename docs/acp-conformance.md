# ACP implementation completion audit

**Full conformance is not established.** This ledger keeps the requested complete VS Code
integration separate from the subset currently implemented. A passing adapter suite proves only
its exercised cases. It does not prove that the installed editor client exposes a capability,
that a model accepts a configuration, or that the harness can complete real workspace work.

The current protocol target is [ACP v1](https://agentclientprotocol.com/protocol/v1/overview).
[ACP v2 is published as a draft](https://agentclientprotocol.com/announcements/acp-v2-draft).
Protocol drafts and separately negotiated extensions need explicit tracking; they are not silently
counted as either implemented or irrelevant to the requested complete integration.

The repository provides the agent in `packages/acp` and a tracked client fork in
[`packages/vscode`](../packages/vscode/README.md). The installed upstream client ignores tool
content and usage updates; the fork has executable webview tests for these paths. Those DOM tests
do not establish native editor integration. Completion still requires evidence from the complete
editor/agent path. The native UI inspection tool could not start during this audit.

## Evidence and remaining work

“Implemented paths” below means source and automated cases exist, not that every requirement in
that area has passed a complete audit. Every row still needs requirement-level review against the
current schema and editor verification before it can support a full-conformance claim.

| Area                            | Implemented paths and evidence                                                                                                                                                                                         | Remaining work or missing evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initialization and capabilities | `rpc/connection.ts` (initialize response and the -32601 gate share one set of flags); `capabilities.test.ts` drives every advertised and unadvertised capability and validates responses against the SDK 1.5.0 schema. | Verify that the installed editor client uses the advertised set. See the detailed capability audit below.                                                                                                                                                                                                                                                                                                                                                                                         |
| Authentication and logout       | `auth.ts`, `rpc/connection.ts`; `adapter-auth.test.ts`, `adapter-elicitation.test.ts`.                                                                                                                                 | Verify real editor login/logout flows and unsupported-capability explanations. MCP OAuth is missing.                                                                                                                                                                                                                                                                                                                                                                                              |
| Session lifecycle               | `rpc/sessions.ts`, `rpc/open.ts`; new/load/resume/close/list/delete and opt-in fork in `adapter-session-lifecycle.test.ts`; workspace SQLite storage.                                                                  | Verify editor discoverability and restart workflows; audit cancellation/publication races against each lifecycle requirement.                                                                                                                                                                                                                                                                                                                                                                     |
| Prompt lifecycle                | Receipt-gated execution, cancellation, tool-error continuation, typed provider stops, public settlements.                                                                                                              | Audit all terminal mappings, interruption states, and user-visible explanations; scripted recovery does not establish autonomous task success.                                                                                                                                                                                                                                                                                                                                                    |
| Content                         | `prompt-input.ts`: text, images, resources and resource links; blob admission tests.                                                                                                                                   | Google audio input has exact-wire and reload tests. Verify editor playback and review all content variants, annotations and capability combinations.                                                                                                                                                                                                                                                                                                                                              |
| Tool calls and permissions      | Pending/progress/final cards, locations, tool names, terminal links; live-session grants; validation failures returned to model.                                                                                       | Named renderers and MCP text/resource display have live/reload wire tests. Workspace write baselines have local and editor RPC/reload tests. Client permission tests cover all four choices, queued/late cancellation, SDK request cancellation and real stdio settlement. Tool-card DOM tests cover raw values, names, kinds, locations, partial updates and restoration. Verify native permission UI, file navigation and rich content/diffs; support MCP binary results at the model boundary. |
| Client filesystem               | `client-files.ts`, workspace tools and ACP RPC tests.                                                                                                                                                                  | Line-range reads now have local and client RPC tests; client edit/save paths now have tests for dirty buffers, failed saves and concurrent creation; verify these paths in the native editor; actual tool descriptions and recovery paths must match available operations.                                                                                                                                                                                                                        |
| Client terminals                | `client-terminal.ts` and create/output/wait/kill/release tests.                                                                                                                                                        | Client real-process tests cover UTF-8, live output, limits, kill/release, spawn errors, Unix descendants and disconnect cleanup; DOM tests retain released output. Verify native terminal display and Windows process-tree cleanup.                                                                                                                                                                                                                                                               |
| Plans                           | `plan.ts`; `adapter-plans.test.ts`.                                                                                                                                                                                    | Verify full plan replacement and display in the editor.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Configuration and modes         | Committed policy changes, grouped selectors, boolean controls, first-mode alias.                                                                                                                                       | Cross-provider switching is missing in the workspace launcher. Model capabilities must describe the selected deployment rather than an adapter guess.                                                                                                                                                                                                                                                                                                                                             |
| Commands                        | Static discovery, expanded prompt persistence, live catalog replacement and clearing.                                                                                                                                  | Verify editor refresh behavior and audit supported command forms against the schema.                                                                                                                                                                                                                                                                                                                                                                                                              |
| Usage and cost                  | Response accounting survives journal/restore; ACP usage bindings publish context/cost and reject stale reads.                                                                                                          | Bind a real context-measurement/billing source in the workspace launcher and verify the editor indicator. Wire tests use explicit scripted measurements.                                                                                                                                                                                                                                                                                                                                          |
| MCP                             | `mcp.ts`, `mcp-acp.ts`, `mcp-transport.ts`; `mcp-capabilities.test.ts` covers stdio/HTTP/SSE/ACP end to end, reconnect, open failures and tool failures.                                                               | OAuth is out of scope until a row is added. Binary MCP tool results are refused as tool results, not forwarded. Stdio open failures do not include the server's exit code or stderr.                                                                                                                                                                                                                                                                                                              |
| Extensibility                   | SDK dispatch, selected metadata fields and negotiated extensions.                                                                                                                                                      | Audit `_meta` preservation and extension request/notification handling; no blanket claim from SDK dependency alone.                                                                                                                                                                                                                                                                                                                                                                               |
| Transport                       | SDK streams and real stdio launcher tests.                                                                                                                                                                             | ACP HTTP transport is missing. Verify framing, failures and shutdown on each supported transport.                                                                                                                                                                                                                                                                                                                                                                                                 |
| Operational evidence            | Durable rotated ACP logs; `debug:acp`; retained scripted HTTP and failure fixtures.                                                                                                                                    | Verify logs from actual editor launches and useful WARNING/ERROR-only reports for every new failure path.                                                                                                                                                                                                                                                                                                                                                                                         |

## Detailed capability audit

Rules for this matrix:

1. A capability that `initialize` advertises can be exercised by a client. A conditional method that is not
   advertised answers `-32601` before any other check.
2. A capability the agent cannot honor is not advertised. There is no silent fallback.
3. A tool failure is a tool result unless core policy fails the turn. It never kills the
   JSON-RPC connection.
4. Usage, cost and context size are never invented.
5. MCP OAuth and ACP HTTP transport are out of scope until a row is added for them.
6. A row is Implemented only when a test drives the real handler.

"UNSTABLE" means that `@agentclientprotocol/sdk@1.5.0` `schema.json` marks the field as not yet in
the spec. Every initialize response and every tested method response is validated against that
schema (`capabilities.test.ts`, "initialize responses conform to the SDK 1.5.0 InitializeResponse
schema").

### Agent capabilities

| Capability                                  | Advertised when                                                                        | Handler                                                             | Tests (real handler)                                                                                                                                                                                         | Status      |
| ------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| `loadSession`                               | `AcpOptions.loadSession`                                                               | `session/load` → `open()`                                           | `capabilities.test.ts`: unadvertised → -32601 before init, params, auth; launcher list/close/load/resume/fork/delete end to end                                                                              | Implemented |
| `auth.logout`                               | the auth binding supports logout                                                       | `logout`                                                            | `capabilities.test.ts`: unadvertised → -32601; advertised logout clears access, closes live sessions, sessions stay loadable                                                                                 | Implemented |
| `promptCapabilities.image`                  | `AcpOptions.promptCapabilities`; launcher: a bound model accepts `image/*` (Anthropic) | `session/prompt` → `prompt-input.ts`                                | `prompt-capabilities.test.ts`: reaches a model that accepts it; unadvertised refused before storage/journal; current model lacks it → per-model refusal                                                      | Implemented |
| `promptCapabilities.audio`                  | launcher: a bound model accepts `audio/*` (Google)                                     | `session/prompt` → `prompt-input.ts`                                | `prompt-capabilities.test.ts`: same three cases; launcher advertises from its catalog                                                                                                                        | Implemented |
| `promptCapabilities.embeddedContext`        | launcher: a bound model accepts `text/plain` (every catalog provider)                  | `session/prompt` → `prompt-input.ts`                                | `prompt-capabilities.test.ts`: same three cases; `resource_link` needs no capability                                                                                                                         | Implemented |
| `mcpCapabilities.http`                      | always                                                                                 | `mcp-transport.ts` (Streamable HTTP) via `open()`                   | `mcp-capabilities.test.ts`: tools reach the model, result reaches client and next step, load reconnects, failures are tool results, open failure named                                                       | Implemented |
| `mcpCapabilities.sse`                       | always                                                                                 | `mcp-transport.ts` (SSE) via `open()`                               | `mcp-capabilities.test.ts`: same four cases; resume reconnects                                                                                                                                               | Implemented |
| `mcpCapabilities.acp` (UNSTABLE)            | always                                                                                 | `mcp-acp.ts` bridge; `mcp/message` handlers                         | `mcp-capabilities.test.ts`: same four cases through `mcp/connect`/`mcp/message`/`mcp/disconnect`                                                                                                             | Implemented |
| MCP stdio servers (baseline)                | always (no flag)                                                                       | `mcp-transport.ts` (stdio)                                          | `mcp-capabilities.test.ts`: same four cases, catalog failure, binary results refused as a tool result                                                                                                        | Implemented |
| `sessionCapabilities.close`                 | always                                                                                 | `session/close`                                                     | `capabilities.test.ts`: launcher end to end; a later prompt gets -32602 "not open on this connection"                                                                                                        | Implemented |
| `sessionCapabilities.resume`                | `loadSession`                                                                          | `session/resume` → `open()`                                         | `capabilities.test.ts`: -32601 when unadvertised; resume without replay, next prompt carries history                                                                                                         | Implemented |
| `sessionCapabilities.fork` (UNSTABLE)       | `AcpOptions.forkSession`                                                               | `session/fork`                                                      | `capabilities.test.ts`: -32601 when unadvertised; child carries parent turns, list shows both                                                                                                                | Implemented |
| `sessionCapabilities.delete`                | `AcpOptions.deleteSession`                                                             | `session/delete`                                                    | `capabilities.test.ts`: -32601 when unadvertised (before auth); deleted session leaves list, load → -32002 with `sessionId`                                                                                  | Implemented |
| `sessionCapabilities.list`                  | `AcpOptions.listSessions`                                                              | `session/list`                                                      | `capabilities.test.ts`: -32601 when unadvertised (before auth); returns id, cwd, title, updatedAt                                                                                                            | Implemented |
| `sessionCapabilities.additionalDirectories` | `AcpOptions.additionalDirectories`                                                     | `requireRootsAdvertised` in `rpc/open.ts` (open and `session/fork`) | `capabilities.test.ts`: refused with -32602 on new/load/resume/fork when unadvertised; `adapter-session-lifecycle.test.ts` and `adapter-content-attachments.test.ts`: roots reach factory, list and provider | Implemented |

### Client capabilities

The agent calls a client method only when the client advertised it.

| Capability                                         | Used for                                                          | Tests (real handler)                                                                                                                                   | Status      |
| -------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| `clientCapabilities.fs.readTextFile`               | `read_file` reads editor buffers; otherwise workspace files       | `client-capabilities.test.ts`: each fs flag alone; `adapter-client-files.test.ts`: client read and unsupported paths                                   | Implemented |
| `clientCapabilities.fs.writeTextFile`              | `write_file` writes through the editor; otherwise workspace files | `client-capabilities.test.ts`: each fs flag alone; `tool-failure.test.ts`: a failed client write never falls back to disk                              | Implemented |
| `clientCapabilities.terminal`                      | `run_command` (launcher also needs `LABKIT_ACP_TERMINAL=1`)       | `client-capabilities.test.ts`: offered and routed to `terminal/*` only when advertised and enabled                                                     | Implemented |
| `clientCapabilities.session.configOptions.boolean` | boolean selectors such as Stream responses                        | `client-capabilities.test.ts`: options and `config_option_update` reach only advertising clients; `adapter-config-modes.test.ts`: wire-type validation | Implemented |
| `clientCapabilities.elicitation`                   | form/URL elicitation for tools and authentication                 | `client-capabilities.test.ts`: unadvertised modes are absent and `elicitation/create` is never sent; `adapter-elicitation.test.ts`: form and URL use   | Implemented |

### Failure handling and usage

| Requirement                            | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                  | Status          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| Tool failure is a tool result (rule 3) | `tool-failure.test.ts`: 23 non-MCP failure scenarios under both policies. Under return-error-and-continue each failure becomes a failed tool card plus a tool result, and the turn ends with `end_turn`. Under fail-turn the result is -32000 with classification, tool name and callId, and the connection and session keep serving prompts. No unhandled rejections. MCP equivalents are in `mcp-capabilities.test.ts`. | Implemented     |
| Usage, cost and context size (rule 4)  | `prompt-capabilities.test.ts`: the workspace launcher sends no `usage_update` and no usage field. Usage is published only when a host binds `AcpOptions` usage.                                                                                                                                                                                                                                                           | No usage source |

A tool deadline (`toolTimeoutMs`) is a tool result under return-error-and-continue: the model reads
the `timeout` failure on its next step and the turn continues. Core policy still fails the turn on a
client error or malformed answer to `session/request_permission`. That returns a structured -32000,
keeps the connection open, and lets the next prompt proceed.
Binary MCP tool results (image, audio, blob resources) are refused as a failed tool result the model
reads. They are not forwarded.

## Verification gates

Run from the root:

```sh
LOGTAPE_TEST_MODE=always LOGTAPE_TEST_LOWEST_LEVEL=debug bun test packages/core packages/acp
bunx tsc --noEmit
bun run packages/core/session/fixture-runner.ts
bun run packages/core/session/fixture-runner.ts --v2
bun run build:acp
bun run debug:acp
```

The launcher writes `~/.labkit/logs/acp-<pid>-<launcherId>.jsonl`; `bun run logs:acp`
retrieves the latest launch. Persisted tests retain their own unique directories under
`.session-artifacts/`. Those scripted runs must remain labelled as scripted. Their transcripts
cannot be cited as proof that a live model independently recovered or completed a task.

Do not mark the full objective complete until the missing implementation is supplied, this matrix
has been expanded into checked schema requirements, and the actual VS Code integration has been
verified. Optional protocol capabilities are still gaps against the user's request for the entire
integration; optionality is not permission to redefine that request as a smaller implementation.

## Protocol notes

- A conditional method (`session/load`, `session/resume`, `session/fork`, `session/delete`,
  `session/list`, `logout`) that is not advertised returns -32601 with data `{ method, capability }`
  before params, initialization, auth or session state are checked. `acp.method.not_advertised` records it.
- Any other method no handler registers, including SDK-known methods such as `session/set_model` or
  `providers/list`, gets the SDK's default -32601 for a request and is dropped as a notification.
  `rpc/unknown-methods.ts` watches the incoming stream and records each as `acp.method.unknown`
  (`kind`, `rpcRequestId` for requests, `specMethod` when the SDK lists it among v1 agent methods);
  `adapter-initialize-framing.test.ts` covers it.
- A request other than `initialize` sent before `initialize` has answered gets -32600 with
  `data.reason: "not_initialized"` (`requireInitialized` in `rpc/connection.ts`). LSP uses -32002
  ServerNotInitialized and the MCP TypeScript SDK uses -32000; both collide with codes ACP defines
  (-32002 is "resource not found", used for a missing saved session), so this agent uses the
  ACP-defined -32600 Invalid Request and names the reason in `data`.
- Prompt capabilities are fixed per connection at `initialize`. If catalog discovery failed then, the
  client must initialize a new connection to see media support that appears later.

## Evidence

- Schema: `@agentclientprotocol/sdk@1.5.0` `schema/schema.json` (v1; the v2 draft is not targeted).
- Tests: `packages/acp/capabilities.test.ts`, `prompt-capabilities.test.ts`,
  `mcp-capabilities.test.ts`, `tool-failure.test.ts`, `client-capabilities.test.ts`.
- Provider diagnostics: `bun run debug:acp` shows the scripted 400 as
  `Completion HTTP failure (400) [request req-provider-failure-123]`, in the launcher log and in the
  client's -32000 error, with the API key redacted.
