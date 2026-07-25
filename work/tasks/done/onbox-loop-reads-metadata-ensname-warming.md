---
title: On-box loop reads MFS metadata — ensName three-way eth.limo warming (explicit > .eth-infer > "" opt-out)
slug: onbox-loop-reads-metadata-ensname-warming
spec: sites-metadata-in-mfs
promptGuidance.testFirst: true
blockedBy: [mfs-site-wrapper-layout-and-metadata-seam]
covers: [5, 6]
---

## What to build

Make the on-box `warm` verb resolve eth.limo warming from each site's MFS `metadata.ensName` (now available on `DiscoveredSite` via the seam task), with the three-way rule the earlier cancelled task wanted — now IMPLEMENTABLE because the box reads metadata from MFS, the thing it can see. This is the payoff of the whole reshape: the `ensName` lever finally reaches the on-box loop.

Resolution (per site, in `warm`):
1. **`metadata.ensName` explicitly set (non-empty)** -> warm `https://<ensName>.limo/`.
2. **`ensName` absent AND the site `id` ends in `.eth`** -> INFER `ensName = id`, warm `https://<id>.limo/`.
3. **`ensName` set to `""` (empty)** -> OPT OUT: do NOT warm eth.limo even for a `.eth` id.
4. **`ensName` absent AND id does not end `.eth`** -> no eth warming.

So precedence: explicit non-empty (warm it) > `""` (opt out) > `.eth`-suffix inference (warm the id) > nothing. Replace the current `if (site.id.endsWith('.eth'))` heuristic in `defaultWarm`/the warm op with this metadata-driven resolution. The `""`-vs-absent distinction is load-bearing (the seam task preserved it through read; use it here). Warming failures stay recorded-not-thrown (a cold gateway must not fail the verb), unchanged.

Also: any other on-box consumer of per-site metadata that is cheap and in-scope — e.g. `mode` from metadata where a verb needs it — may read it off `DiscoveredSite` now; but the headline is the ensName warming resolution. Do NOT expand scope beyond warming + trivially reading mode.

## Acceptance criteria

- [ ] `warm` resolves eth.limo per the four cases: explicit non-empty warms `<ensName>.limo`; absent + `.eth` id infers + warms `<id>.limo`; `""` opts out (no eth warming even for a `.eth` id); absent + non-`.eth` does nothing.
- [ ] The resolution reads `metadata.ensName` off the discovered site (from MFS), NOT the bare `id.endsWith('.eth')` heuristic; the id/identity no longer triggers ENS warming on its own.
- [ ] The `""`-opt-out is distinguished from absent (uses the preserved distinction from the seam task); a test covers all four cases at the warm seam (mock + a fake gateway/warm layer).
- [ ] Warming failures are still recorded, never thrown.
- [ ] Test-first; no live network (fake the gateway probe/warm as the existing warm tests do).

## Blocked by

- Blocked by `mfs-site-wrapper-layout-and-metadata-seam` (needs `metadata` on `DiscoveredSite`).

## Prompt

> Goal: resolve eth.limo warming from each site's MFS `metadata.ensName` with a three-way rule, replacing the `id.endsWith('.eth')` heuristic. This is what the cancelled `ensname-resolution-and-eth-opt-out` task wanted, now buildable because the box reads metadata from MFS (`work/notes/observations/ensname-hint-channel-to-onbox-warm-undecided.md`). Read the spec `sites-metadata-in-mfs` (story 6), the done task `node-agent-commands` (the `warm` verb + `defaultWarm`), and the sibling seam task (`DiscoveredSite.metadata`).
>
> Rule (per site): explicit non-empty `metadata.ensName` -> warm `<ensName>.limo`; absent + `.eth` id -> infer, warm `<id>.limo`; `ensName: ""` -> opt out (no eth warming even for a `.eth` id); absent + non-`.eth` -> nothing. Precedence: explicit > empty-opt-out > `.eth`-infer > nothing. Use the preserved `""`-vs-absent distinction from the seam. Keep warm failures recorded-not-thrown. Test-first at the warm seam (mock Kubo + fake gateway) covering all four cases; no live network. Done means `ensName` is the real lever, a `.eth`-named site auto-warms eth.limo, and `ensName: ""` cleanly opts out — driven by MFS metadata the on-box loop can see.
