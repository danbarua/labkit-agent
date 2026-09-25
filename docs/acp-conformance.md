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

| Area                            | Implemented paths and evidence                                                                                                   | Remaining work or missing evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initialization and capabilities | `adapter.ts`, `adapter.test.ts`: version negotiation and capability-gated handlers.                                              | Audit every advertised capability against executable behavior and current v1 schema.                                                                                                                                                                                                                                                                                                                                                                                                              |
| Authentication and logout       | `auth.ts`, adapter authentication tests, client elicitation.                                                                     | Verify real editor login/logout flows and unsupported-capability explanations. MCP OAuth is missing.                                                                                                                                                                                                                                                                                                                                                                                              |
| Session lifecycle               | New/load/resume/close/list/delete and opt-in fork in adapter tests; workspace SQLite storage.                                    | Verify editor discoverability and restart workflows; audit cancellation/publication races against each lifecycle requirement.                                                                                                                                                                                                                                                                                                                                                                     |
| Prompt lifecycle                | Receipt-gated execution, cancellation, tool-error continuation, typed provider stops, public settlements.                        | Audit all terminal mappings, interruption states, and user-visible explanations; scripted recovery does not establish autonomous task success.                                                                                                                                                                                                                                                                                                                                                    |
| Content                         | `prompt-input.ts`: text, images, resources and resource links; blob admission tests.                                             | Google audio input has exact-wire and reload tests. Verify editor playback and review all content variants, annotations and capability combinations.                                                                                                                                                                                                                                                                                                                                              |
| Tool calls and permissions      | Pending/progress/final cards, locations, tool names, terminal links; live-session grants; validation failures returned to model. | Named renderers and MCP text/resource display have live/reload wire tests. Workspace write baselines have local and editor RPC/reload tests. Client permission tests cover all four choices, queued/late cancellation, SDK request cancellation and real stdio settlement. Tool-card DOM tests cover raw values, names, kinds, locations, partial updates and restoration. Verify native permission UI, file navigation and rich content/diffs; support MCP binary results at the model boundary. |
| Client filesystem               | `client-files.ts`, workspace tools and ACP RPC tests.                                                                            | Line-range reads now have local and client RPC tests; client edit/save paths now have tests for dirty buffers, failed saves and concurrent creation; verify these paths in the native editor; actual tool descriptions and recovery paths must match available operations.                                                                                                                                                                                                                        |
| Client terminals                | `client-terminal.ts` and create/output/wait/kill/release tests.                                                                  | Client real-process tests cover UTF-8, live output, limits, kill/release, spawn errors, Unix descendants and disconnect cleanup; DOM tests retain released output. Verify native terminal display and Windows process-tree cleanup.                                                                                                                                                                                                                                                               |
| Plans                           | `plan.ts` and adapter update tests.                                                                                              | Verify full plan replacement and display in the editor.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Configuration and modes         | Committed policy changes, grouped selectors, boolean controls, first-mode alias.                                                 | Cross-provider switching is missing in the workspace launcher. Model capabilities must describe the selected deployment rather than an adapter guess.                                                                                                                                                                                                                                                                                                                                             |
| Commands                        | Static discovery, expanded prompt persistence, live catalog replacement and clearing.                                            | Verify editor refresh behavior and audit supported command forms against the schema.                                                                                                                                                                                                                                                                                                                                                                                                              |
| Usage and cost                  | Response accounting survives journal/restore; ACP usage bindings publish context/cost and reject stale reads.                    | Bind a real context-measurement/billing source in the workspace launcher and verify the editor indicator. Wire tests use explicit scripted measurements.                                                                                                                                                                                                                                                                                                                                          |
| MCP                             | `mcp.ts`, `mcp-acp.ts`: stdio/HTTP/SSE/ACP transports, tool discovery and execution.                                             | OAuth is missing; audit metadata, capability negotiation and error paths against the supported MCP contract.                                                                                                                                                                                                                                                                                                                                                                                      |
| Extensibility                   | SDK dispatch, selected metadata fields and negotiated extensions.                                                                | Audit `_meta` preservation and extension request/notification handling; no blanket claim from SDK dependency alone.                                                                                                                                                                                                                                                                                                                                                                               |
| Transport                       | SDK streams and real stdio launcher tests.                                                                                       | ACP HTTP transport is missing. Verify framing, failures and shutdown on each supported transport.                                                                                                                                                                                                                                                                                                                                                                                                 |
| Operational evidence            | Durable rotated ACP logs; `debug:acp`; retained scripted HTTP and failure fixtures.                                              | Verify logs from actual editor launches and useful WARNING/ERROR-only reports for every new failure path.                                                                                                                                                                                                                                                                                                                                                                                         |

## Detailed capability audit

### Agent Capabilities

| Capability                                  | Advertised  | Handler                          | Schema Compliant | Test Coverage          | Status      |
| ------------------------------------------- | ----------- | -------------------------------- | ---------------- | ---------------------- | ----------- |
| `loadSession`                               | Conditional | `session/load` (1110-1114)       | Pending          | Pending                | Pending     |
| `auth.logout`                               | Conditional | `logout` (1099-1103)             | Yes              | Pending                | Pending     |
| `promptCapabilities.image`                  | Always true | `promptInput` (48-60)            | Yes              | Pending                | Pending     |
| `promptCapabilities.audio`                  | Always true | `promptInput` (48-60)            | Yes              | Pending                | Pending     |
| `promptCapabilities.embeddedContext`        | Always true | `promptInput` (48-60)            | Yes              | Pending                | Pending     |
| `mcpCapabilities.http`                      | Always true | `mcpTransport` (74-84)           | Yes              | Pending                | Pending     |
| `mcpCapabilities.sse`                       | Always true | `mcpTransport` (85)              | Yes              | Pending                | Pending     |
| `mcpCapabilities.acp`                       | Always true | `mcpTransport` (45-47)           | Yes (UNSTABLE)   | Pending                | Pending     |
| `sessionCapabilities.close`                 | Always      | `session/close` (1484-1498)      | Yes              | Yes                    | Implemented |
| `sessionCapabilities.resume`                | Conditional | `session/resume` (1115-1124)     | Yes              | Yes                    | Implemented |
| `sessionCapabilities.fork`                  | Conditional | `session/fork` (1125-1238)       | Yes              | Pending                | Pending     |
| `sessionCapabilities.delete`                | Conditional | `session/delete` (1239-1302)     | Yes              | Pending                | Pending     |
| `sessionCapabilities.additionalDirectories` | Conditional | Integrated into session handlers | Yes              | Yes (param validation) | Implemented |
| `sessionCapabilities.list`                  | Conditional | `session/list` (1303-1331)       | Yes              | Yes                    | Implemented |

### Client Capabilities

| Capability                                         | Advertised | Handler                          | Schema Compliant | Test Coverage | Status  |
| -------------------------------------------------- | ---------- | -------------------------------- | ---------------- | ------------- | ------- |
| `clientCapabilities.fs.readTextFile`               | Negotiated | `client-files.ts:27-31`          | Pending          | Pending       | Pending |
| `clientCapabilities.fs.writeTextFile`              | Negotiated | `client-files.ts:27-31`          | Pending          | Pending       | Pending |
| `clientCapabilities.terminal`                      | Negotiated | `client-terminal.ts`             | Pending          | Pending       | Pending |
| `clientCapabilities.session.configOptions.boolean` | Negotiated | `setConfig` (1332-1341)          | Pending          | Pending       | Pending |
| `clientCapabilities.elicitation`                   | Negotiated | `requestElicitation` (1065-1071) | Pending          | Pending       | Pending |

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

## Notes

- The adapter advertises capabilities conditionally based on runtime options (`loadSession`, `forkSession`, `deleteSession`, `listSessions`, `additionalDirectories`, `auth.logoutSupported`).
- All capability-gated handlers throw `RequestError.methodNotFound(-32601)` when the capability is not advertised.
- Tests exist for `session/list` and `session/resume` gating; other gated handlers need explicit `-32601` tests.
- `mcpCapabilities.acp` is defined in the SDK schema as UNSTABLE (line 2749 in schema.json).
- `auth.logout` handler exists, but the logout gating test (adapter.test.ts:3701, 3792) exercises success, not -32601 when `logoutSupported` is false.

## Evidence links

- **Schema source**: `@agentclientprotocol/sdk@1.5.0` (v1 schema, not v2 draft)
- **Advertised set**: `adapter.ts:1046-1059` (14 capabilities total)
- **Handler mappings**: `adapter.ts:1062-1498`, `prompt-input.ts:48-60`, `mcp-transport.ts:45-85`
- **Test coverage**: `adapter.test.ts:1052-1108` (list/resume gating), `2548-2560` (fork), `2923-2940` (delete), `3159-3175` (additionalDirectories), `1250-1270` (load)
- **Verification**: `bun test packages/acp/adapter.test.ts -t "capability"` (2 pass, 0 fail)

## Gating order inconsistency

`session/list` (adapter.ts:1304-1305) calls `requireAccess()` before the methodNotFound check, while `session/fork` (1126-1127) and `session/resume` (1116) check methodNotFound first. An unauthenticated client therefore gets -32002 for an unsupported list but -32601 for unsupported fork.
