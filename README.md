<img src="packages/web/brand/logo.svg" alt="Labkit Agent" width="280" />

# Labkit Agent

Labkit Agent is an experimental runtime for computational-science agents. Its unusual
part is that a running session's behavior is explicit, versioned policy: the next turn
can use a different provider or model, admit input differently, change which registered
tools it may use, project another prompt shape, or adopt a different tool-error policy
without rebuilding the runtime or mutating work already in flight.

Those changes happen at committed boundaries and become part of the session record.
What would usually be a cross-cutting reconfiguration problem becomes a serialized
policy event with a specific version.

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
[the VS Code setup](docs/vscode-acp.md).

## What the architecture enables

- **Commit before effects.** Pure state-machine decisions stage journal records and
  commands. Dependent work starts only after storage confirms the matching append.
- **Recovery without blindly repeating work.** An uncertain append is reconciled by
  loading the stream. Restore reconstructs state without replaying external effects and
  retains tool results that were already committed.
- **Durable partial progress.** Each tool result crosses its own commit gate before the
  batch advances, so an interruption does not erase accepted results.
- **Cheap alternate histories.** Forking and compaction create independent sessions at
  recorded turn boundaries. A fork retains history; a compacted child starts from
  replacement context without rewriting its ancestors.
- **Provider changes as policy.** OpenAI Chat, OpenAI Responses, Anthropic Messages, and
  Google GenerateContent are versioned profiles behind one completion port. Provider
  wire formats stay separate from agent decisions, while credentials and transport
  bindings stay out of the journal.
- **Inspectable behavior.** Deterministic fixtures expose requests, journal records,
  snapshots, transcripts, and terminal outcomes, making ordering and recovery behavior
  reviewable rather than implicit.

## Repository map

| Area                        | Role                                                        |
| --------------------------- | ----------------------------------------------------------- |
| `packages/core/agent`       | Pure turn decisions, operations, tool batches, and prompts  |
| `packages/core/session`     | Journaling, persistence, recovery, settlement, and branches |
| `packages/core/host`        | Shared execution resources, routing, and cancellation       |
| `packages/core/policy`      | Versioned runtime behavior and provider selection           |
| `packages/core/providers`   | Versioned provider profiles and fetch transport             |
| `packages/core/environment` | Event sources and renderer bindings                         |
| `packages/core/logging`     | Environment-owned diagnostics                               |
| `packages/web`              | Local session console and brand design system               |

Each core module documents its local contracts in its own README where present.
Cross-module architecture and flow diagrams live in [`docs/`](./docs/).

## Development

```sh
bun install
bun test packages/core
bunx tsc --noEmit
bun run format:check
```

Use `bun run dev` for the local session console and `bun run build` for its production
bundle. Open `/brand` for the design language board.

The project is still experimental. Persistence is an injected contract rather than a
bundled durable backend, and protocol integration described in the design notes is not
all implemented. The web package hosts one in-memory session console; it is not a
complete session interface.
