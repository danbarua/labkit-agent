# Runtime contract review

This unreleased format reset removes flat session options, historical journal acceptance,
feature-driven format selection and upgrade records. Current records use format 1; creation always
stores resolved policy revision 0. Configuration revisions remain independent of format.

## Reviewed baseline differences

The inspector retains the two scenario groups but runs both by default (42 scenarios). The
configuration-change scenario replaces the legacy-upgrade name; policy-lost-acknowledgement is
renamed to avoid colliding with the ordinary receipt-loss scenario in a consolidated report.

Compared with the previous checked-in baselines:

- All 39 previously baselined scenarios retain exactly the same provider/completion requests.
- All 39 retain the same committed conversation messages and terminal outcome kinds/messages.
  Failures now add operation identity, classification, phase and serializable causes; aborted
  outcomes add an initiating cancellation reason. These additional fields were reviewed separately.
- Former flat-option fixtures now contain explicit default policy and an empty pending-input queue.
  Event policy revisions are explicit. Removed upgrade records reduce subsequent journal revisions
  and receipt counts at those boundaries; no external operation was removed or added.
- Journal record format numbers are uniformly 1. Thinking previously named adaptive on manual
  budget profiles is now named budget; exact encoded HTTP requests remain unchanged. Native adaptive
  remains adaptive and is rejected by manual-budget profiles.
- Three existing introductory examples now also appear in baseline output, while retaining their
  named behavioral assertions. Obsolete input-interpreter metadata is removed.

No history-storage optimization, payload deduplication or replay semantic change is included.

## Public consumer evidence

`packages/core/session/consumer-contract.test.ts` runs actual shared transport against scripted
responses. It covers JSON extraction/tool exchanges, malformed JSON, truncated SSE, model selection,
explicit repeat, deadlines, cancellation and restoration. Existing permission/ACP suites cover refusal
and interrupted permission recovery. No automated acceptance calls paid providers.

Each capture creates a unique directory under `.session-artifacts/consumer*`, `deadlines`, or
`peer-review`. Its manifest and per-call README link full request and response bodies. Failed JSON
and EOF responses remain on disk with correlation and diagnostic stages. Real runtime diagnostics
are persisted beside them. The peer-review report includes history-comparison.json: coordinator
message counts grow across turns while the two independent Anthropic extraction request byte counts
remain equal. Repeating extraction requires a new explicit user invocation; restore makes no calls.

These measurements justify evaluating journal/history duplication as separate storage work. Such a
proposal must preserve receipt correlation, exact request reconstruction, immutable branch boundaries
and recovery without repeating effects. It is not implemented by this change.

## Acceptance gap closure

The three gaps from the progress checkpoint are closed by the following implementation and evidence.
The scope remains the original runtime-contract remediation; no storage deduplication or automatic
external-effect retry was added.

| Gap                                       | Implemented boundary                                                                                                                                                                                                                                             | Executable acceptance                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Message-only storage/admission settlement | Failed receipts, session state, and public settlements carry a serializable `error`. Storage captures the original cause; reconciliation retains the preceding uncertain append, identity, revisions, and attempt count. ACP forwards the failure as error data. | `settlement-failure.test.ts`: rejected append, revision conflict, failed reconciliation load, repeated uncertainty, and invalid policy admission. `adapter-prompt-turns.test.ts`: structured failure survives JSON-RPC.                                                                                                              |
| Missing peer-review failure acceptance    | The consumer makes coordinator and nested Anthropic extraction requests through actual transport with scripted responses. It handles refusal, interruption, timeout, malformed extraction JSON, cancellation, and model/permission/deadline reconfiguration.     | `peer-review-acceptance.test.ts`: all six scenarios restore without completion/tool/permission invocation, then extract exactly once only after a new explicit input. The earlier consumer test still verifies growing coordinator history against constant independent extraction sizes.                                            |
| Unverified evidence after process failure | Capture writes complete temporary files and replaces published files by rename. Each run remains independent.                                                                                                                                                    | `environment/provider-capture.test.ts`: a separate Bun process uses real HTTP to a local scripted server, retains a partial SSE response, then receives SIGKILL. The parent verifies the request, partial response, model, status, upstream request ID, operation identity, manifest, and diagnostic logs without shutdown flushing. |

Process termination cannot emit its own terminal event. The interrupted capture correctly retains
`outcome: in_progress` and `phase: stream`; the test parent's `process-outcome.json` records the
observed SIGKILL separately. This does not claim power-loss durability or an fsync guarantee.

## Final verification and review artifacts

- `LOGTAPE_TEST_MODE=always LOGTAPE_TEST_LOWEST_LEVEL=debug bun test packages/core packages/acp`:
  537 passed, zero failed, across 65 files. The final focused peer-review run also passed all six
  scenarios after moving journal evidence into cleanup so assertion failures retain it.
- `bunx tsc --noEmit` and `bun run build` passed.
- Consolidated fixture inspector: 42 passed; retained `--v2` entry point: 25 passed.
- The only new baseline change is added structured failure data on the rejected-append receipt
  and settlement. Requests, journal contents, conversation outcomes, and dispatch counts are unchanged.
- Changed implementation files passed Biome; scoped formatting and diff checks passed. Existing
  whole-repository lint issues are outside this change. Diagrams were checked against source,
  not visually rendered.

Runtime evidence is retained in unique directories under:

| Directory                                            | Inspect                                                                                                                           |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `.session-artifacts/settlement-failure/<run-id>`     | `settlement.json` and diagnostic logs show the storage origin and cause without journal search.                                   |
| `.session-artifacts/peer-review-acceptance/<run-id>` | `acceptance.md`, `outcomes.json`, `journal.json`, and linked full traffic distinguish coordinator history from nested extraction. |
| `.session-artifacts/process-failure/<run-id>`        | `process-outcome.json`, manifest, request/partial-response files, and logs survive process death.                                 |
| `.session-artifacts/latest/<run-id>`                 | Consolidated fixture reports, journal evidence, and persisted diagnostics.                                                        |

WARNING/ERROR-only artifact inspection confirmed that refusal identifies the blocked extraction,
timeout identifies its 20 ms limit, malformed extraction retains the JSON parser cause, and failed
reconciliation retains EDQUOT and the original volume-quota explanation. Successful peer-review
configuration/repeat execution produced no warnings or errors. A killed process has no fabricated
failure log or successful terminal record; its last retained operation remains visibly incomplete.

## Correction: caller-controlled thinking and output limits

The earlier acceptance missed a product defect: renaming a hardcoded 1024-token budget did not
make thinking configurable. The runtime no longer supplies that budget, and Anthropic no longer
gets a hidden 1024-token output cap. Manual thinking requires `thinkingBudgetTokens` and a larger
`maxOutputTokens`; native adaptive thinking accepts no manual budget. Model bindings can declare
upper limits. These checks reject invalid combinations before HTTP rather than silently adjusting
them. This validates declared capabilities, not an exhaustive catalogue of remote model limits.

ACP exposes named numeric budgets and a separate output limit; the console exposes numeric inputs.
Their initial output limit is an explicit 16384-token application preset, not a runtime default.
The console uses provider aliases rather than offering adapter generations as provider choices.
Applications must choose limits for their task: a valid budget does not guarantee enough room for
an answer. Output exhaustion still produces a failed completion with the provider's stop reason.

`providers/token-settings.test.ts` verifies exact 4096-, 8192-, and 16384-token encoding, invalid
settings rejected before dispatch, model-specific declared limits, captured in-flight settings,
committed reconfiguration, and restoration without requests. Its persisted capture manifests,
request bodies, and `diagnostics.jsonl` are under `.session-artifacts/token-settings/<run-id>`.
The successful configuration and request sequence has no WARNING/ERROR records. Existing
provider stop and streaming tests continue to verify exhaustion and incomplete-stream failures.

Reviewed fixture differences add explicit budgets to configuration snapshots and explicit output
limits to Google requests (retained on a subsequent provider switch). Clearing a manual budget on
mode changes is represented by null. Conversation outcomes and dispatch counts are unchanged;
no baseline change conceals a new outcome. Existing 1024-token test vectors now request that
value explicitly and do not establish an application default.

Verification for this correction: 543 core/ACP tests passed with DEBUG logging, type checking and
the web build passed, and both fixture entry points passed (42 and 25 scenarios). Scoped formatting
and diff checks passed. Biome's remaining finding in the changed-file scan is the pre-existing
console auto-scroll effect dependency rule; changed core/ACP implementation checks pass. No live
provider credits were used. The inspected token-settings run was
`4203fc52-6d9e-4dbf-92bc-8aa29a6bb6b2`: retained requests show 8192/32768 followed by 4096/16384,
and its persisted diagnostics contain no warnings or errors.

## Correction: remembered tool approval

The once-only ACP picker made repeated tool use require repeated user intervention. It now offers
`allow-session`: approval of the named tool for all arguments until the live session closes or
tool scope changes or permissions are explicitly reset. The host owns grants. It installs a grant only when the committed permission
outcome releases the batch; refused/cancelled batches discard new grants. Every later call still
validates inputs and commits a permission decision with the original grant identity and source.
Restoration makes no calls and does not recreate live approvals. An already committed grant survives
cancellation of a later turn. ACP Tool approvals exposes Ask (clear grants) and an explicit option to
allow all enabled tools without asking. No default permission was silently broadened.

Verification: 547 core/ACP tests passed with DEBUG logs, type checking and the web build passed,
and fixture entry points passed 42 and 25 scenarios. The built ACP launcher performs two reads
with one permission response. Persisted grant/reuse/revocation diagnostics were inspected under
`.session-artifacts/permission-grants/b4065919-66d6-474f-ba10-4fbf42a238d9`; routine success has no
warnings/errors. The changed fixture baseline only adds the new permission option; existing
outcomes and tool dispatch counts remain unchanged. The full suite also exposed cancellation
while request capture was pending: transport now checks cancellation again before HTTP dispatch,
with a regression test proving no fetch after cancellation.
