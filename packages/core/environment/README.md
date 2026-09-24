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
raw response that failed admission. Normal diagnostic logs retain causes and identities but omit
complete prompt/file bodies.

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

This Bun disk sink retains full content until the application removes it. Choose quotas and retention
for that workload; no implicit pruning is supplied. A capture write failure fails the operation
instead of claiming evidence was retained. This is intentionally stronger than best-effort diagnostic
logging. Configure [bounded lifecycle logs](../logging/README.md) separately; those remain necessary
when capture is disabled.
