---
title: review-gate non-blocking nits for 'context-glossary-mfs-sites-metadata' (Gate 2 approve)
date: 2026-07-26
status: open
reviewOf: context-glossary-mfs-sites-metadata
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'context-glossary-mfs-sites-metadata' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify: the glossary names 'site add' as a metadata writer but never says it is the ONE non-preserving writer. site-management.ts writes {mode: 'ipfs'} unconditionally, so re-adding over an existing ipns site demotes it and drops its ensName, which is exactly the silent-demotion hazard the new mode entry says is prevented. Should the mode/metadata entries carry a one-clause caveat for site add?
  (CONTEXT.md mode entry ('Omitting --set-mode therefore PRESERVES'); packages/pinnace/src/site/site-management.ts:187-205 (placeInMfs(..., {mode: 'ipfs'}), with its own DECISION note about rewriting an existing ipns site))
- Ratify the in-scope decision to leave ADR-0001's dangling cross-references (CONTEXT.md keyId / ENS name, now id / ensName) unfixed and capture them as an observation only. Reasonable under the task's do-not-touch-ADRs fence, but nothing spawns the fix; a human should either ratify the note or turn it into a task.
  (work/notes/observations/adr-0001-cites-retired-glossary-terms.md (new in this commit); docs/adr/0001-frozen-ipns-key-derivation.md lines 21-22)
- Follow-up outside this docs fence: the generated on-box env file still comments that any MFS entry ending in .eth is warmed via eth.limo, which contradicts the metadata-driven three-way rule this glossary now pins. Worth a small doc-drift task on the sibling that moved warming to metadata.
  (packages/pinnace/src/provision/cloud-init.ts:362 vs src/node/node-commands.ts:345-351 (resolveEnsNameToWarm))
