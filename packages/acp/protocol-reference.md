# ACP protocol and binding reference

`@labkit-agent/acp` connects an ACP client to journaled core sessions. It uses the official
`@agentclientprotocol/sdk` 1.5.0 fluent API and newline-delimited JSON-RPC over stdin/stdout.
For integration decisions and launch setup, start with the [module guide](README.md).
This reference lists supported messages, binding fields, limits, and cleanup behavior.

## Workspace agent for VS Code

Use [examples/vscode-workspace.ts](examples/vscode-workspace.ts) for a runnable workspace
agent. See [VS Code setup](../../docs/vscode-acp.md) for the ACP Client launch configuration.
Models come from the core model catalog (`catalogProviders` and `localhostProvider` from
`@labkit-agent/core/providers`, over the committed models.dev snapshot). Every provider whose API key
is set under one of the snapshot's `env` names is bound (for example ANTHROPIC_API_KEY,
OPENAI_API_KEY, GOOGLE_API_KEY or GEMINI_API_KEY, XAI_API_KEY), plus a local OpenAI-chat-compatible
server at LABKIT_LOCAL_BASE_URL (default `http://localhost:8000/v1`) when its `GET /models` answers.
Discovery happens once, on the first session. It logs `acp.catalog.loaded` (info: source, bound
providers with model counts and credential variable names, skipped providers with the names
checked, local server status) and `acp.catalog.localhost_unavailable` (info: baseUrl, reason,
status). Header values and keys are never logged. With no provider bound, session creation fails
with the variable names checked and the local URL tried.

The example enables streaming and explicit permissions. Ordinary tool failures are returned to the
model with their structured causes so it can recover; sibling calls finish. Tool failure handling
can commit that behavior to an existing session without editing its journal. File access, Model,
Thinking and output-limit selectors commit the same core policy contract.

The Model selector groups options by provider (group ID = provider ID, name = provider label); each
value is `<provider>/<model>`, split at the first slash because local model IDs contain slashes.
Its patch sets provider and model and keeps the policy valid for the new model: thinking is kept
when offered, otherwise off (or the first choice of an always-on model) with the budget cleared;
the output limit is clamped to the model's limit; streaming is turned off when the model cannot
stream. Thinking choices are the selected model's catalog list: Off, Adaptive, effort levels, or
explicit budgets of 1024/4096/8192/16384 tokens (at least the model minimum and below the output
limit). Output-limit choices are 4096 to 128000-token presets up to the model limit, plus the limit
itself; the limit covers thinking and answer tokens and must exceed a budget. Adapter profiles
(for example Anthropic adaptive versus manual budget) are chosen per model inside the binding;
users never select them.

New sessions start on LABKIT_ACP_MODEL (`<provider>/<model>` or a bare model ID served by the first
bound provider that lists it), otherwise on the first bound provider's default model (anthropic,
openai, google, xai, localhost order), with thinking off unless always-on and an output limit of
min(32768, model limit). An unknown LABKIT_ACP_MODEL does not stop the launch: it logs
`acp.catalog.default_model_unresolved` (warning: requested value, fallback provider and model,
consequence) and uses the default.
Relaunching with a different model, tool set or agent does not prevent reopening saved sessions;
the change is adopted on the next prompt ([registry changes](#registry-changes-on-reopen)). Historical journal formats are not migrated.

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
location is absolute and bound to the session workspace roots. Parent traversal, outside paths, and the
reserved `.labkit` directory are rejected. Local filesystem operations additionally reject symlink
components and hard-linked files. Reads require UTF-8 and reads/writes are capped
at 256 KiB per result/write. `read_file` accepts optional `line` (1-based starting line) and `limit`
(maximum line count). Omit both to read the complete file. A range can read part of a file larger
than 256 KiB; local reads scan with bounded memory and retain original line endings. A start beyond
EOF returns empty text. A single selected line larger than the result cap is rejected explicitly.
The same range is forwarded to `fs/read_text_file` when the client owns reads, preserving unsaved
editor content rather than substituting disk contents. Listings are shallow and capped at 1,000 entries and 256 KiB of entry data. Writes
require existing parent directories. Rejected permission prevents execution. Cancellation after
a write starts cannot undo bytes already written. These filesystem checks are not an OS sandbox
against hostile concurrent ancestor-directory renames. Command execution is disabled by default.

Permission titles include the tool name and its validated absolute locations (including line numbers
when provided). This makes file targets visible in clients whose permission picker displays only the
title. Paths are quoted and control characters escaped; file contents and other arguments are not
copied into the title. The structured `locations` field is still supplied separately.
Live tool cards receive the same title when locations resolve, and retain it through completion.
Location-only updates include the current status so clients do not mistake them for completion.

When the client advertises `fs.readTextFile` or `fs.writeTextFile`, the example delegates that
operation to the client, allowing reads of unsaved editor buffers and editor-managed writes.
Capabilities are checked independently; unsupported operations keep the local implementation.
Client errors never fall back to local disk. Listings and resource-link ingestion remain local.
Delegated paths still pass workspace lexical checks, but the client owns file resolution, symlink
handling, and editor write semantics. Local inode checks cannot constrain a remote client.

Factories receive optional `SessionOptionsContext.clientFiles` methods (`readText`, `write`),
with session identity and client capabilities already bound. Only advertised methods are present.
`readText(path, signal, context?, range?)` accepts `{ line?, limit? }` as its final argument; range
validation occurs before dispatch. Diagnostic request/completion/failure records include that range.
Bind these ports inside tools, not during factory setup. The workspace example invokes them only
inside the existing permission-gated tool operation; a rejection sends no filesystem request.
RPCs use the tool AbortSignal and a 60-second timeout; disconnect cancels outstanding waits.
Late responses cannot settle cancelled tool operations. Writes already dispatched may have taken
effect despite cancellation or an ambiguous response. Read results and write input retain the
256 KiB cap, and normal tool arguments/results are journaled through core.

## Tool content bindings

`AcpSessionOptions.toolContent?: ReadonlyMap<string, AcpToolContent>` binds a synchronous pure renderer
to each named tool. `AcpToolContentContext` contains `toolName` and the successful serialized `output`.
Both types are exported from the package entry point. The map is copied when the session opens;
unknown tool names and non-function bindings reject opening. Renderers are not called for failed or
cancelled tools. Results must be JSON arrays of ACP `content` or `diff` blocks. Diff paths must be
absolute; `oldText: null` denotes a new file. Optional annotations and `_meta` pass through.
Terminal blocks are rejected here because their handles require a live client-terminal lifetime.

For a tool whose saved result explicitly contains a `changes` array, an application can validate its
own result schema and return those changes as diffs. The renderer must not read current disk content
to manufacture `oldText`: that would misrepresent the actual operation and change history on reload.
The adapter retains raw output and sends an explicit display error if rendering or validation fails.
Reload reconstructs display from saved results, marks the notification as reconstructed, and performs
no tool, completion or permission invocation. Unbound tools retain plain-text display.

### Workspace write evidence

The workspace launcher registers the exported `workspaceToolContent` map. `write_file` returns
`FileWriteResult`: `{ path, bytes, before, newText }`. `FileBefore` is one of:

- `{ kind: "text", text, source: "filesystem" | "client" }` for observed prior contents.
- `{ kind: "absent", source: "filesystem" }` when an exclusive create proved no file existed.
- `{ kind: "unavailable", reasonCode: "read_not_supported" | "read_failed", reason, source }`.

Only the first two yield diff blocks. Empty old text is an existing empty file; null means confirmed
creation. Diff `_meta["labkit.dev/baseline"]` identifies the observation source. Unknown prior content
produces an explanatory text block, never a fabricated new-file diff. Reload uses these saved values
and makes no filesystem or editor request. Client errors cannot authorize reading local disk instead.

Local baseline capture is bounded to 256 KiB and requires valid UTF-8; larger/binary prior content
does not prevent writing a valid replacement within the write limit. Editor capture uses the same
bounded `readText` port. Capture and write are sequential observations, not an atomic editor
transaction; concurrent edits can intervene. Permission covers the write operation including its
baseline read. Cancellation/timeouts stop it before the subsequent write. Failure after write
starts can still leave partial effects and does not produce a completed diff.

## Session usage

`AcpSessionOptions.usage` implements the [session usage notification](https://agentclientprotocol.com/rfds/session-usage).
Its public types are `AcpUsageBinding`, `AcpUsageContext` and `AcpUsage`; `AcpUsageSchema` validates
source output. Required `used` is a finite nonnegative number and `size` a finite positive number. `used` can
exceed `size` so a source can report an over-capacity context. Optional `cost` is null or
`{ amount, currency, _meta? }`, with a finite nonnegative cumulative amount and an uppercase
three-letter currency code. Top-level `_meta` is preserved. There is no implicit currency or price.

The read context contains the immutable session snapshot and resolved bound model when available.
Only committed journal revisions trigger reads. The optional subscription can trigger a refresh
without a journal change. Reads are asynchronous and never hold up a prompt; updates may follow
its terminal response. Each new read cancels the preceding one, and late or stale results are
ignored. Close, logout, delete and disconnect cancel reads and unsubscribe. Setup/restore queries
never dispatch a completion, tool or permission request.

`undefined` emits nothing because the protocol has no unknown-capacity state. Invalid data or a
thrown read logs `acp.usage.failed` and sends no replacement. If an earlier measurement was shown,
that is still the last published measurement; the adapter does not fabricate a zero to clear it.
The application must provide a measurement/billing source. No default workspace source is shipped
by this notification binding.

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
is journaled once; restore replays it without re-expanding against changed templates. `SessionOptionsContext.publishCommands(commands)` replaces the complete catalog for the live
session and sends `available_commands_update`; an empty array clears it. Updates during opening
are staged until publication. Invalid catalogs and updates after close are rejected without
changing the active catalog. Already-admitted prompts retain their expanded text. Catalogs are
environment resources rebound on load/resume, not journal data. Commands with direct session
lifecycle effects are not implemented.

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
restored sessions adopt the new manifest ([registry changes](#registry-changes-on-reopen)).

Terminal IDs are operation resources, not journal data. Final command output is an ordinary tool
result and is journaled. The terminal is embedded in its live tool card as soon as creation returns,
using core's operation `toolCallId`. Parallel commands keep separate associations even when IDs
arrive out of order. Final content retains the terminal reference alongside the bounded output;
clients can keep displaying released terminals. Cancellation before creation returns suppresses
embedding but still releases the late terminal. Restore replays durable output without resurrecting
terminal resources or replaying ephemeral IDs.

## Elicitation

Factories receive `SessionOptionsContext.elicitation`, a `ClientElicitation` port whose optional
`form` and `url` methods exist only for explicitly non-null client capability modes. An absent,
null, or empty `clientCapabilities.elicitation` does not imply form support. Ports are bound to the
client connection, live session, and current prompt; they cannot be used during factory setup.
Applications may call them inside ordinary tools, passing the operation signal and optional
`ToolRunContext` to associate the request with its tool card. Tool permission still precedes run.

`form({ message, requestedSchema }, signal, context?)` returns accept/decline/cancel. Accepted
content is checked against the flat ACP schema: strings (length/pattern/format), numbers/integers
(bounds), booleans, single-choice enums, and string multi-selects. Required fields, unknown response
fields, and duplicate selections are checked. Schemas are restricted to supported keywords before
compilation; arbitrary references and nested objects are not forwarded. Defaults remain UI hints,
not fabricated answers. Decline/cancel content is ignored, and invalid accepted content fails the
operation. Forms must request only non-sensitive information, never credentials or payment secrets.
Tool authors decide how a declined/cancelled answer affects their task; it is not an approval.

`url({ message, url }, signal, context?)` returns an action, a lifecycle `signal`, and `complete()`.
The adapter generates a private connection-scoped ID. Accept means consent to open the URL, not
successful completion of the external workflow. Call `complete()` only after verifying the same
user finished that workflow; it sends `elicitation/complete` once to the original client. Repeated,
declined, cancelled, or expired completions emit nothing. No URL response content is returned to the
tool. Use HTTPS (HTTP is allowed only for loopback development); embedded URL credentials are
rejected. Applications must not place credentials, personal data, or pre-authorized access in URLs.
Labkit never fetches or opens them. Hosts own consent and secure browser presentation, and external
workflow owners retain all tokens outside ACP, model context, and journals.

Requests and responses are capped at 64 KiB, forms at 128 fields, messages at 4,096 characters,
and outstanding interactions at 32 per bound session or authentication request. UI waits time out after 120 seconds. Cancellation,
prompt settlement, session close, logout, and disconnect release pending interactions; late replies
cannot settle a cancelled operation. Elicitation exchanges are transient. Only data deliberately
returned as ordinary tool output is journaled; no new core turn phase or input event is introduced.

MCP advertises matching elicitation capabilities and forwards form/URL requests only while that
server has an active tool call. MCP form's omitted mode is mapped to explicit ACP form mode.
Forwarded requests are session-scoped because MCP does not reliably identify the originating tool
among concurrent calls. URL IDs are mapped per MCP connection, and completion notifications map
back to the original ACP ID. Decline, cancel, invalid responses, and RPC failures propagate to the
MCP caller. Unsupported modes do not silently fall back. Existing MCP call deadlines still apply.
This does not implement MCP OAuth. Authentication callbacks can use request-scoped elicitation as
described below.

## Authentication

Applications can supply an optional `AcpOptions.auth` binding with `methods`, a synchronous
`isAuthenticated()` credential-availability check, an `authenticate(methodId, signal, context)` callback for
agent login methods, and an optional `logout(signal)` callback. Exported `AcpAuth` describes this
binding. Credential storage, browser/device-code flows, and interactive login executables belong to
the application. The workspace example continues to use environment credentials and advertises no
login or logout flow. MCP OAuth is separate and remains unsupported.

The third authenticate argument is an `AcpAuthContext` with a capability-filtered `elicitation`
port. Its requests carry the current `authenticate` request ID, with no session or tool-call ID.
This supports login UI before a session exists. The same form validation, URL restrictions,
completion handling, and size limits apply. Forms may collect non-sensitive setup choices; secrets
must use a secure external flow. Missing URL support does not cause a form fallback.

For a browser login, the application calls `context.elicitation.url(...)`, checks the returned
action, then completes and verifies its external workflow using the callback's AbortSignal. Only
after verification should it store credentials and call the handle's `complete()`. Return from the
callback only after the credential store is ready. URL consent alone does not authenticate, and
no credentials may be returned through the UI or written into a URL. The adapter still checks
`isAuthenticated()` before acknowledging success. OAuth providers, callback endpoints, identity
verification, and credential persistence remain application responsibilities.

The request-scoped port closes when authenticate returns, fails, is cancelled, or disconnects.
Completion after that boundary emits nothing; an unanswered UI request receives ACP cancellation.
A callback that ignores cancellation cannot grant late access on that connection. Existing
callbacks accepting only methodId and signal remain compatible.

The adapter copies and validates up to 32 method descriptors (64 KiB total), advertises them in
`initialize.authMethods`, and advertises `agentCapabilities.auth.logout` only when a logout callback
exists. Agent methods have `{ id, name, description? }`. Terminal methods additionally have
`type: "terminal"`, optional `args` and `env`; they are advertised only when
`clientCapabilities.auth.terminal` is true. The host reruns its configured agent command for terminal
login and reconnects afterward. Terminal method IDs cannot be passed to `authenticate`; Labkit does
not launch login commands itself. Descriptors, including terminal environment values, are public
protocol metadata and must not contain credentials.

With an auth binding, unauthenticated requests to create/load/resume/fork/list/delete sessions,
prompt, or change configuration receive ACP `auth_required` before invoking the relevant operation.
Successful `authenticate` requires both callback completion and `isAuthenticated() === true`.
Logout succeeds only after its callback clears credential availability. Login changes and logout
first cancel opening sessions and close this connection's live runtimes and MCP resources. Journaled
sessions remain saved and can be loaded after authentication. Already committed writes and external
tool effects are not rolled back. Cancellation and close remain available after credential expiry.

Credential changes cannot overlap on one ACP connection. Cancellation stops waiting promptly but
keeps the transition locked until the callback settles; late success cannot grant access on that
connection. Failed or cancelled changes leave access denied until a successful login or reconnect.
Callbacks must honor their signal and own cleanup of any credential-store effects. Disconnect aborts
the callback signal. Bind per-connection credential state when isolation is needed; applications
sharing a store across connections own cross-connection revocation. Credentials and authentication
metadata never enter the session journal, and authentication never substitutes for tool permission.

## Run from a host

Create a local configuration module that default-exports `AcpOptions`. Supply the same
`SessionOptions` you use when embedding core:

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

- `initialize`: negotiates ACP v1; declares actual prompt/load/close capabilities. The default launcher uses
  environment credentials; hosts can supply the authentication methods described above.
- `session/new`: creates a journaled session. Each connection owns its loaded runtimes.
- `session/prompt`: admits one active prompt per session and waits for durable terminal settlement.
  Separate sessions run independently; overlapping prompts in one session return an RPC error.
- `session/cancel`: remains responsive during completions, tools, and permission requests. It routes
  abort through core and returns `cancelled` on the original prompt. Idle cancellation is a no-op.
- `session/close`: closes the runtime and cancels owned work; it does not delete persisted data.
- `session/load`: opt-in via `loadSession: true`. The factory receives sessionId and must resolve the
  saved store and validate that cwd belongs to that session. No durable session-to-workspace
  directory is invented by this adapter. Duplicate live loads are rejected. Tool or agent registry
  changes do not prevent loading ([registry changes](#registry-changes-on-reopen)).
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
  The child uses its requested additional roots without changing the parent. Cancellation before dispatch creates no child; cancellation after
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
- `session/set_mode`: alias for the first mode-category selector. Mode and config
  notifications reflect the same committed policy. New/load/resume responses include current
  config options and legacy modes when bindings are provided. Boolean controls require the client's
  `session.configOptions.boolean` capability.
- `session/request_permission`: `allow_once`, `allow_always` (named tool, all arguments, live session), and `reject_once` options, correlated through SDK requests. The core
  operation's AbortSignal cancels the wait even if a client never replies; late allows cannot run tools.

Sessions default to policy `permissions: "ask"`; an explicit factory policy `off` retains unattended
execution. Restored sessions retain their journaled policy. The ACP permission callback replaces any
factory `requestPermission` callback. Existing observe/toolUpdate/streamUpdate callbacks remain
best-effort subscribers. Neither outgoing display updates nor an ACP response certifies a commit.
Both the admitted tool-intent receipt and approval receipt still precede execution.

Prompt responses map completed → `end_turn`, exhausted → `max_turn_requests`, aborted → `cancelled`,
and terminal error classification `permission_refused` → `refusal`. Explicit provider token limits
map to `max_tokens`; provider refusals map to `refusal`. These responses retain the structured
failure in `_meta["labkit.dev/failure"]`. Other provider, tool, storage and malformed-permission
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

New/load/resume connect supplied stdio, Streamable HTTP, legacy SSE, and ACP-proxied MCP servers using `@modelcontextprotocol/sdk` 1.30.1.
Servers run directly (no command shell) with the session cwd, SDK baseline environment, and explicit
ACP environment entries. Provider credentials are not inherited automatically. Server stderr goes
to stderr; stdout belongs to that server's MCP transport. The primary and requested additional workspaces are advertised
through MCP `roots/list`; roots are advisory and do not sandbox an external server process.

The adapter initializes each server, paginates `tools/list`, and freezes the resulting catalog for
the session. Names use `mcp_<server>_<tool>_<hash>` to fit provider limits and avoid collisions. The
catalog is sorted for stable restore manifests. Reopening reconnects and adopts the current tool
schemas; it never reissues recorded calls. Tool-list-change notifications do not mutate a running
session's registry. Sampling, task-only tools, and resource/prompt browsing are not
advertised. Elicitation is forwarded only for explicitly supported client modes.

Experimental MCP-over-ACP accepts `{ type: "acp", name, serverId }` and advertises
`mcpCapabilities.acp: true`. Each session opens its own `mcp/connect` connection, initializes MCP,
and uses the same frozen catalog, schema validation, and permission-gated tool path. Requests and
notifications travel through `mcp/message`; reverse requests such as `roots/list` route to that
specific connection. Unknown connection requests reject, and unknown notifications are ignored.
Unsupported MCP requests still reject through the ordinary MCP client handlers.

Connection IDs and request correlation stay outside the journal. Cancellation maps local MCP
request IDs to the outer ACP request's cancellation, so late replies cannot settle cancelled tools.
Close and failed setup unregister the connection before requesting `mcp/disconnect`, waiting at
most two seconds for acknowledgement. A connect reply arriving after cancellation is also released.
An unresponsive connect request stays observed until the ACP connection closes so a late ID can be
cleaned up. Active connection-ID reuse is rejected without disconnecting the original owner.
Disconnecting ACP leaves remaining remote-resource cleanup to the host; reconnect/load opens fresh
MCP connections and never replays journaled tool calls. This transport remains an experimental SDK
surface, distinct from the ACP stdio transport used to launch Labkit.

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

## Additional workspace roots

The workspace example advertises `sessionCapabilities.additionalDirectories`. New/load/resume/fork
accept up to 32 absolute `additionalDirectories`. Each request supplies the complete active list;
omitting it or passing an empty list activates only the primary cwd. A load, resume, or fork can
select different additional roots while retaining the session's primary cwd. Fork changes apply
only to the child, including when the parent is restored privately. Custom factories opt in with
`AcpOptions.additionalDirectories: true` and receive a frozen list in `SessionOptionsContext`.

Relative file paths resolve against the primary cwd. Absolute paths may address any allowed root.
The example canonicalizes and deduplicates roots, includes their paths in tool descriptions, and
uses the same checks for resource-link ingestion. Every root's `.labkit` subtree remains reserved,
including when roots overlap; roots inside another root's reserved subtree are rejected. Local
symlink, hard-link, traversal, size, and cancellation checks still apply. Client-delegated file
access retains lexical checks, with client-owned resolution. MCP roots are advisory, not a process
sandbox. Terminal commands still start in the primary cwd.

Journal and blob storage stay under the primary cwd. `session/list` reports the last successfully
bound canonical additional-root list, including after process restart. Scope metadata is separate
from journal records; no journal version changes. Old stores without scope metadata report none.
The example writes scope before returning a successful lifecycle response and removes it on session
deletion. Removing a root prevents new file access but does not remove previously journaled blobs.

`AcpSessionOptions.onReady(sessionId, signal)` optionally persists host metadata after runtime
initialization and configuration validation, before visible publication. It is not called for a
private fork-parent restore. A failed or cancelled hook closes the unpublished runtime; an already
committed journal or metadata write cannot be rolled back. Hooks must honor cancellation and avoid
late writes after cancellation. This lifecycle gate differs from best-effort `sessionInfo` display
notifications, which never delay execution.

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
Each `AcpConfigBinding` declares `id`, `name`, optional `category`/`description`, and a pure
`current(policy)` selector. Select bindings have `options` (`value`, `name`, optional `description`,
and a `PolicyPatch`), or groups (`group`, `name`, `options`). `options` may instead be a function
of the policy in effect that returns either form; it is resolved and validated whenever the adapter
reports configuration or applies a choice, so choices can follow the current model. Values must be unique across
all groups; groups and individual values cannot be mixed. Group, value, and control `_meta` data
is preserved. `selectChoices(binding, policy)` exposes flattened choices for application logic. Boolean bindings declare `type: "boolean"`, return a boolean from `current`,
and provide `patches: { true: PolicyPatch, false: PolicyPatch }`.
The selector must derive its value from the policy in effect (`SessionRuntime.policy`, which
includes any pending registry reconciliation). If that value is not a declared option, the adapter
appends it as an extra choice, `{ value, name: "<value> (saved)", description }`, in a
`labkit-saved` group for grouped selectors and in `availableModes` for the mode selector. It logs
`acp.session.config.unlisted_value` (info) with `configId` and `value`. Selecting that value again
is a no-op; any other choice commits its patch.
Do not keep a separate mutable selection. Each patch must produce its corresponding selected value.
Bindings are copied at session opening, while callbacks remain executable host resources. They are
never written to the journal. Core validates tool/provider capability restrictions on each patch.
The first select binding with `category: "mode"` also exposes the legacy mode API. Later
mode-category controls remain in the ordered configuration list. Applications without config
bindings retain their existing new/load/resume response shapes.

Boolean controls are exposed only when the client advertises
`clientCapabilities.session.configOptions.boolean: {}`. Their update requests require
`type: "boolean"` and a boolean `value`. Older clients do not receive those controls; hiding a control
does not reset its journaled value. Boolean controls have no legacy mode alias. The workspace example
offers a Stream responses toggle to capable clients; its initial value remains enabled.

The adapter sends `config_option_update` after committed state changes and `current_mode_update`
when the selected mode changes. A response means the journal accepted the policy update, not merely
that a display event was emitted. The initial agent manifest model remains unchanged by a policy
selection, so a session that selected an alternate model reverts to the live default only if the
relaunched binding no longer serves that model.

## Registry changes on reopen

Core compares the saved tool/agent registry with the one the factory supplies now. Any difference
is accepted: added, removed or changed tools, changed parameters, added or removed agents, changed
agent fields, and changed order. Load and resume succeed and replay the saved history unchanged.
Opening writes nothing new; the adapter logs `acp.session.registry_pending` (info) with the
`differences`. The first later prompt, policy change or fork first commits a `configuration` journal
record with the live registry. Replay still checks earlier turns against the registry they used.
If the saved policy names removed tools or a model the live binding no longer serves, or the current
agent was removed, the same record carries the adjusted policy or the live default agent; core logs
each adjustment. Selectors and the load response already show the adjusted policy.

Saved history is a record of what happened and is never filtered or rewritten. The next completion
request contains all prior messages, including calls to tools that are no longer registered and
their results. Only the live tools are advertised to the model.

## Explicit limits

This is an ACP v1 **session subset**, not a claim of full protocol conformance. Text, resource-link, image, audio, and embedded-resource
prompts are accepted. Local `file://` links and paths inside the session workspace roots are read through the
workspace path checks and stored with `putBlob` in that session before admitting the user input.
The journal contains attachment refs, never file bytes. Outside paths are rejected without reading
them. Non-file URLs remain textual references; the adapter never fetches them. Cancellation during
ingestion admits no user turn (an unreferenced blob may already have been stored).

Local attachments retain the 8 MiB blob cap. Extensions select markdown, PDF, PNG, JPEG, or UTF-8
plain text; the bound provider must support the selected media. Accepted text attachments are sent in full within the blob limit; oversized model context
is reported as a provider failure rather than silently substituted content. Attaching a local resource is an explicit user input and does not create
a tool permission request. Model-initiated file access still uses the permission-gated tools.
Image, audio, and embedded-context capabilities are advertised. PNG/JPEG image data and embedded binary
resources (PNG/JPEG/PDF or UTF-8 plain text/markdown) require canonical base64 and the same 8 MiB
raw-byte cap. Binary resources require an explicit supported MIME type. Embedded text is stored
as markdown when declared `text/markdown`, otherwise as plain text, including source-code MIME
types. Embedded URIs are labels only: supplied bytes can represent unsaved or outside-workspace
content, and no file read or URL fetch occurs. Blob refs, not content bytes, enter the journal.
Provider media support is checked before storage/admission; attachments require a bound provider
profile. Custom completion ports without a provider registry cannot resolve attachment media. Audio blocks require a declared supported audio MIME type and canonical base64 within the same
8 MiB cap. Google bindings encode them as native audio; bindings without audio support reject
before storage/admission. Local audio file links use the declared audio MIME type or a recognized
extension. Reload displays the saved audio reference without invoking a model; a new prompt can
resolve the saved bytes. Audio playback in the installed editor still needs verification.
Embedded text resources follow the same full-content rule.

Client-supplied stdio, HTTP, SSE, and ACP-proxied MCP servers are supported. MCP OAuth, cross-provider switching,
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
[authentication](https://agentclientprotocol.com/protocol/v1/authentication),
[elicitation](https://agentclientprotocol.com/protocol/v1/elicitation),
[filesystem](https://agentclientprotocol.com/protocol/v1/file-system),
[terminals](https://agentclientprotocol.com/protocol/v1/terminals),
[plans](https://agentclientprotocol.com/protocol/v1/agent-plan),
[commands](https://agentclientprotocol.com/protocol/v1/slash-commands),
[prompt turns](https://agentclientprotocol.com/protocol/v1/prompt-turn),
[TypeScript SDK](https://agentclientprotocol.com/libraries/typescript),
[MCP-over-ACP wire reference](https://agentclientprotocol.github.io/rust-sdk/protocol.html).

## Diagnostic event coverage

ACP runtime diagnostics use the `labkit.acp` category. Session opening records carry a
connection ID, initiating `rpcRequestId`, session ID, cwd, provider version, restored revision,
registry state (`current` or `pending_adoption`), and elapsed time. `acp.prompt.*`
joins incoming requests to admitted turns and terminal outcomes; `acp.config.*` distinguishes
waiting for the active prompt from a committed policy revision. A failed load records its original
error and cause chain, rather than only the translated RPC error. `acp.session.registry_pending`
(info) records registry differences on open; core logs `session.registry.adopted` when the live
registry commits.

`acp.permission.waiting` includes the absolute target paths, tool-call ID, offered option IDs,
and originating prompt RPC ID. `acp.permission.resolved` records the actual selected option and
wait duration; cancellation and client errors are separate events. A wait without a terminal event
identifies an unanswered client permission request. RPC IDs are connection-local; always retain
`connectionId` when following them. Tool IDs link ACP updates to core host operation events.

`client_file.*`, `client_terminal.*`, and `elicitation.*` report remote waits, timeouts,
validation failures and cleanup outcomes. `mcp.*` records connection setup, catalog pagination,
remote calls and cleanup, including server identity and operation correlation. `prompt.ingest.*`
and `attachment.*` identify the block/stage that failed and record resolved paths, media, sizes,
and stored blob refs. Workspace file events correlate each local effect with an `operationId`,
absolute path, cwd, tool-call ID and elapsed time; that tool-call ID joins the surrounding host session context.
SQLite diagnostics preserve the database path, session/append identity and underlying storage
error, including indeterminate outcomes that require reconciliation.

Display metadata and subscriber failures remain non-authoritative, but now emit warnings instead
of silently disappearing. These logs do not certify a journal commit. Routine events omit file,
prompt, output and form-answer contents; errors retain causes with credential values redacted.
Inspect runtime instrumentation in tests with:

```sh
LOGTAPE_TEST_MODE=always LOGTAPE_TEST_LOWEST_LEVEL=debug bun test packages/acp
```
