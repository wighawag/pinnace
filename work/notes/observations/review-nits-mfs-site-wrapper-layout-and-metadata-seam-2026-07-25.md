---
title: review-gate non-blocking nits for 'mfs-site-wrapper-layout-and-metadata-seam' (Gate 2 approve)
date: 2026-07-25
status: open
reviewOf: mfs-site-wrapper-layout-and-metadata-seam
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'mfs-site-wrapper-layout-and-metadata-seam' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify the site add default: addSite now writes {mode: ipfs} unconditionally. The recorded consequence is that re-adding over an ipns-mode site drops its ensName, but there is a second, larger one the note misses: once the on-box loop reads metadata.mode (backlog task onbox-loop-reads-metadata-ensname-warming, spec story 5), a stray site add over an ipns site silently DEMOTES it to ipfs and stops republish until a re-deploy. Confirm this is acceptable, or give add a mode surface / read-modify-write preserve like the sibling deploy-pin-write-site-metadata task.
  (packages/pinnace/src/site/site-management.ts:205 addSite -> placeInMfs(..., {mode: 'ipfs'}); decision note work/notes/observations/site-wrapper-metadata-seam-decisions.md)
- Ratify making the metadata parameter of the exported placeInMfs REQUIRED. The task asked for a defaulted arg (adding the metadata arg with a sensible default so nothing breaks); the build instead made it mandatory and passed a real mode at every call site. That is arguably better (no silent per-site state authored at the shared seam) but it is a breaking change to a public API exported from index.ts, released as a changeset minor on 0.6.0 (the 0.x breaking bump, so semver-wise fine).
  (packages/pinnace/src/site/site-management.ts:230 placeInMfs signature; .changeset/mfs-site-wrapper-layout-and-metadata-seam.md)
- Ratify the two decisions recorded in the note and at their code sites: (a) SiteMetadata has BOTH fields optional though the spec write shape is {ensName?, mode}; (b) readSiteMetadata absorbs ALL filesRead errors, so a missing metadata.json, a down node and a bad token are conflated as empty metadata (bounded by the files/ls + files/stat that precede it in the same discovery pass).
  (packages/pinnace/src/site/site-wrapper.ts SiteMetadata and readSiteMetadata JSDoc)
- Migration path for OLD flat-layout sites is thinner than it reads. A plain re-deploy over an existing flat /sites/<id> SUCCEEDS silently (files/mkdir --parents on the existing content dir, then cp into <id>/content), leaving the previous site tree as garbage inside the wrapper; and site remove of a not-yet-migrated flat site can no longer resolve a content cid, so it removes the entry but reports unpinned false and leaks the pin. Spec story 8 (delete + re-deploy migration) is covered only by the changeset MIGRATION note; no backlog task carries covers 8. Confirm the note is enough or task the migration doc.
  (spec sites-metadata-in-mfs story 8 / Out of Scope; site-management.ts removeSite statCid on the content subpath; backlog covers lists are 1,2 / 3,5,6 / 3,4,6 / 5,6 / 1,2,4,6)
- Ratify the widened public API: index.ts now re-exports siteWrapperPath, siteContentPath, siteMetadataPath, encodeSiteMetadata, parseSiteMetadata, readSiteMetadata, SITE_CONTENT_ENTRY, SITE_METADATA_ENTRY and SiteMetadata. The task only required the seam change; exporting the whole path/codec module freezes eight more names as library surface.
  (packages/pinnace/src/index.ts:116-127)
