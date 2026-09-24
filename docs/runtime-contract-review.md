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

## Remaining acceptance gaps

This change is a progress checkpoint, not completion of the full remediation plan:

- Storage/admission failure settlements can still expose only `kind` and `message`, unlike the
  structured causal failures carried by terminal operation outcomes.
- The peer-review consumer demonstrates extraction, explicit repeat, restoration, and request-size
  comparison. Refusal and interruption have coverage elsewhere but still need acceptance through
  that consumer.
- Malformed JSON and partial stream EOF retain evidence in tests. Evidence retention after an
  actual process failure remains unverified.

Verification at this checkpoint: 524 core/ACP tests, TypeScript checking, the frontend build, and
42 consolidated fixtures passed. The final focused consumer run passed all 11 tests. Documentation
links and anchors were checked; diagram flows were checked against source but not visually rendered.
Changed-file lint passed; whole-repository lint still reports unrelated existing failures.
