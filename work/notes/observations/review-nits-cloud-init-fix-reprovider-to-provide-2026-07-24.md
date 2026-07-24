---
title: review-gate non-blocking nits for 'cloud-init-fix-reprovider-to-provide' (Gate 2 approve)
date: 2026-07-24
status: open
reviewOf: cloud-init-fix-reprovider-to-provide
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'cloud-init-fix-reprovider-to-provide' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- The module doc comment in packages/pinnace/src/node/node-commands.ts:15 still says Provider-record freshness (Reprovider.Interval); it is a third prose location naming the same renamed concept that was left stale while cloud-init.ts and ADR-0002 were updated to Provide.Interval. No runtime effect (doc comment only), but the term is now forked across two files. Worth a one-line follow-up so the glossary of this concept stays consistent.
  (packages/pinnace/src/node/node-commands.ts:15 vs the updated cloud-init.ts:31 and ADR-0002 line 9)
- Ratify: the commit bundles a new unrelated observation work/notes/observations/vitest-missing-ipfs-car-deps.md (pre-existing ipfs-car/@ipld/car import failures). Correctly scoped as environment/dep issue unrelated to this fix; recording it here for the human to confirm the bundling is intended.
  (diff adds vitest-missing-ipfs-car-deps.md alongside the fix)
