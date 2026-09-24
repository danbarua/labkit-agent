# Operational logging

Logs explain why work stopped; the journal establishes what committed; provider captures show what
was actually sent and received. Use the evidence appropriate to the question. A log line cannot
release a persistence gate, and a journal cannot contain a response rejected before admission.

Configure LogTape once in your launcher before creating sessions. Without configuration, core's
diagnostics are silent. Logging belongs to the environment because several sessions can share a
sink: closing one session must not dispose the others' evidence. The logging helpers are portable;
the core package as a whole has a Bun runtime contract.

## Investigate a stopped turn

Start with the public terminal failure's operation identity and cause. Find that session/turn/child
in the durable log. A WARNING/ERROR-only scan should explain the exception itself; INFO/DEBUG adds
the sequence. `permission.waiting` means a user decision is outstanding, `tool.awaiting_release`
means a result is awaiting its runtime gate, and `child.timed_out` names an expired limit. Treating
all three as “still running” would send an operator to the wrong component.

For HTTP or parse failures, follow the provider request ID and operation into an opt-in
[traffic capture](../environment/README.md#retained-provider-traffic). Do not reconstruct a supposed
HTTP request from projected journal messages: encoding, streaming, and response failure matter.
The ACP CLI already writes rotating logs under `~/.labkit/logs`; see its
[retrieval and retention settings](../../../docs/vscode-acp.md#runtime-diagnostics).

## Configure delivery

For an embedded development process, a console sink is enough to inspect the events. A launched
agent also needs a bounded durable sink, a documented location, and retention. This example only
illustrates routing; it does not supply that production storage:

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

Severity must support a warning/error-only investigation. `permission.decided` stays Info for
all valid choices; `permission.refused` is a separate Warning identifying the intervention:
`decision=reject_once`, `reasonCode=permission_refused`, `operation=tool_execution`,
`outcome=blocked`, tool name/kind, arguments, locations, blocked batch size, and correlation IDs.
It reports a refusal received through the permission port, not a durable journal receipt or a
claim that the tool ran. Refusals remain distinguishable from cancelled permission dialogs.

`turn.settled` is Warning only for a failed agent turn. Completed, aborted, and exhausted turns
are Info; expected negative test scenarios use the same production severity, not a test-specific
threshold. The failed-turn record names the operation and agent, explains the failure in `message`
and `reason`, retains `error`, and identifies the triggering event and child when available.
A refusal warning records the intervention; the subsequent failed-turn warning records its
committed consequence. Join them by session/turn/child IDs. Do not suppress the category to hide
an unexplained warning; make the cause and scope legible on the warning itself.

### Common fields and correlation

Use the same field name for the same identity across modules. Include identities that
exist at that boundary; omit unavailable values rather than inventing placeholder IDs.

| Field                          | Meaning and join                                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sessionId`                    | Durable conversation identity; joins ACP, session, host and provider records.                                                                                            |
| `turnId`                       | Core turn identity within the session; joins preparation, completion, tools and settlement.                                                                              |
| `childId`                      | Host operation identity; links command dispatch, provider transport, cancellation and child settlement.                                                                  |
| `batchId`, `callId`            | Core tool batch and model-supplied call identities. Keep the batch/child context: a raw call ID alone need not be globally unique.                                       |
| `toolCallId`                   | ACP tool identity exposed to the client; joins tool cards, permission requests and delegated client operations. Do not substitute a raw `callId` for this identity.      |
| `requestId`                    | Core submission/admission request identity; joins receipt and append handling. It is not an HTTP or ACP request ID.                                                      |
| `appendId`                     | Stable persistence attempt identity; joins append, receipt and uncertain-append reconciliation.                                                                          |
| `rpcRequestId`                 | ACP JSON-RPC request identity, scoped to `connectionId`; distinct from a core submission.                                                                                |
| `httpRequestId`                | Locally assigned provider HTTP attempt identity; joins transport start, response, decode and failure.                                                                    |
| `providerRequestId`            | Provider-assigned response/request identity, when returned; retain it for provider support and server-side investigation.                                                |
| `connectionId`                 | Adapter connection identity; disambiguates reused JSON-RPC request numbers and connection lifetime.                                                                      |
| `durationMs`                   | Elapsed operation time in milliseconds. Use this name consistently, not `elapsedMs`; timeout limits remain `timeoutMs`.                                                  |
| `revision`, `expectedRevision` | Observed and requested journal positions; diagnostic observations do not certify persistence.                                                                            |
| `error`                        | Nested `diagnosticError(error)` object: `name`, `message`, `stack`, `code`, `cause`, and available custom metadata. Do not spread these into top-level lifecycle fields. |

An ACP prompt record connects `connectionId`/`rpcRequestId` to `sessionId`; session
admission connects that session to its core `requestId` and `turnId`. Host dispatch
connects `turnId` to `childId`; provider records connect the child to `httpRequestId`
and any `providerRequestId`. Tool records connect core batch/call identities to
`toolCallId`. These are joins, not interchangeable names for one universal request ID.
Standalone agent hosts may omit `sessionId`. Identifiers must not encode credentials.

Add `operation`, `outcome`, `status`, `reason`, provider/profile version, configuration,
limits and counts where they explain the lifecycle event. Preserve the actual failure
cause under `error`; a status or generic message is not a replacement for that cause.

Use `diagnostic(category, level, event, fields)` with a stable event name and structured
fields. Each record has `properties.event`; its human message renders those same fields,
so the default test reporter does not discard correlation or failure details. Supply
`message` or `reason` to explain a decision or wait, not only an event label. Avoid
repeating complete snapshots or successful response bodies on every transition.

Use `diagnosticError(error, secretValues?)` to preserve error names, messages, stacks,
nested causes, codes and custom provider metadata. `redactDiagnostics(value,
secretValues?)` replaces credential fields (API keys, authorization, passwords and
credential tokens), recognizable credential text, and supplied exact secret values.
Transport adapters must pass configured API key values when a provider may echo them
in a free-text error. Paths, provider error explanations, request IDs, token usage,
limits and timings remain intact. Routine success events need no prompt or file body;
this is not permission to suppress error evidence. Cycles are explicitly marked.

`diagnosticContext(category, fields)` returns an immutable, explicitly bound logger
function with signature `(level, event, extraFields?)`. Pass session and operation
context across async boundaries; no global mutable current-session context exists.
All helpers are browser-compatible and do not configure sinks.

Logs run in adapters/runtime command handlers, outside pure decision functions.
They are not the durable journal, do not enter policy or restored state, and may
be dropped. Existing journal fixtures remain the behavioral contract.

Tests use in-memory LogTape sinks to verify runtime reconfiguration, routing, sink
failure isolation, shared lifetime, correlation, and targeted credential redaction:

```sh
bun test packages/core/logging
```

## Inspect logs from tests

Tests and reusable contract suites import Bun-compatible helpers from
`@logtape/testing-bun/autoload`. It configures async-local capture automatically;
no application logger setup or Bun preload is required.

```sh
# Default: show info-and-higher records only for failing tests.
bun test

# Show captured debug-and-higher records for every test.
LOGTAPE_TEST_MODE=always LOGTAPE_TEST_LOWEST_LEVEL=debug bun test
bun run test:with-logs

# Limit the run using ordinary Bun test arguments.
bun run test:with-logs packages/core/session/provider-runtime.test.ts

# Suppress captured logs, including for failing tests.
LOGTAPE_TEST_MODE=never bun test
```

Modes are `on-failure` (default), `always`, and `never`. The default threshold is
`info`; `LOGTAPE_TEST_LOWEST_LEVEL` accepts LogTape levels such as `debug`, `info`,
and `warning`. Records are buffered for each test callback and printed when it
settles, rather than streamed live. Hooks are outside that callback capture.

New tests should import `test` or `it` from the autoload entry point. Other helpers
such as `expect` and `describe` are re-exported there unchanged. Importing only
`bun:test` does not opt a test into capture.

The logging-configuration tests deliberately use raw `bun:test` callbacks: they
replace and reset global routing to assert custom sink behavior. Those records go
to their assertion sinks instead of the failure reporter. Their cleanup restores
the async-local test configuration so subsequent wrapped tests still capture logs.

This is a development-only dependency. It does not configure application logging
or change journal records. See the [LogTape testing guide](https://logtape.org/manual/testing)
for reporter customization.

## Fixture diagnostic artifacts

The Bun-only `fixture-capture.ts` helper exports
`withFixtureDiagnostics(directory, fields, callback)`. It captures the real LogTape
records at debug level in `diagnostics.jsonl` and a readable `diagnostics.log` beside
the scenario journals. JSONL uses the same flat schema as launcher diagnostics: ISO `timestamp`, `level`,
`category`, `event`, and structured event fields at the top level, including scenario/run
metadata supplied by the caller. These files are diagnostic
review artifacts, not approved journal baselines or evidence of a committed append.

The environment must configure LogTape `contextLocalStorage` once; Bun's test autoload
already does this. Capture uses scoped routing, does not reset global logging, and
forwards records into the parent scope so normal test reporting still works. Concurrent
scenarios remain isolated. Files are written as events arrive, so a failing scenario
retains its evidence; an artifact write failure is reported after callback cleanup,
rather than disappearing into best-effort diagnostic delivery. Re-running a scenario
replaces its two diagnostic files. The fixture runner owns artifact retention.
