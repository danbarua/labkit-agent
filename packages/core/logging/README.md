# Operational logging

Core uses LogTape across environments: Bun, browsers, and other supported JavaScript
runtimes. The environment configures it; importing core does not configure logging.
Without configuration, diagnostics are silent. No session owns a sink or resets logging.

Use the exports from this directory's index.ts (or LogTape directly) at the environment
entry point:

```ts
import { configure, getConsoleSink, reset } from "@logtape/logtape";

async function setLogging(verbose: boolean) {
  await configure({
    reset: true,
    sinks: { console: getConsoleSink() },
    loggers: [
      { category: ["logtape", "meta"], lowestLevel: "warning", sinks: ["console"] },
      { category: ["labkit"], lowestLevel: "info", sinks: ["console"] },
      {
        category: ["labkit", "persistence"],
        lowestLevel: verbose ? "debug" : "warning",
        sinks: ["console"],
        parentSinks: "override",
      },
    ],
  });
}

await setLogging(false);
await setLogging(true); // Existing loggers use the new configuration.
// At environment shutdown, after sessions have closed:
await reset();
```

Serialize configuration changes in the environment. Configuration is global to the
LogTape instance, so applications using other LogTape libraries must include their
categories in the same configuration. Reset disposes disposable sinks: create fresh
resource-owning sinks when reconfiguring, and never reuse a disposed stream. A single
session closing must not dispose environment resources.

## Destinations and levels

A logger can list multiple sink names. Each sink receives a structured LogRecord.
Use getConsoleSink for interactive output, getStreamSink with getJsonLinesFormatter
for a WritableStream of JSONL, or a custom sink for a UI buffer or test capture.
File and OpenTelemetry adapters can be bound by the environment when needed; core
does not import filesystem APIs or select file locations.

Sink inheritance is explicit: parentSinks: "override" makes a category's routing and
threshold independent of the parent. lowestLevel: null disables a category.
For example, keep session logs at info while routing host debug logs to a bounded
UI buffer. Bound custom buffers and choose a dropping/backpressure policy in the
environment; do not let an unbounded capture accumulate during a long experiment.

Custom sinks must implement LogTape's synchronous Sink interface. Use fromAsyncSink
for asynchronous destinations; do not pass an unwrapped async function as a sink.
The diagnostic helper catches synchronous logging failures. Diagnostic delivery is
best effort and does not gate a command or certify a commit.

## Event contract

- session: admission receipts, observed state, terminal settlement, stop, restore,
  recovery, and uncertain-append reconciliation.
- host: command dispatch, operation start/settlement, cancellation requests, and
  tool-result release after persistence.
- persistence: append/load attempts, classified outcomes, revision and append identity.
- provider: completion child start/settlement, including injected non-HTTP completions.

Debug carries routine operation detail. Info carries terminal/session lifecycle
events. Warning carries failed children, unsuccessful storage outcomes, reconciliation,
and recovery. Error reports failed session status/admission.

Structured fields include sessionId, turnId, childId, appendId, requestId, batchId,
callId, revision, expectedRevision, operation, outcome, status, and count where available.
Host command dispatch links turnId to childId; standalone agent hosts may omit sessionId.
Identifiers are caller supplied and must not encode secrets.

Only explicit scalar metadata is emitted. No snapshots, prompts, user/system text,
tool arguments/results, credentials, URLs, raw errors, or provider bodies are logged.
This is an allowlist at call sites, not a general-purpose redaction engine.

Logs run in adapters/runtime command handlers, outside pure decision functions.
They are not the durable journal, do not enter policy or restored state, and may
be dropped. Existing journal fixtures remain the behavioral contract.

Tests use in-memory LogTape sinks to verify runtime reconfiguration, routing, sink
failure isolation, shared lifetime, correlation, and payload exclusion:
```sh
bun test packages/core/logging
```
