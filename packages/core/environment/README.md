# Bind a session to an application

The environment owns resources that outlive a single turn: event sources, rendering, credentials,
storage, and diagnostic sinks. Core owns the execution loop. An application should translate user
intent into session events and display their outcomes, not poll turn phases to decide when to call
a model or execute a tool.

## Keep the input channel open during work

`startEnvironment(options, environment)` creates a session; `runEnvironment(session, environment)`
binds an existing or restored one. An `Environment` provides an `AsyncIterable<EnvEvent>` and a
renderer. The loop waits for admission, not terminal settlement, so it can read abort/replacement
input while a model or tool is active.

Render updates distinguish snapshots, receipts, and settlements. Use receipts to show accepted
input and settlements to show how work ended. A branch settlement carries the published child;
switch the UI to that session if desired rather than copying its state into another execution loop.

Source exhaustion closes the session and cancels outstanding work. A generator that yields one
prompt and returns is therefore not “ask and wait for the answer.” Keep the source open until its
matching settlement arrives. An explicit close event has the same lifetime consequence. Closing a
session does not close caller-owned persistence or global logging.

## Retained provider traffic

Use full capture when you need to inspect exactly what reached a provider, especially malformed
JSON or a truncated stream. The journal records admitted runtime data; it cannot substitute for a
raw response that failed admission. Diagnostic logs retain causes, identities, and the full ordered system messages in
`completion.system_prompt` at DEBUG. Complete user/file bodies and provider responses require capture.

```ts
import { createProviderCapture } from "@labkit-agent/core/environment/provider-capture";

const run = await createProviderCapture(".session-artifacts/my-run");
// Put run.capture in each provider's transport.capture binding.
// After all owned sessions/requests have settled or closed:
await run.flush();
console.log(run.directory); // Open README.md and manifest.json here.
```

Every call gets linked request/response files and a report of model, counts, byte sizes, and repeated
message content. Requests are saved before dispatch; response text is retained before JSON parsing,
and partial SSE text is retained as it arrives. Each run has a unique directory, so a failed run
cannot inherit an earlier success report. Configured credential values are redacted. Files are
replaced by rename after a complete temporary write; a process stopping mid-write does not truncate
the previously saved file. A forced-termination test verifies retained request, partial response,
manifest, and logs without graceful shutdown. This is a process-failure guarantee, not a power-loss
fsync guarantee. An interrupted call remains labeled in progress when no terminal event was observed.

Bind the same capture to model transports used inside tools and pass their `ToolRunContext`
correlation. This distinguishes a growing coordinator history from independent extraction calls.
Scripted completion-port invocations are labeled separately: they do not establish HTTP evidence.

`createProviderCapture` retains full content until the application removes it; choose quotas and
retention for a one-off diagnostic run. A capture write failure fails the operation instead of
claiming evidence was retained. This is intentionally stronger than best-effort diagnostic
logging. Configure [bounded lifecycle logs](../logging/README.md) separately; those remain
necessary when capture is disabled.

### A long-running launcher's side-car trace

`openHttpTrace(root, options?)` is for a process that opens many sessions over its lifetime, such
as the ACP workspace launcher or the web server. `root` must be an absolute path (it is also
`resolve()`d; a relative path, including `.`, throws) — never trust an environment variable's
value as a directory to prune blindly. It prunes recognized capture run directories under `root`
beyond the newest `options.keep` (default 20, mirroring the ACP launcher's own log retention),
skipping any run whose name embeds a still-alive process ID, then starts one fresh run: a
directory holding `manifest.jsonl`, one JSON line appended per request/response event, never
rewritten, so recording a call costs one append rather than a rewrite of every call recorded so
far. Bind its `capture` to every provider's `transport.capture` for that process; every session
opened from it shares the current run until it rotates to a fresh directory after
`options.maxCalls` calls (default 2000) or once its manifest would exceed `options.maxBytes`
(default 64 MiB), pruning old runs again at each rotation. Only directories `pruneProviderCaptures`
recognizes as capture runs (a run-shaped name, a directory, holding `manifest.json` or
`manifest.jsonl`) are ever candidates for removal; anything else under `root` is left untouched.
Call `pruneProviderCaptures(root, keep)` directly to reclaim space without opening a new run. See
the [ACP launcher wiring](../../acp/README.md#find-an-operational-failure) for the
`LABKIT_HTTP_TRACE_DIR` environment variable that gates this in the shipped launcher.
