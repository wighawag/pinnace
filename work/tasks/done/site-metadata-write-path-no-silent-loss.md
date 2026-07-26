---
title: Close the silent metadata-loss holes on the write path (site add preserves; a failed read REFUSES)
slug: site-metadata-write-path-no-silent-loss
spec: sites-metadata-in-mfs
promptGuidance.testFirst: true
blockedBy: []
covers: [3, 4]
---

## What to build

The reshape established a guarantee for `deploy`/`pin`: **a write never silently discards per-site metadata the operator did not restate** (omitting `--set-ens-name`/`--set-mode` PRESERVES). Two holes remain where that guarantee leaks, both raised by the review gate. Close BOTH; they are the same defect wearing two hats, so they share one seam and one task.

### Hole 1 — `site add` does not preserve at all

`addSite` calls `placeInMfs(..., {mode: 'ipfs'})` UNCONDITIONALLY (`src/site/site-management.ts`). So a `site add` over an existing site WIPES its stored `ensName` and DEMOTES its stored `mode` to `ipfs`. Its current DECISION block argues `add` "writes the mode it actually performed", which is true of the placement but is not a licence to destroy the OTHER field, nor to overwrite a mode the operator set deliberately.

Make `add` use the SAME preserve semantics its sibling verbs use: read-modify-write through `resolveSiteMetadataToWrite` with `PRESERVE_ENS_NAME` and a PRESERVE mode intent, so re-`add`ing an existing site keeps its `ensName` and its stored `mode`, and a FIRST `add` (nothing stored) still records `ipfs`. Rewrite that DECISION block: the reason `add` records `ipfs` is that `ipfs` is the DEFAULT for a site that stores no mode, not that `add` performed an ipfs-shaped placement.

### Hole 2 — `preserve` treats a FAILED read as "nothing stored"

`readSiteMetadata` absorbs EVERY `filesRead` error into `{}`. That conflation was consciously accepted for the READ/discovery path (a cold `warm` loop must not die on one unreadable file) and it is fine there. But `resolveSiteMetadataToWrite`'s `preserve` branch reuses it on a **destructive WRITE path**, so a node that is down, or answering 401 on a stale token, makes a no-flag re-deploy resolve to `ipfs`, write `mode: ipfs` into the surviving nodes, drop the stored `ensName`, and exit 0 reporting success.

On the WRITE path, absence must be established **POSITIVELY, never inferred from an error**:

- Establish "this site stores no metadata" from a SUCCESSFUL listing: `files/ls` the wrapper (and/or `/sites` to see whether the site exists at all) and observe that `metadata.json` is not among the entries. A successful response that does not list the file is a real absence.
- Any OTHER failure (the listing itself fails, or the file is listed but the read fails) is an OUTAGE, not an absence: **REFUSE the write with a loud error** naming the site, the node, and what could not be read. Refusing is correct because the alternative is destroying stored state on a guess, and a genuinely absent file is now positively detectable.
- Do NOT sniff Kubo's error TEXT to spot "file does not exist" (brittle across versions; already rejected in the existing decision note). The positive-listing signal is the mechanism.

Keep `readSiteMetadata`'s tolerant behaviour for the READ/discovery path EXACTLY as it is (`discoverSites`/`warm` must stay resilient). This task splits the two callers apart: tolerant for discovery, strict for writes. Update the DECISION block on `readSiteMetadata` so it says the conflation is accepted for DISCOVERY only, and name the strict write-side path beside it.

Extra RPC calls on the write path are acceptable: `deploy`/`pin`/`add` are not hot, and correctness of stored state beats one round trip.

## Acceptance criteria

- [ ] `site add` over an EXISTING site preserves its stored `ensName` and its stored `mode` (tested: a site stored `{ensName: 'x.eth', mode: 'ipns'}` re-added still reads `{ensName: 'x.eth', mode: 'ipns'}`); a FIRST `add` records `{mode: 'ipfs'}` with no `ensName` key.
- [ ] `site add` goes through the SAME `resolveSiteMetadataToWrite` seam as `deploy`/`pin` (no parallel resolver, no second read).
- [ ] The write path establishes absence POSITIVELY from a successful listing; a site with no stored `metadata.json` still writes cleanly (first deploy/pin/add works, no refusal).
- [ ] A `files/read`/listing FAILURE on the write path REFUSES the write with a loud error naming the site + node + the failed step, and writes NOTHING — asserted for `deploy`, both `pin` entry points, and `site add`. It must NOT resolve to `ipfs` and exit 0.
- [ ] The tolerant discovery path is UNCHANGED: `discoverSites`/`warm` still read absent/malformed metadata as `{}` and never fail the run (existing tests stay green, and one asserts a failing metadata read still discovers the site).
- [ ] The `readSiteMetadata` DECISION block distinguishes the tolerant discovery caller from the strict write caller; the `addSite` DECISION block is rewritten as described.
- [ ] Test-first, at the mock Kubo seam; env/config isolated; no live daemon. A changeset is included.

## Blocked by

- None — can start immediately.

## Prompt

> Goal: close the two holes through which pinnace can still silently destroy a site's stored MFS metadata. Read `src/site/site-wrapper.ts` (`resolveSiteMetadataToWrite`, `readSiteMetadata` and its DECISION block), `src/site/site-management.ts` (`addSite`, `placeInMfs`), and the decisions notes under `work/notes/observations/` for the ens/mode intent design you are extending.
>
> Hole 1: `addSite` hard-writes `{mode: 'ipfs'}`, wiping an existing site's `ensName` and demoting its `mode`. Give it the same preserve semantics as `deploy`/`pin`, through the same resolver.
>
> Hole 2: `preserve` resolves a FAILED metadata read as "nothing stored", so a down or 401ing node makes a no-flag re-deploy silently demote the site to `ipfs`, drop its `ensName`, and exit 0. On the WRITE path, establish absence POSITIVELY from a successful `files/ls` (the file is genuinely not listed) and REFUSE loudly on any other failure. Do not sniff Kubo's error text. Leave the tolerant read alone for `discoverSites`/`warm` — that conflation is correct for discovery and wrong only for writes.
>
> Done means: no code path can overwrite stored per-site metadata on the strength of an error it could not interpret.
