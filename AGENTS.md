# Repository guidance

Labkit Agent is an experimental TypeScript runtime for durable, inspectable agent
sessions. It is an ES module project with Bun workspaces under `packages/*`.

## Find the right documentation

When a module has a README, read it before editing that module. Module READMEs own local
APIs, boundaries, invariants, and testing notes. Higher-level and cross-module
architecture belongs in `docs/`.

- `packages/core/agent/`: pure turn and conversation decisions, prompt projection,
  operation actors, and the nonjournaled runtime.
- `packages/core/fsm/`: typed decisions, immutable snapshots, and serialized actor
  mailboxes.
- `packages/core/session/`: journaled execution, persistence receipts, settlement,
  restore/recovery, and durable branches. See its `README.md`.
- `packages/core/host/`: shared resource ownership, child routing, cancellation, and
  completion/tool ports. See its `README.md`.
- `packages/core/policy/`: versioned input, projection, handoff, tool-error, and provider
  policies. See its `README.md`.
- `packages/core/providers/`: pure versioned provider profiles and the shared fetch
  transport. See its `README.md`.
- `packages/core/environment/`: asynchronous event sources and renderer bindings. See
  its `README.md`.
- `packages/core/logging/`: environment-owned diagnostic logging. See its `README.md`.
- `packages/web/`: React 19 session console and Bun server. The browser talks to the
  server host; session UI beyond that console is separate work.

Use `docs/core-runtime.md` and `docs/agent-flow-diagrams.md` for the underlying agent
runtime. Use `docs/session-runtime.md` for persistence and session flows.
`docs/host-protocol.md` is a design document with explicit implementation gaps; do not
treat every protocol feature in it as shipped.

When documentation and implementation differ, source and tests describe current
behavior. Update the relevant module README for a local contract change and the
appropriate file in `docs/` for a cross-module architecture change.

## Commands

Run commands from the repository root:

```sh
bun install
bun run dev                     # hot-reload web server workflow
bun run start                   # web server from source with production env var
bun run build
bun test packages/core          # scope tests to a package
bun test path/to/file.test.ts   # scope tests to a file
bun run test:with-logs          # test suite with verbose logging
bunx tsc --noEmit
bunx biome check
bun run format:check            # check but don't format
bun run format                  # reformat files
bun pm pkg get scripts          # README goes stale, this command does not
```

Use Bun rather than Node.js, npm, pnpm, or Yarn. Use `bun:test` for tests and prefer
Bun's built-in APIs where applicable. Bun loads environment files automatically; do
not add dotenv.

For behavior changes, run focused tests, the relevant module suite, and type checking.
The codebase contains compile-time assertions that the test runner alone cannot
validate. Run the build for frontend or bundling changes. Documentation-only changes
need formatting and diff review rather than application tests.

## Definition of done: observability and traceability

A feature or behavior change is not done until it can be diagnosed from its runtime
logs. Passing functional tests, producing journal fixtures, or writing files under
`session_artefacts` / `.session-artifacts` does not satisfy this requirement. Users
must not need to copy protocol traffic from a UI or reproduce a failure under a
debugger to discover why an operation stopped.

- Include observability in the feature's acceptance criteria and implementation,
  not as follow-up work. Instrument meaningful lifecycle events: admission, dispatch,
  waiting and its reason, state transitions, completion, failure, cancellation, and
  recovery where applicable. Successful execution must also leave useful evidence.
- Make events traceable across boundaries. Use stable event names and structured
  fields with the applicable session, turn, operation/child, tool call, request, and
  append IDs. Include relevant provider/profile versions, configuration changes,
  statuses, limits, and timing so an operator can reconstruct what happened.
- Preserve diagnostic causes through error translation. Record the actual provider
  stop reason, HTTP status, provider request ID, error code, and useful error details
  when available. Do not replace this evidence with only "Internal error", "Agent
  turn failed", a list of allowed schema values, or an unexplained status code.
  Distinguish exhausted limits, rejected permissions, cancellation, invalid input,
  missing bindings, and transport/provider failures.
- Protect secrets through targeted field exclusion or redaction. Do not use
  "security", "privacy", or "safe logging" as a reason to swallow exceptions,
  discard causes, or remove the evidence needed to debug the system. Routine
  diagnostics do not require prompts, file contents, credentials, or authorization
  headers. Preserve useful error metadata and explanations without those payloads.
- Environment launchers must provide durable, bounded diagnostic output with a
  documented location, levels, rotation/retention, and retrieval procedure. Stderr
  or a transient UI Output channel alone is insufficient for a launched agent.
  Keep ACP stdout exclusively for protocol traffic. Core must not configure global
  logging or own file sinks; log at runtime/adapter boundaries, keeping decisions pure.
- Add tests that assert the feature's expected diagnostic events and correlation
  fields on successful and relevant failed/cancelled paths. Exercise the real
  instrumentation, not test-only print statements. Verify sensitive fields are
  excluded without erasing diagnostic causes.
- Run the affected tests with debug logging enabled and inspect the emitted output:

  ```sh
  LOGTAPE_TEST_MODE=always LOGTAPE_TEST_LOWEST_LEVEL=debug bun test path/to/affected.test.ts
  ```

  Check that the new behavior produces the expected new events or meaningful fields
  in existing events. Unchanged log output across newly implemented lifecycle paths
  is a gap to investigate, not evidence of success. Test capture must show the logs
  that runtime instrumentation emits when the feature works and when it fails.

Completion reports must state what diagnostic evidence was verified and where an
operator can retrieve it. If instrumentation or durable launcher logging is missing,
report the work as incomplete; do not claim that passing tests makes it done.

## Meaningful Failure Reports

- Make failure reports self-contained. State which operation failed, what it was
  trying to do, what prevented it, and the consequence. Include relevant tool names,
  paths, arguments, configuration values, or limits. `outcome="failed"` alone is
  not an explanation.
- Preserve the original error and its cause. Distinguish observed facts from
  inference; if the cause is unknown, say so. Do not replace specific errors with
  generic messages such as "operation failed".
- Use stable event names and consistent fields. Include correlation IDs to connect
  the report to surrounding events; IDs supplement an explanation, not replace it.
- Choose severity for the event's meaning. Routine lifecycle events belong at
  DEBUG or INFO. Warnings must identify a condition or intervention worth
  investigating—for example, a user refusing a model-requested tool action.
  Explain its consequence, such as blocking the entire tool batch.
- Log the cause where it is known and the resulting outcome where it is committed.
  Make their relationship explicit. Do not force readers to infer the cause from
  an unrelated operation's generic failure.
- Test diagnostic usefulness, not just event presence. Inspect persisted output:
  a WARNING/ERROR-only scan must expose the important exception or intervention;
  surrounding INFO/DEBUG records must explain the sequence. Assert meaningful
  context and severity, including the absence of warnings during routine success.
- Redact API keys without discarding the evidence needed to diagnose the problem.

The central rule is: **a reader should need surrounding logs to understand the sequence, 
not to discover what the warning means.**


## Runtime conventions

- Keep decisions pure and synchronous. Return the complete next state and commands;
  commit and freeze state before dispatching commands.
- Keep controllers, callbacks, registries, credentials, persistence handles, and other
  mutable resources outside domain snapshots.
- The shared host owns operation resources, child routing, cancellation, completion
  ports, and tool ports. Do not duplicate those responsibilities in agent or session
  code.
- The session layer owns journal staging, persistence receipts, reconciliation,
  settlement, restore, and durable branch publication. Never release dependent work
  before its matching append receipt commits.
- Commit individual tool results before releasing them to the tool batch. Preserve the
  existing identity and correlation checks for turns, children, batches, and calls.
- Treat an indeterminate append as unknown, not failed. Reconcile the stable append ID
  and bytes through a load before retrying or stopping.
- Policies and provider profiles are versioned, pure data/code bindings. Policy patches
  take effect at committed boundaries; they do not replace live registries or mutate an
  operation already in flight.
- Provider profiles only encode and decode. Fetch work runs through the shared host
  operation machinery, and credentials and origins remain environment bindings rather
  than journal data.
- The nonjournaled agent runtime publicly accepts user and abort events. The session
  environment also admits system, policy, fork, compact, and close events; child
  outcomes stay private.
- Persistence and logging lifetimes belong to the environment or caller. Diagnostic
  logs never certify a journal commit.
- Use discriminated unions, branded domain values, and Zod validation at trust
  boundaries. Reuse existing asynchronous test helpers and injected ports.

## Session fixtures

Run the fixture inspector when changing session ordering, persistence, policy, or
recovery behavior:

```sh
bun run packages/core/session/fixture-runner.ts
bun run packages/core/session/fixture-runner.ts --v2
```

Approved fixture baselines are review artifacts. Use `--update` only when intentionally
accepting a behavior change, then review the generated diff. Do not casually replace
baselines or commit ignored inspection output.

## Style and generated files

Prettier is the formatter and `@ianvs/prettier-plugin-sort-imports` owns import order.
Use two spaces, double quotes, semicolons, trailing commas, and a 100-column width;
JSON-family files omit trailing commas. Use `bun run format` only for an intentional
repository-wide rewrite; otherwise format the files in scope. Biome's formatter is
disabled, while its configured linter rules still apply.

Preserve strict TypeScript behavior, including `noUncheckedIndexedAccess` and
`verbatimModuleSyntax`. Avoid unrelated formatting changes. Do not edit generated
output in `dist/`, dependencies in `node_modules/`, or ignored session inspection
artifacts.

- Separate top-level declarations with exactly one blank line. This includes
  functions, classes, types, interfaces, and module-level variables.
- Separate function declarations—including nested functions and functions assigned
  to variables—from adjacent statements or declarations with one blank line.
  No blank line is needed at the beginning or end of a scope.
- Check this spacing during diff review; formatter output does not waive the rule.