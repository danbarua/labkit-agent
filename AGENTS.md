# Repository guidance

## Project and layout

Labkit Agent is a playground for semi-autonomous, AI-assisted computational science
experiments. It is a TypeScript ES module project with Bun workspaces under `packages/*`.

- `packages/core/`: agent runtime, provider transport, tools, conversation history,
  prompt projection, and shared state-machine infrastructure. Tests live beside source.
- `packages/web/`: React 19 completion console, Bun HTTP server, and frontend build.
  The console currently calls the completion transport directly rather than exposing
  the full agent runtime.
- `docs/core-runtime.md`: runtime architecture and validation guidance.
- `docs/code_review.md`: historical review; verify its claims against current code
  before treating them as requirements or outstanding defects.
- `CLAUDE.md`: additional Bun conventions.

## Commands

Run commands from the repository root:

```sh
bun install                    # Install dependencies
bun run dev                    # Development server with hot reload
bun run start                  # Server with NODE_ENV=production
bun run build                  # Frontend production build
bun test packages/core         # Core test suite
bun test path/to/file.test.ts   # Focused test file
bunx tsc --noEmit               # Type checking
```

Use Bun instead of Node.js, npm, pnpm, or Yarn. Use `bun:test` for tests. Prefer
Bun's built-in APIs for servers, files, subprocesses, and database access where
applicable. Bun loads environment files automatically; do not add dotenv.

For behavior changes, run focused tests and the relevant suite. Run type checking
for TypeScript changes: the domain-type tests include compile-time assertions that
the test runner alone cannot validate. Run the build for frontend or bundling changes.
Documentation-only changes need a content/diff review, not an application test run.

## Core runtime conventions

- Keep state-machine decisions pure and synchronous: return `{ state, commands }`.
  Commit and freeze state before executing commands through serialized actors.
- Keep mutable adapters, controllers, callbacks, and registries outside domain
  snapshots.
- Preserve responsibilities: `agent-fsm` owns turn transitions;
  `agent-conversation` owns atomic turn recording and session forks;
  `operation-actor` owns execution and cancellation; `tool-batch` correlates tool
  results; `agent-runtime` owns resources and child routing; provider transport
  handles HTTP/decoding; `prompt` projects history for model input.
- Use discriminated unions, branded domain values, and Zod validation at boundaries.
  Use `defineTool` for inferred tool input types and derived JSON Schema.
- Runtime callers send user input or abort events. Child outcomes stay private and
  must match the active turn and child identity before affecting state.
- Test cancellation races, stale outcomes, tool-result correlation, immutable
  history, and fork boundaries when changing those behaviors. Inject completion
  or fetch implementations and reuse the existing asynchronous test helpers.

## Frontend and code style

- Use Bun HTML imports and `Bun.serve()`; preserve the existing bundling approach.
- Reuse the UI primitives in `packages/web/components/ui/`, Tailwind 4 styles,
  and Lucide icons. The `@/*` alias resolves to `packages/web/*`.
- Follow strict TypeScript settings, including `noUncheckedIndexedAccess`.
  Preserve type-only imports where required by `verbatimModuleSyntax`.
- Follow `biome.jsonc`: two spaces, double quotes, semicolons, trailing commas,
  and a 100-column formatting width. Keep it as JSONC because it contains comments.
- Preserve the configuration's documented rule exceptions and disabled import
  organization. Avoid unrelated formatting changes.
- Do not edit generated output in `dist/` or dependencies in `node_modules/`.

<!-- jbcontext-instructions-start -->
## Code discovery

Use `jbcontext search` for semantic discovery in unfamiliar code before planning,
editing, or exact text searches when the relevant implementation is unknown.
Use one focused, descriptive natural-language query per search:

```sh
jbcontext search "Where are tool outcomes correlated with an active agent turn?"
jbcontext search -p packages/core "How does the runtime cancel an active operation?"
```

The `-p` path must be relative to the project root. Once a relevant hit is found,
read the files directly; use exact text search for known symbols and paths.

For broader or multi-step discovery, delegate to a read-only `context_explorer`
agent instead of repeating exploratory searches in the main thread. Give it the
intent with no inherited conversation when supported. Ask it to run semantic
queries, read promising files, and return concrete file/line references, inline
snippets, and a confidence note. If an initial search is insufficient, delegate
the follow-up exploration to this agent.

While it works, inspect only already-known relevant files or the environment;
do not duplicate its exploration. Call `wait_agent` after that independent work.
If the tool has no named agent types, use a general subagent with this read-only role.

If semantic search reports that the repository has no index, state that limitation
and use file listing, direct reads, and exact searches as a fallback.
<!-- jbcontext-instructions-end -->
