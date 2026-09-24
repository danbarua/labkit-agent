# ACP stdio adapter

`@labkit-agent/acp` connects an ACP client to journaled core sessions. It uses the official
`@agentclientprotocol/sdk` 1.5.0 fluent API and newline-delimited JSON-RPC over stdin/stdout.
Core remains transport-independent: no journal version, turn decision or host port changes.

## Workspace agent for VS Code

Use [examples/vscode-workspace.ts](examples/vscode-workspace.ts) for a runnable workspace
agent. See [VS Code setup](../../docs/vscode-acp.md) for the ACP Client launch configuration.
Set `LABKIT_ACP_MODEL` and the provider credential in the launch environment. The default
profile is `anthropic-messages@3`; `LABKIT_ACP_PROVIDER` also accepts `openai-chat@2`,
`openai-responses@3`, or `google-generate@3`. These use `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
and `GOOGLE_API_KEY`, respectively. `LABKIT_ACP_BASE_URL` optionally overrides the API base URL.
The example enables streaming and once-only permissions, with one agent and `successors: []`.
Omitting successors permits handoff to all registered agents, including itself.

The example journals sessions and stores blobs **in memory only**. It prints a warning to
stderr and advertises `loadSession: false`. Restart loses both journal and blobs. Applications
can supply their own durable `SessionPersistence`; this example does not claim restart recovery.

Workspace tools are `read_file` (read), `write_file` (edit), and `list_dir` (search). Every
location is absolute and bound to the session cwd. Parent traversal, outside paths, symlink
components, and hard-linked files are rejected. Reads require UTF-8 and reads/writes are capped
at 256 KiB. Listings are shallow and capped at 1,000 entries and 256 KiB of entry data. Writes
require existing parent directories. Rejected permission prevents execution. Cancellation after
a write starts cannot undo bytes already written. These filesystem checks are not an OS sandbox
against hostile concurrent ancestor-directory renames. There is no shell tool.

## Run from a host

Create a local configuration module that default-exports `AcpOptions`. Supply the same
`BoundSessionOptions` you use when embedding core:

```ts
// acp-config.ts in your application
import type { AcpOptions } from "@labkit-agent/acp";

import { optionsForWorkspace } from "./agent-options.ts";

export default {
  sessionOptions: ({ cwd, sessionId, signal }) => optionsForWorkspace({ cwd, sessionId, signal }),
  loadSession: true,
} satisfies AcpOptions;
```

`optionsForWorkspace` is your application function, not an adapter export. It returns
`{ persistence, configuration, bindings }` with provider credentials, tools and persistence bound.
To try the protocol without a provider account or disk persistence, this configuration is executable:

```ts
import type { AcpOptions } from "@labkit-agent/acp";
import { createMemoryPersistence } from "@labkit-agent/core/testing";

const persistence = createMemoryPersistence(); // process-local test store
export default {
  sessionOptions: () => ({
    persistence,
    configuration: {
      agent: "demo",
      agents: new Map([["demo", { model: "demo" }]]),
      steps: 4,
    },
    bindings: {
      complete: () => ({ kind: "answer", text: "ACP connection established" }),
    },
  }),
} satisfies AcpOptions;
```

Configure Air, VS Code's ACP client, or another ACP client to launch:

```sh
bun /Users/dan/Code/science/labkit-agent/packages/acp/cli.ts \
  --config /absolute/path/to/acp-config.ts
```

The client must keep stdin open while requests are active. All stdout bytes belong to ACP;
configuration modules, tools, and logging sinks must write diagnostics to stderr. The adapter
never changes process.cwd(). Bind relative tool paths to the supplied absolute session cwd.

For local sibling projects, register this package once with `bun link` from `packages/acp`, then
run `bun link --save @labkit-agent/acp` in the consumer. The checkout needs `bun install` at its root.
You can also call `await serveAcpStdio(options)` in your own launcher. `connectAcp(stream, options)`
accepts an SDK Stream for embedding/testing and returns `{ connection, closed, close }`; `closed`
resolves after owned sessions have closed. Stores and credential lifetimes remain caller-owned.

## Supported protocol surface

- `initialize`: negotiates ACP v1; declares actual prompt/load/close capabilities. Credentials are
  supplied by the environment, so no interactive authentication methods are advertised.
- `session/new`: creates a journaled session. Each connection owns its loaded runtimes.
- `session/prompt`: admits one active prompt per session and waits for durable terminal settlement.
  Separate sessions run independently; overlapping prompts in one session return an RPC error.
- `session/cancel`: remains responsive during completions, tools, and permission requests. It routes
  abort through core and returns `cancelled` on the original prompt. Idle cancellation is a no-op.
- `session/close`: closes the runtime and cancels owned work; it does not delete persisted data.
- `session/load`: opt-in via `loadSession: true`. The factory receives sessionId and must resolve the
  compatible saved configuration/store and validate that cwd belongs to that session. No durable
  session-to-workspace directory is invented by this adapter. Duplicate live loads are rejected.
- `session/update`: tool lifecycle/content/locations, streamed agent text and thought chunks, and
  committed nonstream assistant text. Stable completion message IDs prevent duplicate final text.
- `session/request_permission`: once-only options, correlated through SDK requests. The core
  operation's AbortSignal cancels the wait even if a client never replies; late allows cannot run tools.

Sessions default to policy `permissions: "ask"`; an explicit factory policy `off` retains unattended
execution. Restored sessions retain their journaled policy. The ACP permission callback replaces any
factory `requestPermission` callback. Existing observe/toolUpdate/streamUpdate callbacks remain
best-effort subscribers. Neither outgoing display updates nor an ACP response certifies a commit.
Both the admitted tool-intent receipt and approval receipt still precede execution.

Prompt responses map completed → `end_turn`, exhausted → `max_turn_requests`, aborted → `cancelled`,
and a recorded permission rejection → `refusal`. Provider, tool, storage and malformed-permission
failures return JSON-RPC errors. Partial stream text may already be visible when a stream fails;
it never becomes a successful partial model_settled. Updates queued for a prompt are written before
its response. EOF, output failure and SIGINT/SIGTERM close owned runtimes and cancel their children.
Factories should honor their AbortSignal; disconnect does not await an unresponsive factory, and
late factory resolution cannot start a session.

Loading replays committed user/assistant messages and tool results before the load response. Raw
journal outcomes preserve failed tool status under tolerant policy. Seeded histories without raw
outcomes omit unknown status; kind defaults to other and locations are not reconstructed because
that metadata is not journaled. Interrupted calls display failed, and recovery does not reissue
permissions or run tools. Blob-bearing historical messages render resource links without object-store
reads. Thinking/signature payloads are not replayed as visible reasoning.

## Explicit limits

This is an ACP v1 **session subset**, not a claim of full protocol conformance. Text and resource-link
prompts are accepted. Local `file://` links and paths inside the session cwd are read through the
workspace path checks and stored with `putBlob` in that session before admitting the user input.
The journal contains attachment refs, never file bytes. Outside paths are rejected without reading
them. Non-file URLs remain textual references; the adapter never fetches them. Cancellation during
ingestion admits no user turn (an unreferenced blob may already have been stored).

Local attachments retain the 8 MiB blob cap. Extensions select markdown, PDF, PNG, JPEG, or UTF-8
plain text; the bound provider must support the selected media. The existing 64 KiB provider text
inline cap is unchanged. Attaching a local resource is an explicit user input and does not create
a tool permission request. Model-initiated file access still uses the permission-gated tools.
Image, audio and embedded-resource prompt blocks are not advertised and are rejected.

Client-supplied MCP servers are rejected, including stdio MCP (required by the full ACP baseline).
Tools currently come from session bindings. MCP connections, client filesystem/terminal delegation,
remembered permissions, mode/model/config switching, extra workspace roots, session list/fork/resume,
and HTTP transport are not implemented. No usage_update is fabricated from provider usage deltas:
ACP requires a context-window size that core does not currently supply.

## Validation

```sh
bun test packages/acp packages/core
bunx tsc --noEmit
bun run packages/core/session/fixture-runner.ts
bun run packages/core/session/fixture-runner.ts --v2
```

Tests drive actual JSON-RPC frames, permission correlation and delayed receipts, cancellation,
disconnect/output failure, recovery/history, all four streaming dialects, and a spawned Bun stdio
process. They use injected provider responses and do not call paid APIs. No real Air/VS Code UI
integration test is implied.

Protocol references: [stdio](https://agentclientprotocol.com/protocol/v1/transports),
[initialization](https://agentclientprotocol.com/protocol/v1/initialization),
[session setup](https://agentclientprotocol.com/protocol/v1/session-setup),
[prompt turns](https://agentclientprotocol.com/protocol/v1/prompt-turn),
[TypeScript SDK](https://agentclientprotocol.com/libraries/typescript).
