---
title: review-gate non-blocking nits for 'publisher-replica-model' (Gate 2 approve)
date: 2026-07-24
status: open
reviewOf: publisher-replica-model
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'publisher-replica-model' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify an unrecorded in-scope decision: promoteReplicaToPublisher calls importIpnsKeyIntoPublisher with role:'publisher' to deliberately bypass the KeyImportRoleError refusal (which rejects non-publisher roles). Semantically correct (promotion IS making the node the publisher) and documented in the code doc, but there is no Decisions block in the commit/PR and this is a cross-task interaction with the key-import seam. Confirm intended.
  (src/publisher/record-sequence.ts promoteReplicaToPublisher passes role:'publisher'; key-import.ts throws KeyImportRoleError unless role==='publisher')
- AC says story 14 is 'delivered as a pinnace command'. The core promoteReplicaToPublisher is implemented, exported, and tested, but it is not wired into the CLI dispatcher (cli/run.ts), which currently only routes node/site verb-name validation and defers all real client-verb wiring to later tasks. Is delivering promote at the core+seam layer (matching the repo's deferred-CLI pattern) the intended interpretation, or was a dispatchable verb expected now?
  (cli/run.ts routes only node/site and stubs provision/deploy/status/derive/promote; promote reachable only via the exported core fn)
- record-sequence.ts (the owned core) imports its context/site types FROM node/node-commands.ts, while node-commands.ts imports the concrete ops from record-sequence.ts. The core-owns-types direction is inverted; it works because the record-sequence side is import-type-only (no runtime cycle, gate green), but the type home may be worth relocating later.
  (src/publisher/record-sequence.ts line 56 imports types from ../node/node-commands.js; node-commands.ts line 40 imports fns from ../publisher/record-sequence.js)
