# ACP implementation completion audit

**Full conformance is not established.** This ledger keeps the requested complete VS Code
integration separate from the subset currently implemented. A passing adapter suite proves only
its exercised cases. It does not prove that the installed editor client exposes a capability,
that a model accepts a configuration, or that the harness can complete real workspace work.

The current protocol target is [ACP v1](https://agentclientprotocol.com/protocol/v1/overview).
[ACP v2 is published as a draft](https://agentclientprotocol.com/announcements/acp-v2-draft).
Protocol drafts and separately negotiated extensions need explicit tracking; they are not silently
counted as either implemented or irrelevant to the requested complete integration.

The repository provides the agent side in `packages/acp`. VS Code's installed ACP client is an
external component. Completion requires evidence from the complete editor/agent path, not merely
a claim that the agent sends valid JSON. No repository-owned VS Code extension has been verified.

## Evidence and remaining work

“Implemented paths” below means source and automated cases exist, not that every requirement in
that area has passed a complete audit. Every row still needs requirement-level review against the
current schema and editor verification before it can support a full-conformance claim.

| Area                            | Implemented paths and evidence                                                                                                   | Remaining work or missing evidence                                                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initialization and capabilities | `adapter.ts`, `adapter.test.ts`: version negotiation and capability-gated handlers.                                              | Audit every advertised capability against executable behavior and current v1 schema.                                                                     |
| Authentication and logout       | `auth.ts`, adapter authentication tests, client elicitation.                                                                     | Verify real editor login/logout flows and unsupported-capability explanations. MCP OAuth is missing.                                                     |
| Session lifecycle               | New/load/resume/close/list/delete and opt-in fork in adapter tests; workspace SQLite storage.                                    | Verify editor discoverability and restart workflows; audit cancellation/publication races against each lifecycle requirement.                            |
| Prompt lifecycle                | Receipt-gated execution, cancellation, tool-error continuation, typed provider stops, public settlements.                        | Audit all terminal mappings, interruption states, and user-visible explanations; scripted recovery does not establish autonomous task success.           |
| Content                         | `prompt-input.ts`: text, images, resources and resource links; blob admission tests.                                             | Audio is missing. Review all content variants, annotations and capability combinations.                                                                  |
| Tool calls and permissions      | Pending/progress/final cards, locations, tool names, terminal links; live-session grants; validation failures returned to model. | Review rich tool content, diff presentation and every permission option. Verify editor approval scope and reload behavior.                               |
| Client filesystem               | `client-files.ts`, workspace tools and ACP RPC tests.                                                                            | Review full read parameters and editor unsaved-buffer behavior; actual tool descriptions and recovery paths must match available operations.             |
| Client terminals                | `client-terminal.ts` and create/output/wait/kill/release tests.                                                                  | Verify actual editor terminal display, exit/truncation status and cleanup under cancellation.                                                            |
| Plans                           | `plan.ts` and adapter update tests.                                                                                              | Verify full plan replacement and display in the editor.                                                                                                  |
| Configuration and modes         | Committed policy changes, grouped selectors, boolean controls, first-mode alias.                                                 | Cross-provider switching is missing in the workspace launcher. Model capabilities must describe the selected deployment rather than an adapter guess.    |
| Commands                        | Static discovery, expanded prompt persistence, live catalog replacement and clearing.                                            | Verify editor refresh behavior and audit supported command forms against the schema.                                                                     |
| Usage and cost                  | Provider usage appears in transport diagnostics.                                                                                 | ACP `usage_update` is missing: real context capacity and cumulative session cost require a public source. Do not fabricate either from arbitrary deltas. |
| MCP                             | `mcp.ts`, `mcp-acp.ts`: stdio/HTTP/SSE/ACP transports, tool discovery and execution.                                             | OAuth is missing; audit metadata, capability negotiation and error paths against the supported MCP contract.                                             |
| Extensibility                   | SDK dispatch, selected metadata fields and negotiated extensions.                                                                | Audit `_meta` preservation and extension request/notification handling; no blanket claim from SDK dependency alone.                                      |
| Transport                       | SDK streams and real stdio launcher tests.                                                                                       | ACP HTTP transport is missing. Verify framing, failures and shutdown on each supported transport.                                                        |
| Operational evidence            | Durable rotated ACP logs; `debug:acp`; retained scripted HTTP and failure fixtures.                                              | Verify logs from actual editor launches and useful WARNING/ERROR-only reports for every new failure path.                                                |

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
