---
title: Decisions taken while building the MFS site-wrapper + metadata seam
date: 2026-07-25
status: open
taskOf: mfs-site-wrapper-layout-and-metadata-seam
---

Three choices the task left open, decided during the build. Each is recorded durably at its code site; this note is the discoverable index so a reviewer/human can ratify or reverse them.

- **`site add` writes `{mode: 'ipfs'}`.** `placeInMfs` now ALWAYS writes the wrapper's `metadata.json`, and `add` has no mode surface, so it records the mode it actually performed (place an existing CID, no key, no `name/publish` = `ipfs` mode per CONTEXT.md, matching `pin`'s default). Touches the sibling `deploy-pin-write-site-metadata` field: re-`add`ing over an existing ipns-mode site rewrites its metadata to `{mode: 'ipfs'}` and drops an `ensName` set there (restored by a `deploy`/`pin` with the intended mode; that task's read-modify-write preserve semantics could later be extended to `add`). Alternatives considered: a `metadata`/`mode` input on `add` with no CLI flag behind it; or leaving `metadata.json` untouched when the caller has nothing to say (which would make the shared `placeInMfs` seam two-behaviour). Recorded at `packages/pinnace/src/site/site-management.ts` (`addSite` JSDoc).
- **`SiteMetadata` has BOTH fields optional** (`{ensName?, mode?}`) although the spec's write shape is `{ensName?, mode}`. It is the shape as STORED, and the read side must be able to represent absent/partial metadata without inventing a `mode`; every write path supplies `mode`. Recorded at `packages/pinnace/src/site/site-wrapper.ts` (`SiteMetadata` JSDoc).
- **The absence/outage conflation in `readSiteMetadata` is accepted** (the open question the `kubo-client-files-read-write` review left for this task): Kubo exposes no narrow not-found, so a missing `metadata.json`, a down node and a bad token all raise the same `KuboRpcError` and all read as empty metadata. Bounded by the `files/ls` + `files/stat` that precede it in the same discovery pass. Recorded at `packages/pinnace/src/site/site-wrapper.ts` (`readSiteMetadata` JSDoc).
