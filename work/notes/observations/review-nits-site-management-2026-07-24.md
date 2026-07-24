---
title: review-gate non-blocking nits for 'site-management' (Gate 2 approve)
date: 2026-07-24
status: open
reviewOf: site-management
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'site-management' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify: add is a DISTINCT verb (not an alias over deploy). It is deploy's MFS-placement step in isolation over an already-imported CID (no CAR build/import/pin), and deploy is expected to reuse the exported placeInMfs helper. Reasonable and explicitly recorded; confirm the intended add/deploy split.
  (src/site/site-management.ts DESIGN NOTE + .changeset/site-management.md; task said decide-during-build and record.)
- Ratify: remove unpins best-effort. files/rm runs first (site drops out of discovery), then pin/rm; a never-pinned/indirectly-pinned CID makes pin/rm error, which is swallowed and reported as unpinned:false rather than thrown. Sensible so removal never fails on a non-pin, but it also hides a genuine pin/rm failure (real pinned content left pinned, storage not reclaimed) as the same unpinned:false.
  (removeSite catch{} in src/site/site-management.ts; tested by the not-pinned case.)
- Ratify: the pinnace site CLI router only validates the verb and returns 0; it does NOT yet assemble a client or invoke listSites/removeSite/addSite. This mirrors the existing node router (full context wiring deferred to a later CLI task) and matches CONTEXT.md core-vs-cli, but end-to-end CLI execution is not wired here.
  (runSiteCli in src/cli/run.ts vs runNodeCli precedent.)
- Coherence note (task-authoring, not code): covers:[4,15] point at the deploy story (4) and gateway-warming story (15); neither is literally an add/remove/list-sites user story. The task frames this as a follow-up-conversation gap. Not a code defect; noting the covers mapping is loose.
  (work/specs/tasked/pinnace.md stories 4 and 15 vs task goal.)
