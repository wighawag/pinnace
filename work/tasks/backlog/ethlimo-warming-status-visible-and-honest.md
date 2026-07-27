---
title: Make eth.limo warming VISIBLE (probe it in status/dashboard) and HONEST (warm stops lying)
slug: ethlimo-warming-status-visible-and-honest
spec: sites-metadata-in-mfs
promptGuidance.testFirst: true
blockedBy: []
covers: [5, 6]
---

## What to build

For a `.eth` site, `https://<name>.limo/` is the URL a human actually visits. Right now NOTHING tells you whether it works, from either side of the system:

1. **`status` never probes it.** The report carries `ensNameToWarm` (WHICH name would be warmed), and the dashboard even has an `eth.limo` column, but the only HTTP probe is `https://<cid>.ipfs.dweb.link/` (`gatewayHttp`/`gatewayServes`). The `eth.limo` column prints a NAME, not a status. So the dashboard answers "what would we warm?" and never "does it serve?".
2. **`warm` reports success unconditionally.** `safeWarm` swallows the error and `defaultWarm` pushes `{status: 'warmed'}` for every site regardless — a site whose every warm threw still reports `warmed`. (There is even an existing test named "records a failing warm" that asserts every site reports `warmed`.) So the on-box loop cannot tell you either.

Fix both halves. They are one deliverable: an operator must be able to see whether eth.limo warming is actually working.

### Half 1 — probe the eth.limo URL in `status`

- Probe `https://<ensNameToWarm>.limo/` for each site that RESOLVES one (skip sites where `resolveEnsNameToWarm` returns undefined: `""` opt-out and non-`.eth` ids have nothing to probe, and must not be reported as a failure).
- Reuse the EXISTING injectable-probe discipline (`GatewayProbe`, the `fetch`-backed default supplied in production, a fake in tests) so nothing reaches the live network in tests. Do not invent a second probe mechanism; if the existing probe signature does not fit a full URL, widen it minimally rather than forking it.
- `SiteStatus` gains the probe result (status code + a served boolean), alongside the existing `ensName` / `ensNameToWarm`. A site with no resolved name reports the probe as NOT APPLICABLE, distinct from "probed and failed".
- Surface it in all three places the other fields already appear: the CLI `status` line, the JSON payload, and the dashboard's `eth.limo` column (which should show the name AND whether it serves). Keep the existing `announced` / `gateway` columns unchanged.
- A probe failure is REPORTED, never thrown: `status` must keep working when eth.limo is down, exactly as the CID-gateway probe already does.

### Half 2 — `warm` stops claiming success it does not have

- `defaultWarm` must report the site's ACTUAL warm outcome. A site whose warms all failed must NOT report `warmed`; give it a distinct outcome (e.g. `warm-failed`, and consider a partial state when the CID gateways succeeded but eth.limo did not, since that is the interesting case for a `.eth` site).
- The load-bearing invariant STAYS: a cold or broken gateway must NEVER fail the verb or throw. Warming failures are RECORDED, not raised. This task changes what is recorded, not the error policy.
- Fix the existing test whose name promises it "records a failing warm" while asserting `warmed`; it should assert the failure is actually recorded.

## Acceptance criteria

- [ ] `status` probes `https://<name>.limo/` for every site with a RESOLVED ens name, and reports its result (tested via an injected fake probe, never the live network).
- [ ] A site with NO resolved name (`""` opt-out, or a non-`.eth` id with no explicit name) reports the eth.limo probe as not-applicable, clearly distinct from "probed and failed" (tested both).
- [ ] The eth.limo probe result appears in the CLI `status` line, the JSON payload, and the dashboard's `eth.limo` column (name AND serving state); `announced` / `gateway` columns are unchanged (tested).
- [ ] An eth.limo probe failure does not throw and does not fail `status`; the rest of the report still renders (tested).
- [ ] `defaultWarm` reports a distinct non-`warmed` outcome for a site whose warming failed, and still NEVER throws (tested).
- [ ] The mis-named existing test that asserts `warmed` for a failing warm is corrected to assert the recorded failure.
- [ ] The three-valued `ensName` remains intact end to end: `""` still prints `opted-out`, absent still prints `unset`, and neither is flattened by the new field (tested).
- [ ] Test-first; no live daemon and no live network. A changeset is included.

## Blocked by

- None. Touches `src/status/status-report.ts`, `src/status/status-html.ts`, `src/node/node-commands.ts` and the `status` CLI arm.

## Prompt

> Goal: let an operator SEE whether eth.limo warming works. Read `src/status/status-report.ts` (`SiteStatus`, `ensNameToWarm`, the injectable `GatewayProbe` + `probeGateway`, `checkAnnounced`), `src/status/status-html.ts` (the `eth.limo` column, which today prints a name), `src/node/node-commands.ts` (`defaultWarm`, `safeWarm`, and the always-`warmed` outcome), and `src/site/site-wrapper.ts` (`resolveEnsNameToWarm`, which decides whether there is anything to warm at all).
>
> For a `.eth` site, `<name>.limo` is the URL humans use, and nothing in pinnace reports on it: `status` only probes the CID gateway, and `warm` reports `warmed` even when every fetch failed. Probe the resolved eth.limo URL through the existing injectable-probe discipline and surface it in the CLI line, the JSON and the dashboard column; and make `warm` record what actually happened.
>
> Keep the error policy: warming failures are recorded, never thrown. A site with no resolved ens name has nothing to probe and must read as not-applicable, not as a failure.
