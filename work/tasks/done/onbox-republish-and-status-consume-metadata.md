---
title: Finish story 5 — republish honours metadata.mode, status reports ensName + mode
slug: onbox-republish-and-status-consume-metadata
spec: sites-metadata-in-mfs
promptGuidance.testFirst: true
blockedBy: [site-metadata-write-path-no-silent-loss]
covers: [5]
---

## What to build

Spec story 5 promises the on-box loop reads each site's MFS metadata so that **per-site behaviour (eth.limo warming, ipns vs ipfs) is driven by what the node can actually see**. Only the `warm` third shipped (`onbox-loop-reads-metadata-ensname-warming`). The other two consumers still ignore the metadata sitting right beside the content:

### 1. `republish` must honour `metadata.mode`

`republishAndExport` (`src/publisher/record-sequence.ts`) decides whether to sign PURELY from keystore key presence: `keys.get(site.id)` -> publish, else report `no-key`. So a site the operator deliberately stores as `mode: ipfs` is STILL signed and republished whenever a key happens to exist for its id (e.g. left over from an earlier ipns life, or derived for a sibling purpose). The stored mode, the operator's actual statement of intent, is not consulted.

New resolution, per site:

- stored `mode: 'ipfs'` -> do NOT publish, even if a key exists. Report a distinct outcome (e.g. `ipfs-mode`) so the operator can see WHY it was skipped; do not reuse `no-key`, which would be a lie.
- stored `mode: 'ipns'` + a key -> publish exactly as today.
- stored `mode: 'ipns'` + NO key -> `no-key` exactly as today.
- mode ABSENT (a site placed before metadata existed, or by an older pinnace) -> fall back to TODAY's behaviour (key presence decides). This back-compat tier is load-bearing: it must not silently stop republishing an existing live site that has no stored mode yet.

Note the ordering guarantee this rests on: its `blockedBy` task makes `site add` stop demoting a stored `ipns` site to `ipfs`. Without that, this change would turn a stray `site add` into a silent republish outage. Do not weaken it.

### 2. `status` must report `ensName` + `mode`

`SiteStatus` (`src/status/status-report.ts`) carries `id`/`cid`/announced/gateway but nothing from the metadata, so an operator cannot SEE what the box will actually do with a site. `DiscoveredSite.metadata` is already threaded to this point by the seam task, so this is a plumb-and-render, not a new read.

- `SiteStatus` gains the site's `mode` and `ensName` as stored (preserving the three-valued `ensName`: a name, `""`, or absent must remain distinguishable in the reported shape, not flattened to `''`).
- The status JSON payload and the rendered dashboard (`src/status/status-html.ts`, and the `node status` payload in `src/node/node-commands.ts`) surface them. Show the RESOLVED eth.limo target too where it is useful (reuse `resolveEnsNameToWarm` — do not re-implement the three-way rule), so the dashboard answers "will this site be warmed, and under what name?" directly.
- Keep the rendering scoped: add the columns/fields, do not restyle the dashboard.

## Acceptance criteria

- [ ] `republish` does NOT publish a site whose stored `mode` is `ipfs`, even when a key exists for its id, and reports a distinct non-`no-key` outcome explaining the skip (tested).
- [ ] `republish` publishes a stored-`ipns` site with a key exactly as before; reports `no-key` for a stored-`ipns` site with no key (tested).
- [ ] A site with NO stored mode falls back to today's key-presence behaviour, so an existing live site keeps being republished (tested — this is the back-compat guard).
- [ ] `SiteStatus` carries the stored `mode` and `ensName`, with `""` still distinguishable from ABSENT in the reported shape (tested both).
- [ ] The status JSON and the rendered dashboard show `mode` + `ensName` (and the resolved eth.limo target, via `resolveEnsNameToWarm`, not a re-implementation).
- [ ] Test-first, at the mock Kubo seam; no live daemon. A changeset is included.

## Blocked by

- Blocked by `site-metadata-write-path-no-silent-loss` — republish honouring `metadata.mode` makes a metadata-wiping write path an outage, so the wipe holes must close first.

## Prompt

> Goal: deliver the two thirds of spec story 5 that did not ship, so the on-box loop and the status report act on the metadata they can already see. Read `src/publisher/record-sequence.ts` (`republishAndExport`), `src/status/status-report.ts` + `src/status/status-html.ts`, `src/node/node-commands.ts` (`discoverSites` already supplies `DiscoveredSite.metadata`), and `src/site/site-wrapper.ts` (`resolveEnsNameToWarm`, the read side you must REUSE).
>
> `republish` currently signs on keystore-key presence alone, ignoring the operator's stored `mode`. Make stored `ipfs` mean "do not sign" with its own reported outcome, stored `ipns` behave as today, and an ABSENT mode fall back to today's key-presence rule so existing live sites keep republishing.
>
> `status` currently reports nothing from the metadata. Thread the stored `mode` + `ensName` (keeping `""` distinct from absent) into `SiteStatus`, the JSON payload and the dashboard, plus the resolved eth.limo target via the existing rule.
>
> Done means: what a site's `metadata.json` says is what the box does, and what the operator sees.
