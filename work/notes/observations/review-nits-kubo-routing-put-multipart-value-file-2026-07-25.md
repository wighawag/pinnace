---
title: review-gate non-blocking nits for 'kubo-routing-put-multipart-value-file' (Gate 2 approve)
date: 2026-07-25
status: open
reviewOf: kubo-routing-put-multipart-value-file
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'kubo-routing-put-multipart-value-file' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- The agent chose to generalise fileUpload with a field='file' default (over a dedicated routing/put path). The task explicitly permitted either; this is the cleaner choice and preserves the three existing file-named uploads. Ratify.
  (kubo-rpc-client.ts fileUpload gained a 4th param field='file'; routingPut passes value-file. Existing add/dag-import/key-import tests still assert field==='file'.)
- The putRecordText multipart-decode helper is duplicated verbatim in node-commands.test.ts and record-sequence.test.ts. Consider hoisting to a shared test util later.
  (Identical function defined in two test files; harmless duplication, test-scope only.)
