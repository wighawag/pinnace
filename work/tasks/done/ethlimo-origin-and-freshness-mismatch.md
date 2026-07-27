---
title: Surface eth.limo MISMATCHES — is ENS pointing at us, and is it serving our current CID
slug: ethlimo-origin-and-freshness-mismatch
spec: sites-metadata-in-mfs
promptGuidance.testFirst: true
blockedBy: []
covers: [5, 6]
---

## What to build

`status` currently answers "does `<name>.limo` respond?" (`ethLimoServes`). It cannot answer the two questions that actually matter, and a live box is in a state where every existing indicator is GREEN while the site is not being served by pinnace at all:

```
x-ipfs-path:  /ipns/k51qzi5uqu5dlu1ien9spji7pu49mfw97mn0qv4azugqcvenj0dvzq9bgwp1zc/   <- the SOURCE name
x-ipfs-roots: bafybeiepw4aijr4dtlhth2xkzskxaxcjvtk6neqsd6zua7rfv6m5nbkesu             <- our cid
```

That site's OWN pinnace name is `k51qzi5uqu5diifcue0h8g3dxnd0vjaaft5h8ocqcfit2th2ulcg4mdjdtjmo5`. The operator pinned content with `pin --from-ipns` but has not repointed the ENS contenthash, so eth.limo still resolves through the OLD publisher's name while pinnace republishes an ORPHANED name nothing references. It looks perfectly healthy until the old publisher stops refreshing, at which point the site goes dark. Nothing in pinnace can currently say this.

IPFS gateways return the headers that reveal it, and the eth.limo probe already makes exactly the right HTTP request and throws its headers away.

### Two INDEPENDENT axes (do not collapse them into one verdict)

Both are three-valued per the `CONTEXT.md` convention (a check that could not run reports `unknown` with a reason, never a confident negative):

1. **origin** — does the ENS name resolve through THIS SITE's identity?
   - `ours`: `x-ipfs-path` references the site's own ipns id (ipns mode) or its cid (ipfs mode).
   - `foreign`: it references some OTHER name/cid — report WHAT it points at, since that is the actionable detail (the operator needs to see the wrong name to fix their ENS record).
   - `unknown`: header absent, or the probe failed (with reason).
   - not-applicable: the site resolves no ENS name at all (keep DISTINCT from `unknown`, as the existing eth.limo column already does).
   - NOTE the sub-case: an `ipns`-mode site whose path is `/ipfs/<cid>` has ENS pinned to an IMMUTABLE cid, so it will never follow future deploys even if that cid is currently correct. Surface that distinctly (it is an `ours`-but-frozen or a `foreign`, but either way the operator must know their ENS will not track deploys).
2. **freshness** — is the served root OUR CURRENT cid?
   - `current`: `x-ipfs-roots` equals the site's cid.
   - `stale`: it differs — report the SERVED cid. A mismatch shortly after a deploy is NORMAL IPNS propagation/gateway-cache lag, NOT a fault: render it as a neutral/attention state, never the red negative indicator.
   - `unknown`: header absent or probe failed.

### Widening the probe seam

`GatewayProbe` is `(url) => Promise<number>` and discards the response headers. Widen it MINIMALLY to also carry the headers this needs (e.g. a small result object with the status plus the selected headers). Keep ONE probe seam: the module comment already states that a second probe type would be "a second thing to inject, fake and keep honest", and that reasoning stands. Tests inject a fake returning chosen headers; no live network.

### Honesty about what this measures

This observes what **eth.limo actually resolved and served**, through its own cache. It is NOT a read of the ENS record. So it can lag reality and cannot distinguish "the contenthash is wrong" from "eth.limo cached an old resolution". Say so in the code docs and in any operator-facing wording: it answers "what is eth.limo serving for this name, and does it come from us?", and must not claim to have read ENS. Reading ENS would need an Ethereum RPC, which is deliberately out of scope (CONTEXT.md: wiring a name into ENS is the consumer's job).

## Acceptance criteria

- [ ] `origin` reports `foreign` (naming the referenced name/cid) when `x-ipfs-path` points at something other than the site's own ipns id / cid — the live regression above (tested with that exact header pair).
- [ ] `origin` reports `ours` when the path references the site's own ipns id (ipns mode) or its cid (ipfs mode) (tested both modes).
- [ ] An `ipns`-mode site whose ENS path is `/ipfs/<cid>` is surfaced distinctly as not tracking deploys, even when that cid is current (tested).
- [ ] `freshness` reports `stale` NAMING the served cid when `x-ipfs-roots` differs, and `current` when it matches (tested both).
- [ ] A missing header or failed probe reports `unknown` WITH a reason on both axes, never a confident negative (tested).
- [ ] A site with no resolved ENS name reports not-applicable on both axes, distinct from `unknown` (tested).
- [ ] Both axes appear in the CLI `status` line, the JSON payload (machine-readable) and the DASHBOARD; `stale` and `unknown` render as neutral/attention states, NOT the red negative used for a real failure (tested).
- [ ] `GatewayProbe` is widened once and stays the single probe seam; no second probe type is introduced; the CID-gateway probe still works through it (tested).
- [ ] Nothing throws or fails the report when eth.limo is down or header-less (tested).
- [ ] Code docs state plainly that this observes eth.limo's resolution+cache, not the ENS record, and cannot tell a wrong contenthash from a stale gateway cache.
- [ ] Test-first; no live network. A changeset is included.

## Blocked by

- None. `src/status/status-report.ts`, `src/status/status-html.ts`, `src/status/check-outcome.ts`, the `status` CLI arm.

## Prompt

> Goal: make `status` able to say "your ENS name is not pointing at this site" and "eth.limo is serving an older CID". Read `src/status/status-report.ts` (`GatewayProbe`, `probeGateway`, the eth.limo probe added by `ethlimo-warming-status-visible-and-honest`, `SiteStatus`), `src/status/check-outcome.ts` (the three-state helper), `src/status/status-html.ts`, and the `## Conventions` rule in CONTEXT.md.
>
> A live box shows `x-ipfs-path: /ipns/<SOURCE name>` while pinnace publishes a DIFFERENT name: the operator pinned from an old publisher and never repointed ENS, so pinnace republishes an orphaned name and the site dies the day the old publisher stops. Every current indicator is green.
>
> Add two INDEPENDENT three-valued axes, origin (ours / foreign-naming-what / unknown / n-a) and freshness (current / stale-naming-the-served-cid / unknown), from the `x-ipfs-path` and `x-ipfs-roots` headers the probe already receives and discards. Widen the ONE probe seam rather than adding a second. Render stale/unknown neutrally: post-deploy lag is normal, not a fault.
>
> Be honest in the docs: this reads eth.limo's resolution through its cache, not the ENS record.
