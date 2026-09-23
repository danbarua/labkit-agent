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

## Where this runtime already has it

`agent-runtime.ts`, `execute`, `case "run_tools"`: the batch machine's `spawn_tool` command carries
`call.id`, `call.name` and `call.args` before `tool.run` is invoked. That is an ACP `tool_call` minus
`kind` and `locations`. The operation actor's states map onto ACP status: ready and validating input to
`pending`, running to `in_progress`, succeeded to `completed`, failed and cancelled to `failed`, with
`content` carrying the validated output on completion.

What is missing is small and belongs in `defineTool`: a tool declares its `kind`, and how to derive
`locations` from its parsed input (which arguments are paths). With that, the decision that admits a
`tools` completion can emit one `tool_call` notification per call before any tool runs, and each
operation actor's transitions emit `tool_call_update`. `session/request_permission` is a phase between
admission and `run_tools`: the batch does not start until the host's option arrives, and `reject_*`
becomes a batch outcome the turn records.

## The context surface

A host protocol makes the pre-tool context surface a subscriber rather than a special case. The
`tool_call` event, emitted when the agent has decided and before the effect, carries `locations`; a
subscriber keyed on those paths can look up what is recorded about them and return it to the turn as
context before the tool result. The lookup is a read of a store, not a model call, and nothing in the
prompt asks the agent to remember anything. Measured on the same file with two stores (exo-ledger,
`tools/hindsight/FINDINGS.md` §11–12): a file-keyed read of settled and contested positions changed an
agent's proposal; a file-keyed read of session narration did not.

## Non-goals for a first implementation

Streaming text updates, `switch_mode`, and the host's own file-system daemon. The first implementation
is: `tool_call` and `tool_call_update` on every tool call, `request_permission` before a batch, and
`locations` derived from tool definitions. That is enough for Air to drive the runtime and see its scope,
and for the context surface to exist.
