---
title: An INFERRED ensName must not display as "none"/"unset" (CLI + dashboard)
slug: show-inferred-ens-name-not-none
spec: sites-metadata-in-mfs
promptGuidance.testFirst: true
blockedBy: []
covers: [6]
---

## What to build

Both renderers describe the STORED `ensName` field, but the column is READ as "what is this site's ENS name?". For a `.eth` site with no stored name the two answers differ, and the row contradicts itself. Real output from a live box:

```
ronan.eth: ... mode ipns ensName unset eth.limo ronan.eth.limo
```

and on the dashboard, a grey `none` in the `ens name` cell beside a ticked `ronan.eth.limo` in the next cell. The site plainly HAS an effective ENS name (`ronan.eth`, inferred from the id); saying `none`/`unset` next to a working eth.limo link is misleading.

The information to fix it is already present in both renderers: `ensName` (stored, three-valued) and `ensNameToWarm` (resolved by `resolveEnsNameToWarm`). Distinguish FOUR display states:

| stored `ensName` | `ensNameToWarm` | display |
| --- | --- | --- |
| a name | that name | the name (as today) |
| `""` | absent | opted out (as today) |
| absent | a name | **the INFERRED name, marked as inferred** (the broken case) |
| absent | absent | none / unset (as today) |

- **CLI** (`printedEnsName` in `src/cli/run.ts`): show the inferred name and mark it, e.g. `ronan.eth (inferred)`. It needs the resolved name, so pass it in rather than re-deriving.
- **Dashboard** (`renderSiteRow` in `src/status/status-html.ts`): same four states. Mark the inferred one visually distinct from a STORED name (they are not the same thing: an inferred name follows the id, a stored one overrides it), e.g. the name in `<code>` plus a muted `(inferred)` hint. Keep the existing `.none` styling for the genuinely-none case.
- The renderer must stay a PURE VIEW: it resolves nothing itself (`StatusPageSite.ensNameToWarm` is already resolved by the report; the existing "The renderer resolves NOTHING itself" note stays true).
- **Consolidate if it is clean to do so.** The three-state logic is currently duplicated in `printedEnsName` and `renderSiteRow`, which is exactly why they can drift. If a shared helper fits without dragging CLI formatting into the HTML renderer (or vice versa), prefer it; if it would couple them awkwardly, leave them separate and note why. Do not force it.

Do NOT change any RESOLUTION behaviour: `resolveEnsNameToWarm`, the stored three-valued field, and what gets warmed are all correct and must not move. This is display only.

## Acceptance criteria

- [ ] A `.eth`-id site with NO stored `ensName` displays the INFERRED name marked as inferred, in BOTH the CLI `status` line and the dashboard cell — not `unset`/`none` (tested both renderers).
- [ ] A site with a STORED name still displays that name, visually distinguishable from an inferred one (tested).
- [ ] `""` still displays as opted out, in both (tested).
- [ ] A non-`.eth` id with no stored name still displays none/unset in both (tested).
- [ ] The dashboard renderer still resolves nothing itself; it consumes the already-resolved `ensNameToWarm` (asserted by the existing pure-view expectations).
- [ ] No change to warming resolution, the stored metadata, or the JSON payload's raw `ensName`/`ensNameToWarm` fields (they stay machine-readable and unannotated; the annotation is presentation only).
- [ ] Test-first; no live daemon. A changeset is included.

## Blocked by

- None. `src/cli/run.ts` + `src/status/status-html.ts`.

## Prompt

> Goal: stop telling an operator a site has no ENS name when it demonstrably has an inferred one. Read `printedEnsName` in `src/cli/run.ts`, `renderSiteRow` in `src/status/status-html.ts`, and `resolveEnsNameToWarm` in `src/site/site-wrapper.ts`.
>
> Both renderers describe the STORED field, so a `.eth` site with no stored name prints `unset`/`none` right beside a working `ronan.eth.limo` link. Use the already-resolved `ensNameToWarm` to tell "absent but inferred" apart from "absent and nothing", and show the inferred name marked as inferred. Keep a stored name visually distinct from an inferred one.
>
> Display only: resolution, storage and the JSON payload do not move. The HTML renderer stays a pure view.
