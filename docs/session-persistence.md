# Journal and blob persistence

The journal records execution decisions; blobs retain content too large or unsuitable for those
records. Keep both for a usable restored session. A valid journal can restore without reading blobs,
but the next request may fail if its attachment bytes were deleted.

`SessionPersistence` has independent journal (`load`, `append`) and object-store (`putBlob`,
`getBlob`) operations. Every operation takes an AbortSignal. Journal receipts and stable append-ID
reconciliation retain their existing semantics. Blob operations do not advance journal revisions.

Blobs are session-scoped and immutable. `BlobId` is the lowercase hex SHA-256 of raw bytes.
`putBlob` accepts a Uint8Array and `{ media, name? }`, rejects more than 8 MiB before writing,
and copies caller bytes before returning control. Identical bytes return the same ID and stored
metadata on retry. The first optional name is retained; attempting to change the media type for
already-stored bytes is rejected. Zero-byte blobs are valid. Metadata is immutable and get returns
an independent byte buffer. A cancelled call rejects; an absent get returns `{ kind: "not_found" }`.

Supported ref media types are text/plain, text/markdown, image/png, image/jpeg and application/pdf.
The ref schema admitting a media type does not imply a profile can encode it. The shipped Anthropic @2–@4 profiles declare PDF document support. Session preparation checks media and verifies stored size,
media and hash against the ref before completion can start. Ref names are display labels, not paths.

The environment puts bytes before admitting a user ref. The current journal format stores refs and content parts,
never the raw bytes. Loading decodes refs as part of each record and does not read the object store.
Idle restoration therefore succeeds without blob access; missing bytes fail the next preparation.

Large continuation payloads are serialized as UTF-8 JSON blobs before model_settled is journaled.
Their envelopes carry `payloadBlob` instead of `payload`, using the same format. The inline cap stays at
65,536 JSON characters and the blob cap at 8 MiB raw. Preparation attaches these refs without
reading them; missing/corrupt payload bytes fail the completion operation before HTTP. Restore
and replay never resolve them. A failed append may leave an unreferenced payload blob.

Branch publication copies only blobs cited by inherited history/context and retained continuation
owners, using get/put through the
same port. Compaction copies the replacement-context subset. Copies finish before child creation
is published; no parent objects are removed. Content-addressing makes copying retryable, but there
is no atomic transaction spanning child blob writes and journal creation, nor garbage collection.

`createMemoryBacking` shares journal streams and session blob maps across independent memory
adapter instances. It has process-local lifetime only and provides no crash durability. The reusable
`testing/persistence-contract.ts` suite checks hashing, scope, retries, absent IDs, cancellation,
size limits and alias safety in addition to the existing append/load contract. Durable adapters
must add storage-specific process-crash tests and preserve both methods' lifetime guarantees.
