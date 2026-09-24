# Session tests as executable examples

Start with [usage.ts](usage.ts). It shows the exported package API with explicit configuration,
a local completion port, typed tool definitions, permission handling, and close/restore. Read
`conversationUsage` first, then `toolUsage`: admission means the input was persisted; settlement
means the turn finished. The host runs the tool loop. The caller does not implement another loop.

Run just those examples:

```sh
bun test packages/core/session/session-fixtures.test.ts -t usage-
```

Each test prints its scenario name and purpose. Open
`.session-artifacts/examples/v2/usage-conversation-and-restore/README.md` for the executed checks,
conversation, and links to logs and raw evidence. Run the complete inspector with:

```sh
bun run packages/core/session/fixture-runner.ts
bun run packages/core/session/fixture-runner.ts --v2
```

Start with `.session-artifacts/latest/README.md` or `.session-artifacts/latest-v2/README.md`.
The runner fails if any scenario or assertion fails, after writing its evidence. A **PASS** for a
refusal or failed-append example means the expected refusal/failure was observed; it does not
claim the user turn completed successfully.

## Where the design intent lives

| Source                             | Questions it answers                                                                               |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| [usage.ts](usage.ts)               | How do I configure, prompt, approve tools, close, and restore a session?                           |
| [conversation.ts](conversation.ts) | What happens on a second input, handoff, policy change, or exhausted allowance?                    |
| [tools.ts](tools.ts)               | What does approval gate? What happens when a tool fails or finishes after cancellation?            |
| [persistence.ts](persistence.ts)   | What happens when storage rejects an append, loses a receipt, or work is interrupted?              |
| [branching.ts](branching.ts)       | What is inherited, replaced, or excluded when a child session is published?                        |
| [providers.ts](providers.ts)       | How do attachments, continuations, provider switching, and streaming affect requests and journals? |

Every scenario has a purpose and explicit checks in its body. `f.action` labels an action about
to be attempted; it does not certify success. `f.check` compares observed and expected values,
records the named result, and throws on failure. No assertion is inferred from a log message.
Use direct public session calls in new examples. Do not add an operation enum or interpreter.

## What is real and what is simulated

The session runtime, host, policies, codecs, reducers, receipt gates and provider profiles are
real. `support.ts` supplies deterministic IDs, process-local memory persistence, scripted
completion/permission responses, and controllable deferred work. Provider examples exercise
real encode/transport/decode against canned responses in `wire-responses.ts`; they do not call
external services. For production, supply your persistence adapter and provider bindings. These
examples do not prove disk durability or compatibility with a live provider deployment.

Historical regression examples use agent IDs `a` and `b` to preserve exact evidence; reports
name them Primary assistant and Handoff specialist. Their echo tool returns its input.
`defer:name` pauses a tool until `f.release(name)`; `error:message` throws the scripted error.
Those are test-double controls, not runtime tool features. The introductory examples define
their own descriptive agent and tool names without those controls.

## Evidence versus explanation

- Scenario `README.md`: intent, setup, attempted actions, executed assertions, and outcome.
- `transcript.md`: readable committed conversation, tool calls/results, permissions, and recovery.
- `diagnostics.log` / `diagnostics.jsonl`: actual runtime events, joined by session/turn/child IDs.
- `evidence/`: exact requests, outputs, snapshots, journals, assertion values, and ID mappings.
  Its README defines every file and the pre-cleanup capture boundary.

The original JSON baselines remain migration/regression evidence. The runner compares requests,
results and durable states (which include journal records); it ignores their old `inputs`
metadata. New introductory examples use named assertions. Human formatting has focused tests
rather than a second copy of every scenario as approved Markdown.

When adding a scenario, explain the guarantee, show the public calls, assert the meaningful
outcome and side effects, and read its generated report. Cover failure as well as success when
it changes the contract. If demonstrating a feature requires reaching around a public boundary,
raise that contract limitation before introducing a workaround.
