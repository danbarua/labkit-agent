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

## Status

Every row below has one status:

- **Done**: implemented, with an automated test that drives the real handler.
- **Not done**: a known gap.
- **Not doing**: out of scope by decision. Bringing it in scope needs a new row here.

Adapter tests prove what the agent does on the wire. They do not prove that the installed editor
exposes it, so editor verification is listed as its own gap wherever it is still missing.

### Work items

| ID  | Area                 | Item                                                                                                                                       | Status    |
| --- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| G1  | Initialization       | The installed VS Code client uses the advertised capability set                                                                            | Not done  |
| G2  | Authentication       | Real editor login and logout flows, and explanations for unsupported capabilities                                                          | Not done  |
| G3  | Authentication       | MCP OAuth                                                                                                                                  | Not doing |
| G4  | Session lifecycle    | Session discovery and restart workflows in the editor                                                                                      | Not done  |
| G5  | Session lifecycle    | Audit cancellation and publication races against each lifecycle requirement                                                                | Not done  |
| G6  | Prompt lifecycle     | Audit terminal mappings, interruption states and user-visible explanations                                                                 | Not done  |
| G7  | Prompt lifecycle     | Evidence that a live model recovers and completes workspace work (scripted runs do not count)                                              | Not done  |
| G8  | Content              | Audio playback in the editor; review all content variants, annotations and capability combinations                                         | Not done  |
| G9  | Tool calls           | Native permission UI, file navigation, rich content and diffs in the editor                                                                | Not done  |
| G10 | MCP                  | Binary MCP tool results (image, audio, blob resources) reach a capable model or render as a pointer on a target that cannot read the media | Not done  |
| G11 | MCP                  | Stdio open failures report the server's exit code and stderr                                                                               | Not done  |
| G12 | Client filesystem    | Client read, edit and save paths in the native editor                                                                                      | Not done  |
| G13 | Client filesystem    | Tool descriptions and recovery paths match the operations actually available                                                               | Not done  |
| G14 | Client terminals     | Terminal display in the native editor                                                                                                      | Not done  |
| G15 | Client terminals     | Process-tree cleanup on Windows                                                                                                            | Not done  |
| G16 | Plans                | Full plan replacement and display in the editor                                                                                            | Not done  |
| G17 | Configuration        | Switching providers through `session/set_config_option` in the workspace launcher                                                          | Done      |
| G18 | Configuration        | Model capabilities (thinking choices, output limits, prompt media) describe the selected catalog model, not an adapter guess               | Done      |
| G19 | Commands             | Command refresh in the editor; audit supported command forms against the schema                                                            | Not done  |
| G20 | Usage and cost       | A real context-measurement or billing source in the workspace launcher, and the editor's usage indicator                                   | Not done  |
| G21 | Extensibility        | Audit `_meta` preservation and extension request and notification handling                                                                 | Not done  |
| G22 | Transport            | ACP HTTP transport                                                                                                                         | Not doing |
| G23 | Transport            | Framing, failures and shutdown verified on each supported transport (stdio; HTTP is G22)                                                   | Done      |
| G24 | Operational evidence | Logs from real editor launches; a WARNING/ERROR-only scan explains every new failure path                                                  | Not done  |
| G25 | Protocol errors      | A tool deadline (`toolTimeoutMs`) is a tool result under return-error-and-continue                                                         | Done      |
| G26 | Protocol errors      | Requests before `initialize` get -32600 with `data.reason: "not_initialized"`                                                              | Done      |
| G27 | Protocol errors      | Unknown methods are logged as `acp.method.unknown`                                                                                         | Done      |
| G28 | Audit                | This matrix expanded into checked, requirement-level schema rows                                                                           | Not done  |

Evidence for the Done rows:

- G17, G18: `adapter-config-modes.test.ts`, "set_config_option switches the workspace launcher
  between providers…". Through the ACP handler it moves one session Anthropic → OpenAI →
  Anthropic and checks each next provider request (host, model, thinking or reasoning effort,
  output limit), that OpenAI offers effort levels instead of adaptive thinking, that an image
  prompt is refused before any request while the OpenAI model is selected and reaches Anthropic
  after switching back, and that `acp.config.committed` records the change with `connectionId`.
  `workspace-catalog.test.ts` covers the per-model choices in more depth at session level.
- G23: `stdio.test.ts` (a frame split across writes, a malformed line answered with -32700 while
  the connection keeps serving, exit 0 on EOF with stdout reserved for protocol traffic);
  `disconnect-reload.test.ts` (stdin closed or SIGKILL mid-stream or mid-tool, then reload in a new
  launcher); `launcher-logging.test.ts` (startup failures persisted with keys redacted).
- G25: `tool-failure.test.ts` (the `timeout` scenario).
- G26, G27: `adapter-initialize-framing.test.ts` and the protocol notes below.

### Evidence by area

| Area                            | Implemented paths and evidence                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initialization and capabilities | `rpc/connection.ts` (initialize response and the -32601 gate share one set of flags); `capabilities.test.ts` drives every advertised and unadvertised capability and validates responses against the SDK 1.5.0 schema. See the detailed capability audit below.                                                                                                                                                                               |
| Authentication and logout       | `auth.ts`, `rpc/connection.ts`; `adapter-auth.test.ts`, `adapter-elicitation.test.ts`.                                                                                                                                                                                                                                                                                                                                                        |
| Session lifecycle               | `rpc/sessions.ts`, `rpc/open.ts`; new/load/resume/close/list/delete and opt-in fork in `adapter-session-lifecycle.test.ts`; cancelled configuration and fork requests in `adapter-config-modes.test.ts`; workspace SQLite storage.                                                                                                                                                                                                            |
| Prompt lifecycle                | Receipt-gated execution, cancellation, tool-error continuation, typed provider stops, public settlements.                                                                                                                                                                                                                                                                                                                                     |
| Content                         | `prompt-input.ts`: text, images, resources and resource links; blob admission tests; Google audio input has exact-wire and reload tests.                                                                                                                                                                                                                                                                                                      |
| Tool calls and permissions      | Pending/progress/final cards, locations, tool names, terminal links; live-session grants; validation failures returned to the model. Named renderers and MCP text/resource display have live/reload wire tests. Client permission tests cover all four choices, queued/late cancellation, SDK request cancellation and real stdio settlement. Tool-card DOM tests cover raw values, names, kinds, locations, partial updates and restoration. |
| Client filesystem               | `client-files.ts`, workspace tools and ACP RPC tests; line-range reads have local and client RPC tests; client edit/save paths have tests for dirty buffers, failed saves and concurrent creation; workspace write baselines have local and editor RPC/reload tests.                                                                                                                                                                          |
| Client terminals                | `client-terminal.ts`; create/output/wait/kill/release tests; real-process tests cover UTF-8, live output, limits, kill/release, spawn errors, Unix descendants and disconnect cleanup; DOM tests retain released output.                                                                                                                                                                                                                      |
| Plans                           | `plan.ts`; `adapter-plans.test.ts`.                                                                                                                                                                                                                                                                                                                                                                                                           |
| Configuration and modes         | Committed policy changes, grouped selectors, boolean controls, first-mode alias; `workspace-catalog.test.ts` for catalog-driven model, thinking and output-limit choices; `adapter-config-modes.test.ts` for provider switching through `session/set_config_option`.                                                                                                                                                                          |
| Commands                        | Static discovery, expanded prompt persistence, live catalog replacement and clearing.                                                                                                                                                                                                                                                                                                                                                         |
| Usage and cost                  | Response accounting survives journal/restore; ACP usage bindings publish context/cost and reject stale reads. Wire tests use explicit scripted measurements.                                                                                                                                                                                                                                                                                  |
| MCP                             | `mcp.ts`, `mcp-acp.ts`, `mcp-transport.ts`; `mcp-capabilities.test.ts` covers stdio/HTTP/SSE/ACP end to end, reconnect, open failures and tool failures.                                                                                                                                                                                                                                                                                      |
| Extensibility                   | SDK dispatch, selected metadata fields and negotiated extensions.                                                                                                                                                                                                                                                                                                                                                                             |
| Transport                       | SDK streams; real stdio launcher tests for framing, parse errors, EOF shutdown, disconnect and SIGKILL recovery, and startup failures.                                                                                                                                                                                                                                                                                                        |
| Operational evidence            | Durable rotated ACP logs; `debug:acp`; retained scripted HTTP and failure fixtures.                                                                                                                                                                                                                                                                                                                                                           |

## Detailed capability audit

Rules for this matrix:

1. A capability that `initialize` advertises can be exercised by a client. A conditional method that is not
   advertised answers `-32601` before any other check.
2. A capability the agent cannot honor is not advertised. There is no silent fallback.
3. A tool failure is a tool result unless core policy fails the turn. It never kills the
   JSON-RPC connection.
4. Usage, cost and context size are never invented.
5. MCP OAuth and ACP HTTP transport are Not doing until a row is added for them (G3, G22).
6. A row is Done only when a test drives the real handler. Done here covers the agent's wire
   behaviour; editor verification is tracked separately under Work items.

"UNSTABLE" means that `@agentclientprotocol/sdk@1.5.0` `schema.json` marks the field as not yet in
the spec. Every initialize response and every tested method response is validated against that
schema (`capabilities.test.ts`, "initialize responses conform to the SDK 1.5.0 InitializeResponse
schema").

### Agent capabilities

| Capability                                  | Advertised when                                                                        | Handler                                                             | Tests (real handler)                                                                                                                                                                                         | Status |
| ------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| `loadSession`                               | `AcpOptions.loadSession`                                                               | `session/load` → `open()`                                           | `capabilities.test.ts`: unadvertised → -32601 before init, params, auth; launcher list/close/load/resume/fork/delete end to end                                                                              | Done   |
| `auth.logout`                               | the auth binding supports logout                                                       | `logout`                                                            | `capabilities.test.ts`: unadvertised → -32601; advertised logout clears access, closes live sessions, sessions stay loadable                                                                                 | Done   |
| `promptCapabilities.image`                  | `AcpOptions.promptCapabilities`; launcher: a bound model accepts `image/*` (Anthropic) | `session/prompt` → `prompt-input.ts`                                | `prompt-capabilities.test.ts`: reaches a model that accepts it; unadvertised refused before storage/journal; current model lacks it → per-model refusal                                                      | Done   |
| `promptCapabilities.audio`                  | launcher: a bound model accepts `audio/*` (Google)                                     | `session/prompt` → `prompt-input.ts`                                | `prompt-capabilities.test.ts`: same three cases; launcher advertises from its catalog                                                                                                                        | Done   |
| `promptCapabilities.embeddedContext`        | launcher: a bound model accepts `text/plain` (every catalog provider)                  | `session/prompt` → `prompt-input.ts`                                | `prompt-capabilities.test.ts`: same three cases; `resource_link` needs no capability                                                                                                                         | Done   |
| `mcpCapabilities.http`                      | always                                                                                 | `mcp-transport.ts` (Streamable HTTP) via `open()`                   | `mcp-capabilities.test.ts`: tools reach the model, result reaches client and next step, load reconnects, failures are tool results, open failure named                                                       | Done   |
| `mcpCapabilities.sse`                       | always                                                                                 | `mcp-transport.ts` (SSE) via `open()`                               | `mcp-capabilities.test.ts`: same four cases; resume reconnects                                                                                                                                               | Done   |
| `mcpCapabilities.acp` (UNSTABLE)            | always                                                                                 | `mcp-acp.ts` bridge; `mcp/message` handlers                         | `mcp-capabilities.test.ts`: same four cases through `mcp/connect`/`mcp/message`/`mcp/disconnect`                                                                                                             | Done   |
| MCP stdio servers (baseline)                | always (no flag)                                                                       | `mcp-transport.ts` (stdio)                                          | `mcp-capabilities.test.ts`: same four cases, catalog failure, binary results stored as blob parts and rendered in `tool_call_update` (G10, partial: see below)                                               | Done   |
| `sessionCapabilities.close`                 | always                                                                                 | `session/close`                                                     | `capabilities.test.ts`: launcher end to end; a later prompt gets -32602 "not open on this connection"                                                                                                        | Done   |
| `sessionCapabilities.resume`                | `loadSession`                                                                          | `session/resume` → `open()`                                         | `capabilities.test.ts`: -32601 when unadvertised; resume without replay, next prompt carries history                                                                                                         | Done   |
| `sessionCapabilities.fork` (UNSTABLE)       | `AcpOptions.forkSession`                                                               | `session/fork`                                                      | `capabilities.test.ts`: -32601 when unadvertised; child carries parent turns, list shows both                                                                                                                | Done   |
| `sessionCapabilities.delete`                | `AcpOptions.deleteSession`                                                             | `session/delete`                                                    | `capabilities.test.ts`: -32601 when unadvertised (before auth); deleted session leaves list, load → -32002 with `sessionId`                                                                                  | Done   |
| `sessionCapabilities.list`                  | `AcpOptions.listSessions`                                                              | `session/list`                                                      | `capabilities.test.ts`: -32601 when unadvertised (before auth); returns id, cwd, title, updatedAt                                                                                                            | Done   |
| `sessionCapabilities.additionalDirectories` | `AcpOptions.additionalDirectories`                                                     | `requireRootsAdvertised` in `rpc/open.ts` (open and `session/fork`) | `capabilities.test.ts`: refused with -32602 on new/load/resume/fork when unadvertised; `adapter-session-lifecycle.test.ts` and `adapter-content-attachments.test.ts`: roots reach factory, list and provider | Done   |

### Client capabilities

The agent calls a client method only when the client advertised it.

| Capability                                         | Used for                                                          | Tests (real handler)                                                                                                                                   | Status |
| -------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| `clientCapabilities.fs.readTextFile`               | `read_file` reads editor buffers; otherwise workspace files       | `client-capabilities.test.ts`: each fs flag alone; `adapter-client-files.test.ts`: client read and unsupported paths                                   | Done   |
| `clientCapabilities.fs.writeTextFile`              | `write_file` writes through the editor; otherwise workspace files | `client-capabilities.test.ts`: each fs flag alone; `tool-failure.test.ts`: a failed client write never falls back to disk                              | Done   |
| `clientCapabilities.terminal`                      | `run_command` (launcher also needs `LABKIT_ACP_TERMINAL=1`)       | `client-capabilities.test.ts`: offered and routed to `terminal/*` only when advertised and enabled                                                     | Done   |
| `clientCapabilities.session.configOptions.boolean` | boolean selectors such as Stream responses                        | `client-capabilities.test.ts`: options and `config_option_update` reach only advertising clients; `adapter-config-modes.test.ts`: wire-type validation | Done   |
| `clientCapabilities.elicitation`                   | form/URL elicitation for tools and authentication                 | `client-capabilities.test.ts`: unadvertised modes are absent and `elicitation/create` is never sent; `adapter-elicitation.test.ts`: form and URL use   | Done   |

### Failure handling and usage

| Requirement                                              | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                  | Status |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Tool failure is a tool result (rule 3)                   | `tool-failure.test.ts`: 23 non-MCP failure scenarios under both policies. Under return-error-and-continue each failure becomes a failed tool card plus a tool result, and the turn ends with `end_turn`. Under fail-turn the result is -32000 with classification, tool name and callId, and the connection and session keep serving prompts. No unhandled rejections. MCP equivalents are in `mcp-capabilities.test.ts`. | Done   |
| Usage, cost and context size are never invented (rule 4) | `prompt-capabilities.test.ts`: the workspace launcher sends no `usage_update` and no usage field. Usage is published only when a host binds `AcpOptions` usage. A real usage source is G20.                                                                                                                                                                                                                               | Done   |

A tool deadline (`toolTimeoutMs`) is a tool result under return-error-and-continue: the model reads
the `timeout` failure on its next step and the turn continues. Core policy still fails the turn on a
client error or malformed answer to `session/request_permission`. That returns a structured -32000,
keeps the connection open, and lets the next prompt proceed.
Binary MCP tool results (image, audio, blob resources) are stored as blobs and forwarded as tool
result parts (`mcp.ts`), rendered as a `resource_link` (`blob://<sha256>.<ext>`) in
`tool_call_update` content (`rpc/updates.ts`) and, on a media-capable provider binding, carried
natively in the next request (Anthropic `tool_result` image/document blocks, Google
`functionResponse` sibling `inlineData`): `mcp.test.ts`, `mcp-capabilities.test.ts` ("D4: a
media-capable Anthropic request carries an MCP-returned image in tool_result content"),
`attachments.test.ts`. Not done: a target whose bound provider cannot read the media still fails
the whole turn at the pre-existing whole-history media gate (`session/blobs.ts`), which refuses
before any pointer can render; that gate is core/projection's to remove (G10).

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

Do not mark the full objective complete while any row under Work items is Not done. Optional
protocol capabilities are still gaps against the user's request for the entire integration;
optionality is not permission to redefine that request as a smaller implementation.

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
