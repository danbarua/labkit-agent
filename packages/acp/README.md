# ACP stdio adapter

`@labkit-agent/acp` connects an ACP client to journaled core sessions. It uses the official
`@agentclientprotocol/sdk` 1.5.0 fluent API and newline-delimited JSON-RPC over stdin/stdout.
Core remains transport-independent. Journal versions and turn decisions are unchanged; an optional
tool execution context supplies the operation ID used to associate client terminals with tool cards.

## Workspace agent for VS Code

Use [examples/vscode-workspace.ts](examples/vscode-workspace.ts) for a runnable workspace
agent. See [VS Code setup](../../docs/vscode-acp.md) for the ACP Client launch configuration.
Set `LABKIT_ACP_MODEL` and the provider credential in the launch environment. The default
profile is `anthropic-messages@3`; `LABKIT_ACP_PROVIDER` also accepts `openai-chat@2`,
`openai-responses@3`, or `google-generate@3`. These use `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
and `GOOGLE_API_KEY`, respectively. `LABKIT_ACP_BASE_URL` optionally overrides the API base URL.
The example enables streaming and once-only permissions, with one agent and `successors: []`.
Omitting successors permits handoff to all registered agents, including itself.
The example exposes File access (read-only/edit), Model, and Thinking selectors. Both file modes
keep `permissions: "ask"`; read-only removes `write_file` from the allowed tool set. The initial
model comes from `LABKIT_ACP_MODEL`; optional comma-separated `LABKIT_ACP_MODELS` adds selectable
models for the same bound provider. No catalog or model availability is inferred. Thinking choices
come from the versioned profile capability (off plus effort levels or adaptive/default budget).

The example enables experimental session forking and persists under `<cwd>/.labkit/sessions/store.sqlite` and advertises
`loadSession: true`. Bun SQLite transactions store ordered journal batches and their stable
append IDs; a separate table holds session-scoped blobs. Blob bytes never enter journal records.
FULL synchronous commits (with macOS fullfsync enabled) precede append receipts. Database handles
close after every operation. Restart can load saved sessions with compatible agent configuration;
changing the model or tool schemas may require restoring the original configuration first.
The database is bound to its canonical workspace cwd; moving/copying it to another workspace is
rejected. Back up the database while the agent is stopped. This is a local-disk adapter, not a
network-filesystem or multi-host service. Explicit session deletion removes its journal, metadata,
and blobs atomically, leaving an ID tombstone to prevent stale writers from resurrecting it. This
ends that session's persistence lifetime; old append IDs no longer acknowledge prior writes. It
does not delete independent fork children. SQLite deletion is not secure erasure of disk pages.
Discovery metadata is added to older stores without rewriting journal records. No automatic pruning is provided.
SQLite recovery handles interrupted transactions; interrupted agent turns use core recovery and
never rerun tools automatically. Storage errors do not authorize execution.

Workspace file tools are `read_file` (read), `write_file` (edit), and `list_dir` (search). Every
location is absolute and bound to the session cwd. Parent traversal, outside paths, and the
reserved `.labkit` directory are rejected. Local filesystem operations additionally reject symlink
components and hard-linked files. Reads require UTF-8 and reads/writes are capped
at 256 KiB. Listings are shallow and capped at 1,000 entries and 256 KiB of entry data. Writes
require existing parent directories. Rejected permission prevents execution. Cancellation after
a write starts cannot undo bytes already written. These filesystem checks are not an OS sandbox
against hostile concurrent ancestor-directory renames. Command execution is disabled by default.

When the client advertises `fs.readTextFile` or `fs.writeTextFile`, the example delegates that
operation to the client, allowing reads of unsaved editor buffers and editor-managed writes.
Capabilities are checked independently; unsupported operations keep the local implementation.
Client errors never fall back to local disk. Listings and resource-link ingestion remain local.
Delegated paths still pass workspace lexical checks, but the client owns file resolution, symlink
handling, and editor write semantics. Local inode checks cannot constrain a remote client.

Factories receive optional `SessionOptionsContext.clientFiles` methods (`readText`, `write`),
with session identity and client capabilities already bound. Only advertised methods are present.
Bind these ports inside tools, not during factory setup. The workspace example invokes them only
inside the existing permission-gated tool operation; a rejection sends no filesystem request.
RPCs use the tool AbortSignal and a 60-second timeout; disconnect cancels outstanding waits.
Late responses cannot settle cancelled tool operations. Writes already dispatched may have taken
effect despite cancellation or an ambiguous response. Read results and write input retain the
256 KiB cap, and normal tool arguments/results are journaled through core.

## Slash commands

The workspace example advertises `/review`, `/explain`, and `/plan`. These expand into ordinary
user prompts for review, explanation, and planning; they do not run tools directly, alter policy,
or bypass permissions. Supplied attachments and later text blocks are preserved. The plan command
asks for planning without implementation; execution still follows the normal model/tool loop.

`AcpSessionOptions.commands` accepts `AcpCommand` entries with `name`, `description`, optional
`input: { hint }`, and a `prompt` template string. Bindings are validated and copied at session
opening (at most 64 unique command names). The adapter sends `available_commands_update` on
new/load/resume when commands exist. Metadata excludes the prompt template. Names use lowercase
letters, digits, underscores, and hyphens, beginning with a letter; omit the leading slash.

A declared `/name` prefix in the first text block expands to the template plus the remaining
unstructured argument text. Other blocks keep their order. Unknown command prefixes and ordinary
slash-containing text are left unchanged. The expanded user text, including the command name,
is journaled once; restore replays it without re-expanding against changed templates. Catalogs
remain fixed for an open session and are rebound from the factory on load/resume. Dynamic command
registration and commands with direct session lifecycle effects are not implemented.

## Plans

The workspace example exposes `update_plan` (`kind: "think"`) in both file-access modes. It accepts
`{ entries: [{ content, priority, status }] }`: priority is high/medium/low and status is
pending/in_progress/completed. Every call replaces the complete plan; omitted entries disappear,
and an empty list clears it. Plans are bounded to 128 entries, 4,096 characters per entry, and
64 KiB serialized. The model states progress explicitly; the adapter does not infer completion
from tool success or execute plan entries. Permission policy still applies to this tool.

Applications can use exported `planTool(context.publishPlan)` or call the session-bound
`publishPlan(entries, operationSignal)` from their own operation. The adapter validates complete
lists and emits ACP `session/update` with `sessionUpdate: "plan"`. Cancelled operations and closed
sessions cannot publish through this port. Tool arguments/results are journaled normally; the
notification remains best-effort and may precede the tool-result receipt. Failing or stalled plan
subscribers cannot fail or hold a tool operation. Reload replays durable tool output, not an active
plan UI; a subsequent update establishes the current displayed plan.

## Client terminals

Set `LABKIT_ACP_TERMINAL=1` to opt the workspace example into `run_command`, provided the client
advertises `terminal: true`. Otherwise no command tool is exposed and no terminal requests are
sent. Read-only mode excludes this tool. Edit mode includes it; the example still requires approval
before `terminal/create`. Commands run through the client, never through a local shell fallback.
The working directory is the workspace cwd, but commands are not filesystem-sandboxed and may
access resources outside that directory. Provider credentials are not added to terminal requests;
the client controls its execution environment.

Factories receive `SessionOptionsContext.terminal` only when supported. The exported `terminalTool`
helper binds it to the ordinary core tool lifecycle (`kind: "execute"` and an absolute cwd location).
Each invocation creates a terminal, waits for exit, reads output, and releases it. Results include
output, truncation, exit code, and signal; a nonzero exit is returned to the model as command data.
Execution is limited to 120 seconds and retained output to 256 KiB. Oversized client responses fail.
Cancellation/errors before exit attempt kill followed by release, with at most two seconds per
cleanup request. Successful operations also release; cleanup errors fail the tool operation.
A terminal ID received after cancellation is still released while the connection remains open.
After disconnection, the client is responsible for cleaning up its processes. Neither cancellation
nor release undoes side effects. Changing terminal capability/opt-in changes the tool manifest;
restore requires the original compatible manifest.

Terminal IDs are operation resources, not journal data. Final command output is an ordinary tool
result and is journaled. The terminal is embedded in its live tool card as soon as creation returns,
using core's operation `toolCallId`. Parallel commands keep separate associations even when IDs
arrive out of order. Final content retains the terminal reference alongside the bounded output;
clients can keep displaying released terminals. Cancellation before creation returns suppresses
embedding but still releases the late terminal. Restore replays durable output without resurrecting
terminal resources or replaying ephemeral IDs.

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
- `session/resume`: available with `loadSession`; restores and recovers like load but emits no
  conversation replay. Duplicate live sessions remain rejected.
- `session/fork`: experimental, opt-in via `forkSession: true` (requires `loadSession`). Forks a
  live session at its next terminal boundary, serialized with pending configuration changes. Saved
  parents are restored privately with no history replay or display updates, then released after
  publication. Concurrent prompts, loads, and forks cannot take over that temporary parent.
  Core copies inherited blobs and commits the self-contained child creation before publication.
  The adapter then rebinds fresh ACP resources through the ordinary factory/restore path; no model
  completion, tool, permission, or terminal is replayed. Parent history remains independent.
  The child response includes its ID and inherited config/mode state, without conversation replay.
  The cwd must match the parent workspace, and MCP descriptors must remain identical (omitting
  `mcpServers` reuses a live parent's bindings). For a saved parent, supply the original MCP
  descriptors needed for compatible restoration; credentials remain outside the journal.
  Additional roots remain unsupported. Cancellation before dispatch creates no child; cancellation after
  dispatch cannot roll back a committed branch. If rebinding fails after publication, RPC error
  data includes the durable child ID so it can be loaded with compatible bindings. A cancelled
  request may leave a saved branch discoverable through session listing.
- `session/delete`: opt-in through `deleteSession({ sessionId, cwd? }, signal)`. The adapter closes
  any loaded runtime and its resources before invoking the hook, and replies only after the hook
  completes. Concurrent load/prompt/fork/delete requests for that ID are rejected while deletion
  is pending. Cancellation stops waiting but cannot undo deletion; the lifecycle lock remains until
  the hook settles. A failed hook leaves the runtime closed, with persisted data governed by the
  hook's outcome. The workspace example deletes within known/discovered workspaces, without a
  global disk scan. Missing IDs are idempotent no-ops; ambiguous IDs across workspaces are rejected.
- `session/list`: opt-in through an application `listSessions(params, signal)` callback. The workspace
  example discovers the launch cwd and workspaces seen by its factory or explicit list filters; an explicit absolute cwd
  filter can discover another workspace. It reads only database metadata, without restoring sessions,
  accessing blobs or binding providers. Pages contain at most 50 entries in stable cwd/session-ID
  order, with opaque cursors (32 retained per factory, invalidated on process restart).
  Titles come from the first committed nonempty user text, limited to 120 characters; updatedAt is
  captured in the same transaction as each journal append. Older untouched stores omit unavailable
  metadata. A filtered missing store returns an empty list and is never created by discovery.
- `session/update`: tool lifecycle/content/locations, streamed agent text and thought chunks,
  committed nonstream assistant text, and optional persisted session-info updates. Stable completion message IDs prevent duplicate final text.
- `session/set_config_option`: select a declared value and commit its policy patch before responding
  with the full configuration list. Requests during a prompt wait for its terminal boundary; new
  prompts wait for pending configuration commits. Cancellation before dispatch prevents the patch;
  cancellation after persistence dispatch does not imply rollback. Failed patches publish no change.
- `session/set_mode`: compatibility alias for the single mode-category selector. Mode and config
  notifications reflect the same committed policy. New/load/resume responses include current
  config options and legacy modes when bindings are provided. No boolean selector is advertised.
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

## Client-supplied MCP tools

New/load/resume connect supplied stdio, Streamable HTTP, and legacy SSE MCP servers using `@modelcontextprotocol/sdk` 1.30.1.
Servers run directly (no command shell) with the session cwd, SDK baseline environment, and explicit
ACP environment entries. Provider credentials are not inherited automatically. Server stderr goes
to stderr; stdout belongs to that server's MCP transport. Only the primary workspace is advertised
through MCP `roots/list`; roots are advisory and do not sandbox an external server process.

The adapter initializes each server, paginates `tools/list`, and freezes the resulting catalog for
the session. Names use `mcp_<server>_<tool>_<hash>` to fit provider limits and avoid collisions. The
catalog is sorted for stable restore manifests. Reopening reconnects and validates compatible tool
schemas; it never reissues recorded calls. Tool-list-change notifications do not mutate a running
session's registry. Sampling, elicitation, task-only tools, and resource/prompt browsing are not
advertised. ACP-proxied MCP servers are not supported.

HTTP/SSE connections forward the supplied headers, including authentication headers. URLs must
use HTTP(S); redirects and cross-origin SSE endpoints are rejected. Supply the final endpoint URL.
OAuth negotiation is not implemented. HTTP reconnect/replay is disabled. Closing attempts HTTP
session termination for at most two seconds, then closes local connections regardless of the reply.

MCP input JSON Schema (2020-12 by default; declared draft-07/2019-09 also supported) is validated
before the ordinary core permission phase. Annotations only supply display hints; they never bypass
permission. Tool execution uses the same child AbortSignal and journal receipts as local tools.
MCP `isError` responses become failed tool outcomes. Text, structured JSON, resource links, and
embedded textual resources remain JSON results. Binary content is rejected rather than written as
base64 in the journal. Results and input schemas are limited to 256 KiB; each server may expose at
most 256 tools, with at most 32 servers per session. Initialization/list requests time out after
15 seconds; tool calls time out after 60 seconds. Cancellation sends the MCP cancellation notification;
remote effects already started cannot be undone. Session close/disconnect also closes the transports
and stops their child processes, including connections still opening.

The adapter merges discovered tools into the bound registry and each agent's capabilities. Explicit
policy tool restrictions still apply. Factories receive `SessionOptionsContext.mcpTools` to include
these names in their own configuration selectors. The workspace example includes MCP tools in edit
mode, and excludes them in read-only mode because external tools are outside its file sandbox.
Commands, process handles, environment bindings, HTTP headers, and MCP clients never enter the journal; schemas,
arguments and successful tool results do, as ordinary core tool data.

## Session metadata notifications

An optional `sessionInfo({ sessionId, cwd }, signal)` callback reads persisted display metadata.
The adapter refreshes it after visible new/load/resume, prompt settlement, configuration commits,
and fork publication. Results may include title, an ISO 8601 updatedAt timestamp, and JSON `_meta`.
Omitted fields are unchanged; null explicitly clears title/timestamp. Identical consecutive results
are suppressed. Invalid, failed, stale, or closed-session replies are dropped. Pending callbacks
never delay prompts, receipts, or lifecycle responses; callbacks should honor the connection signal.
The adapter does not generate titles or timestamps from uncommitted input.

The workspace example reads the same metadata rows used by discovery: title is the first committed
nonempty user text (whitespace-normalized and capped at 120 characters), and updatedAt is written in
the journal append transaction. Older metadata can be absent, represented as null. Reads do not
restore a runtime or access blobs. Private fork-parent restoration emits no metadata notifications.

## Configuration bindings

`sessionOptions` may return `AcpSessionOptions`, which extends core options with a `config` array.
Each `AcpConfigBinding` declares `id`, `name`, optional `category`/`description`, select `options`
(`value`, `name`, optional `description`, and a `PolicyPatch`), and a pure `current(policy)` selector.
The selector must derive its value from journaled policy and match a declared option; it must not
keep a separate mutable selection. Each patch must produce its corresponding selected value.
Bindings are copied at session opening, while callbacks remain executable host resources. They are
never written to the journal. Core validates tool/provider capability restrictions on each patch.
Use one `category: "mode"` binding to also expose the legacy mode API. Applications without config
bindings retain their existing new/load/resume response shapes.

The adapter sends `config_option_update` after committed state changes and `current_mode_update`
when the selected mode changes. A response means the journal accepted the policy update, not merely
that a display event was emitted. Compatible bindings must still represent restored policy values;
removing a saved model from the offered choices makes that configuration incompatible with restore.
The initial agent manifest model remains unchanged by a policy selection, so keep the original
`LABKIT_ACP_MODEL` when restarting a session that selected an alternate model.

## Explicit limits

This is an ACP v1 **session subset**, not a claim of full protocol conformance. Text, resource-link, image, and embedded-resource
prompts are accepted. Local `file://` links and paths inside the session cwd are read through the
workspace path checks and stored with `putBlob` in that session before admitting the user input.
The journal contains attachment refs, never file bytes. Outside paths are rejected without reading
them. Non-file URLs remain textual references; the adapter never fetches them. Cancellation during
ingestion admits no user turn (an unreferenced blob may already have been stored).

Local attachments retain the 8 MiB blob cap. Extensions select markdown, PDF, PNG, JPEG, or UTF-8
plain text; the bound provider must support the selected media. The existing 64 KiB provider text
inline cap is unchanged. Attaching a local resource is an explicit user input and does not create
a tool permission request. Model-initiated file access still uses the permission-gated tools.
Image and embedded-context capabilities are advertised. PNG/JPEG image data and embedded binary
resources (PNG/JPEG/PDF or UTF-8 plain text/markdown) require canonical base64 and the same 8 MiB
raw-byte cap. Binary resources require an explicit supported MIME type. Embedded text is stored
as markdown when declared `text/markdown`, otherwise as plain text, including source-code MIME
types. Embedded URIs are labels only: supplied bytes can represent unsaved or outside-workspace
content, and no file read or URL fetch occurs. Blob refs, not content bytes, enter the journal.
Provider media support is checked before storage/admission; attachments require a bound provider
profile. Custom completion ports without a provider registry cannot resolve attachment media. Audio prompt blocks remain unadvertised and rejected.
The existing provider text inline cap still applies to embedded resources.

Client-supplied stdio, HTTP, and SSE MCP servers are supported. MCP OAuth and ACP-proxied MCP,
remembered permissions, cross-provider switching, extra workspace roots,
and ACP HTTP transport remain unimplemented. No usage_update is fabricated from provider usage deltas:
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
[session discovery](https://agentclientprotocol.com/protocol/v1/session-list),
[experimental fork API](https://agentclientprotocol.github.io/typescript-sdk/types/ForkSessionRequest.html),
[configuration](https://agentclientprotocol.com/protocol/v1/session-config-options),
[filesystem](https://agentclientprotocol.com/protocol/v1/file-system),
[terminals](https://agentclientprotocol.com/protocol/v1/terminals),
[plans](https://agentclientprotocol.com/protocol/v1/agent-plan),
[commands](https://agentclientprotocol.com/protocol/v1/slash-commands),
[prompt turns](https://agentclientprotocol.com/protocol/v1/prompt-turn),
[TypeScript SDK](https://agentclientprotocol.com/libraries/typescript).
