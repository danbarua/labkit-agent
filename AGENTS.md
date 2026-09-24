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
bun run dev
bun run start
bun run build
bun test packages/core
bun test path/to/file.test.ts
bunx tsc --noEmit
bunx biome check
bun run format:check
```

Use Bun rather than Node.js, npm, pnpm, or Yarn. Use `bun:test` for tests and prefer
Bun's built-in APIs where applicable. Bun loads environment files automatically; do
not add dotenv.

For behavior changes, run focused tests, the relevant module suite, and type checking.
The codebase contains compile-time assertions that the test runner alone cannot
validate. Run the build for frontend or bundling changes. Documentation-only changes
need formatting and diff review rather than application tests.

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
