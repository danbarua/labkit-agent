# Labkit Agent

Labkit Agent is an experimental runtime for computational-science agents. Its unusual
part is that a running session's behavior is explicit, versioned policy: the next turn
can use a different provider or model, admit input differently, change which registered
tools it may use, project another prompt shape, or adopt a different tool-error policy
without rebuilding the runtime or mutating work already in flight.

Those changes happen at committed boundaries and become part of the session record.
What would usually be a cross-cutting reconfiguration problem becomes a serialized
policy event with a specific version.

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
| `packages/web`              | Small local completion console                              |

Each core module documents its local contracts in its own README where present.
Cross-module architecture and flow diagrams live in [`docs/`](./docs/).

## Development

```sh
bun install
bun test packages/core
bunx tsc --noEmit
bun run format:check
```

Use `bun run dev` for the local web console and `bun run build` for its production
bundle.

The project is still experimental. Persistence is an injected contract rather than a
bundled durable backend, and protocol integration described in the design notes is not
all implemented. The web package is currently a provider console, not a complete
session interface.
