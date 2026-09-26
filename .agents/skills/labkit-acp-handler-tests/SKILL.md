---
name: labkit-acp-handler-tests
description: "Write labkit-agent ACP tests that drive the real protocol handler: in-process harness, workspace launcher with scripted provider HTTP, real stdio process, diagnostics capture; and flip docs/acp-conformance.md rows to Done"
---

# Testing ACP behaviour through the real handler

A conformance row in `docs/acp-conformance.md` is **Done** only when a test sends the protocol
method (`session/set_config_option`, `session/prompt`, …) through the adapter. Calling
`session.updatePolicy` or other session APIs directly does not count. The sections below cover
what you need to know to write such tests without rediscovering it.

## Where tests live

- `packages/acp/adapter-<area>.test.ts`: one file per area (config-modes, session-lifecycle,
  prompt-turns, observability, initialize-framing, mcp-proxy, elicitation, client-files, …).
- Capability evidence: `capabilities.test.ts` (advertised/unadvertised, SDK schema validation),
  `prompt-capabilities.test.ts`, `mcp-capabilities.test.ts`, `client-capabilities.test.ts`,
  `tool-failure.test.ts`.
- Launcher catalog behaviour at session level: `workspace-catalog.test.ts`. This is not handler
  evidence.
- Real processes: `stdio.test.ts`, `disconnect-reload.test.ts` (a `Launcher` class with
  disconnect/kill/reload), `launcher-logging.test.ts` (startup failures, rotation).

## In-process harness: `packages/acp/testing/harness.ts`

`harness(options: AcpOptions)` uses real SDK ndjson framing over in-memory streams. It returns:

- `request(method, params)`: sends the request and resolves with the response frame
  `{ result?, error? }`.
- `start(method, params)`: sends without waiting and returns the id. Pair it with
  `response(id)`, for example to cancel with
  `send({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: id } })`.
- `send(frame)` and `raw(text)` for hand-built or malformed frames.
- `initialize()`: sends `clientCapabilities: {}`, so boolean config options stay hidden.
- `newSession()`: uses cwd `/tmp`.
- `messages`: every frame the agent wrote, including client requests such as
  `session/request_permission`.
- `updates()`, `close()`, `disconnect()`.

`setup(overrides)` returns `{ options, persistence }`: memory persistence, agent `a` with an
`echo` tool, and a scripted `complete` that answers "Hello 🌍".

`testing/fixtures.ts` has:

- `answer`, `tools` (one `echo` call), `prompt(sessionId)` (text "Go");
- `offline` (a fetch that throws);
- `configurable(complete)`: an openai-chat provider binding that records each request body;
- `proxiedMcpPeer`.

## Workspace launcher with scripted provider HTTP

`workspaceAgent(env, directory?, { fetch })` in `packages/acp/examples/vscode-workspace.ts`.
The injected `fetch` replaces **both** localhost model discovery and every provider transport.
Pattern (from `adapter-config-modes.test.ts`, "set_config_option switches the workspace launcher
between providers…"):

```ts
const requests: { host: string; body: any }[] = [];
const scripted = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.pathname.endsWith("/models")) throw new Error("connect ECONNREFUSED 127.0.0.1:8000"); // localhost offline
  requests.push({ host: url.host, body: JSON.parse(String(init?.body)) });
  return streamResponse(
    streamVector(url.host.includes("anthropic") ? anthropicMessagesV3 : openaiResponsesV3),
  );
}) as unknown as typeof globalThis.fetch;
const h = harness(
  workspaceAgent({ ANTHROPIC_API_KEY: "x", OPENAI_API_KEY: "y" }, undefined, { fetch: scripted }),
);
```

- Never name the variable `fetch` and then write `typeof fetch`: tsc fails with TS7022, and Bun
  does not typecheck, so the test still passes. Always run `bunx tsc --noEmit`.
- Use `realpathSync(mkdtempSync(join(tmpdir(), "…")))` as the `session/new` cwd. Workspace
  storage lives under the cwd.
- The default policy has `stream: true`, so a provider must answer with SSE. Use `streamVector` and
  `streamResponse` from `packages/core/providers/testing/stream-vectors.ts`. Vectors exist only for
  `openaiChatV2`, `anthropicMessagesV3`, `openaiResponsesV3` and `googleGenerateV3`.
  `anthropicMessagesV4` uses the same wire format, so use the V3 vector for it.
- The catalog assigns profiles in `packages/core/providers/catalog.ts` (around line 140):
  - anthropic: adaptive-capable models get V4, the rest V3;
  - google: googleGenerateV3;
  - xai and localhost: openaiChatV2;
  - everything else (openai): openaiResponsesV3.
- Observed hosts and request bodies:

  | Host                | Body fields                                                           |
  | ------------------- | --------------------------------------------------------------------- |
  | `api.anthropic.com` | `{ model, thinking: { type: "adaptive" }, max_tokens }`               |
  | `api.openai.com`    | `{ model, reasoning: { effort }, max_output_tokens }` (Responses API) |

- With Anthropic and OpenAI keys and localhost offline, the initial model is
  `anthropic/claude-sonnet-4-6` with thinking off, and `initialize` advertises
  `promptCapabilities.image: true`.
- Catalog ids used in tests:
  - `anthropic/claude-sonnet-5` (thinking off or adaptive);
  - `anthropic/claude-sonnet-4-5` (manual budgets only);
  - `anthropic/claude-fable-5` (always adaptive);
  - `openai/gpt-5.4` (effort levels, no adaptive).

## Protocol shapes

- Select config: `session/set_config_option` `{ sessionId, configId, value }`. The response
  `result.configOptions` lists `{ id, currentValue, options }`. Grouped selects nest
  `{ group, name, options: [{ value, name }] }`.
- Boolean config: `{ sessionId, configId, type: "boolean", value: false }`. It is visible only
  when the client initializes with `clientCapabilities.session.configOptions.boolean`.
- Image prompt block: `{ type: "image", mimeType: "image/png", data: base64 }`. Any bytes work,
  for example `Buffer.from("IMAGE_CONTENT_SENTINEL")`.
- Refusals:
  - When the model selected at that moment lacks the media type, the response is -32602
    `Provider does not support attachment media: image/png; …`, sent before any provider request.
  - When the capability is not advertised, the response is -32602
    `Prompt contains image content, but this agent does not advertise promptCapabilities.image`.
- A request before `initialize` gets -32600 with `data.reason: "not_initialized"`.
- A malformed line gets -32700 with `id: null`.
- An unadvertised conditional method gets -32601 with data `{ method, capability }`, before any
  other check.

## Diagnostics assertions

AGENTS.md requires tests to assert the real diagnostic events.

- File capture: `withFixtureDiagnostics(directory, {}, async () => …)` from
  `packages/core/logging/fixture-capture.ts` writes `${directory}/diagnostics.jsonl`.
  1. Use `.session-artifacts/<area>/<uuid>` as the directory.
  2. Parse the file line by line and filter by `event`.
  3. Remove the directory in `finally`.
- Alternative: `spyOn(getLogger(...))`, as in `adapter-observability.test.ts`.
- Assert the correlation fields (`connectionId`, `sessionId`, `rpcRequestId`), not only the event
  name.
- Useful events:
  - `acp.config.selected` (with `configId`, `value`, `outcome` accepted|selected|ignored|unchanged,
    `selectionId` or `appendId`, `revision`) and `acp.config.failed`; configuration changes answer
    at once and apply at the next boundary between turns, where core logs `configuration.applied`
    with the same `selectionId`/`appendId`;
  - `acp.prompt.received`;
  - `acp.method.unknown`, `acp.method.not_advertised`;
  - `acp.capabilities.advertised`;
  - `acp.catalog.loaded`, `acp.catalog.localhost_unavailable`.
- Cancellation-race tests: wait for the handler's event (for example `acp.prompt.received`) before
  sending `$/cancel_request`. Otherwise the request is rejected synchronously and the race is never
  exercised. Configuration requests no longer wait behind a prompt, so they have no such race.

## Real stdio process

`stdio.test.ts` shows the pattern:

1. Write a temporary `config.ts` that default-exports `AcpOptions`, with memory persistence and a
   scripted `complete`.
2. `Bun.spawn([process.execPath, "packages/acp/cli.ts", "--config", config])` with
   `LABKIT_ACP_LOG_DIR` set to a temporary directory.
3. Parse stdout line by line. It carries protocol frames only.
4. Wait with `waitForResponse(id | null)`.
5. End with `child.stdin.end()` and expect exit code 0.

Set `LABKIT_ACP_TEST_BUILT=1` to run the same test against `dist/cli.js`.

## Proving a test catches the regression

For a regression pin, create a detached worktree at the commit before the fix, then
`bun install --frozen-lockfile`. Copy the test file in and confirm it fails there. Remove the
worktree afterwards. If the behaviour cannot be observed through protocol responses, updates or
diagnostics, report it as untestable with the reason. Do not test internals.

## Closing a conformance row

1. Add the test and run it (`bun test <file> -t "<name>"`).
2. Run `bun test packages/acp`, `bunx tsc --noEmit`, `bunx biome check` and Prettier on the
   changed files.
3. In `docs/acp-conformance.md` under **Work items** (IDs G1–G28, statuses
   `Done` / `Not done` / `Not doing`), flip the row and add it to **Evidence for the Done rows**
   with the file and test name. Update **Evidence by area** if the area gains new coverage.
4. Rows that need editor verification, an audit, live-model evidence or new implementation stay
   Not done, however many tests pass.
