# Host protocol

A host is the program that launches this runtime, shows its work and approves its actions: an editor, a
review tool, another agent. The runtime should speak one known host protocol rather than invent one.
The Agent Client Protocol (ACP, agentclientprotocol.com) is the first to implement: it is a published
JSON-RPC standard, JetBrains Air already drives agents with it, and its central message carries exactly
what this runtime already holds at the moment a tool call is decided.

## The protocol surface that matters

Two notifications and one request, from the ACP specification:

- `session/update` with `sessionUpdate: "tool_call"` reports a tool invocation. Required: `toolCallId`,
  `title`. Optional: `name` (the tool's programmatic name; agents should include it in the first report),
  `kind`, `status`, `content`, `locations`, `rawInput`, `rawOutput`.
- `session/update` with `sessionUpdate: "tool_call_update"` carries only changed fields; everything but
  `toolCallId` is optional.
- `session/request_permission` asks the host to approve a tool call before it runs: `sessionId`,
  `toolCall`, and `options`, each option an `optionId`, a `name` and a `kind` of `allow_once`,
  `allow_always`, `reject_once` or `reject_always`.

`kind` is one of `read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`, `switch_mode`,
`other`. `status` is one of `pending`, `in_progress`, `completed`, `failed`. A location is
`{ path: string, line?: integer }` with an absolute path.

## What a host does with it

Read from Air's logs on 2026-09-23 (`~/Library/Logs/JetBrains/Air/air.log`, three days of work on
this repository):

- Air's `AcpAgentFrontend` records every tool call as it is reported: `ToolCall(toolCallId=exec-bf9b…,
title="Read file '…/docs/code_review.md'", kind=READ, status=IN_PROGRESS,
locations=[ToolCallLocation(path=…)], content=[])`, then the same id with `status=COMPLETED`.
- A task is a UUID with `launch_type`, an `AgentId` (`codex` in the log) and a permission mode
  (`ManualApproval`). Its lifecycle in the log: `task.draftCreated` → tool calls → `task.stateChanged:
startState=Launching, endState=Finished, execTime=241548ms`.
- "Files in scope" is not a record Air keeps. It is the union of `locations` reported by the task's tool
  calls. The agent reads the file itself, on the operating system; what passes through the host is the
  declaration.
- The file-system daemon (`fsdaemon`, Fleet's native indexer) is not in that path. Its RPC surface in
  the same three days was `buildIndex`, `manage` and `reloadEnv` on index providers; it runs `git status`
  through the git CLI per project root and streams count-based deltas
  (`new_status.size: 35, old_status.size: 61, diff_size: 26`), sending nothing when unchanged. It knows
  what changed on disk; the tool-call declarations say who did it. The two are independent sources.
- Not observed in the log: what a task hands to review when it finishes (no diff, changeset or commit
  record at `Finished`); `checkpoint` and `snapshot` appear but never as lifecycle records.

## What the runtime implements today

`packages/core/host/host.ts` and `ports.ts`. `createHost(bindings, sinks)` is an execution adapter:
`dispatch` runs the conversation's turn commands (`prepare_model`, `complete`, `prepare_handoff`,
`run_tools`, `cancel`) through operation actors and a tool batch. Three sinks report back: `turn` posts
typed `TurnEvent`s; `tool` posts a `HostToolOutcome` — `turnId`, `batchId`, `callId`, `result` — for
each tool call **after it has run**. Optional `toolUpdate` emits non-authoritative display
notifications before execution and on operation transitions. That outcome is held in `pendingTools` until the caller invokes
`releaseTool(outcome)`, which passes it to the batch as `tool_settled` through the `toolFailure` policy
(`fail-turn` or `return-error-and-continue`). `close()` cancels everything held. `ExecutionContext.
allowedTools` narrows which tools a completion may be admitted with, per turn.

Against ACP, that is: the outcome carries what a `tool_call_update` with `status: completed | failed`
and `content` needs; `releaseTool` is a host-side hold on a result the agent has already produced,
which ACP has no message for; `allowedTools` is a standing allow-list per turn, the effect of
`allow_always` decided before the turn rather than per call. `defineTool` carries `description`, an
input schema, its JSON Schema and `run`, plus optional `kind` and `locations(parsedArgs)`.

The toolUpdate sink reports `tool_call` at spawn with pending status, name/title, kind and rawInput.
After input validation, a `tool_call_update` supplies locations before execution. Running maps to
in_progress; output validation stays in_progress; succeeded maps to completed, and failed/cancelled
map to failed. Terminal updates carry normalized result text or an error as rawOutput. Notifications
include correlation fields and use the operation child ID as toolCallId to avoid batch-local call
ID collisions. Fields that have not changed are omitted from updates.

The sink is available through both public runtimes and is captured at construction. It never
certifies a journal commit or releases tools. Observer failures are isolated; no updates are
replayed on restore. Invalid location metadata is diagnostic only and does not change execution.
See [host contract](../packages/core/host/README.md#tool-display-notifications).

## What is not implemented

- **No `session/request_permission`.** The only gate is after execution (`releaseTool`). A pre-execution
  gate is a phase between admission of a `tools` completion and `run_tools`: the batch does not start
  until the host's option arrives, and `reject_*` becomes a batch outcome the turn records. It is not a
  variant of `releaseTool`, because by then the effect has happened.
- **No JSON-RPC transport.** The sinks are in-process callbacks; an ACP host needs them serialised as
  `session/update` notifications and the permission request as a call.

## The context surface

Once a `tool_call` is emitted before the effect, the pre-tool context surface is a subscriber rather
than a special case: keyed on the event's `locations`, it looks up what is recorded about those paths
and returns it to the turn as context before the tool result. The lookup is a read of a store, not a
model call, and nothing in the prompt asks the agent to remember anything. The notification prerequisites now exist, but the lookup integration does not exist yet. Measured on the same file with two stores (exo-ledger,
`tools/hindsight/FINDINGS.md` §11–12): a file-keyed read of settled and contested positions changed an
agent's proposal; a file-keyed read of session narration did not.

## Order of work

1. **Implemented:** `kind` and `locations` in `defineTool`.
2. **Implemented:** `tool_call` on spawn and `tool_call_update` from operation-actor transitions,
   as the third, non-authoritative sink beside `turn` and `tool`.
3. **Next separate slice:** streaming as a fourth sink, profile streaming support and transport
   assembly. Enable policy stream:true only after that sink exists. Decode one assembled body and
   retain one model_settled outcome; incomplete streams fail/cancel without partial settlement.
4. `request_permission` as a new phase between admitted tools and run_tools.
5. A JSON-RPC ACP adapter carrying notifications and permission requests across the process boundary.

These core slices are sequential because they share the host, ports and sink list. Attachment
preview is independent UI work: journaled BlobRefs plus getBlob already support markdown/image/PDF
rendering. Tool file scope comes from locations, not attachment chips. Mode switching and a host
file-system daemon remain unimplemented.
