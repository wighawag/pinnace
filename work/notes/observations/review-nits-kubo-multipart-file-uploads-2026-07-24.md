---
title: review-gate non-blocking nits for 'kubo-multipart-file-uploads' (Gate 2 approve)
date: 2026-07-24
status: open
reviewOf: kubo-multipart-file-uploads
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'kubo-multipart-file-uploads' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- In-scope decision to RATIFY: for key/import the multipart field name was chosen as 'file' (not 'key'), matching add/dag-import. The task flagged this as needing confirmation. It IS recorded in work/notes/findings/kubo-file-upload-multipart-contract.md with justification (Kubo cURL examples all use -F file=@..., plus a live workaround), so ratify.
  (findings doc: every endpoint's cURL example uploads under field name 'file'; Kubo matches positionally/by file-type.)
- Mock fidelity nit: MockKuboApi derives contentType as the bare string 'multipart/form-data' (no ; boundary=...), and tests assert exact equality on that. Real fetch appends a boundary. No caller/test would be bitten (byte payload + field name are also asserted), so guard is meaningful; just not a byte-exact boundary check.
  (mock-kubo.ts inspectBody returns contentType: 'multipart/form-data'.)
