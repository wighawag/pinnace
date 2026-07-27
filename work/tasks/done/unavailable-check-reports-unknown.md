---
title: An unavailable check must report UNKNOWN, never a confident negative (announced, gateway, eth.limo) + pin the rule
slug: unavailable-check-reports-unknown
spec: sites-metadata-in-mfs
promptGuidance.testFirst: true
blockedBy: []
covers: [5]
---

## What to build

`status` makes THREE external checks, and every one of them reports a confident NEGATIVE when the check merely FAILED TO RUN. A live box demonstrated it: the CLI reported `announced=false` for a site whose peer was, at that moment, verifiably listed by the delegated router (third of three providers, correct box IP). The dashboard, generated on the box, said announced OK. The CLI was not reporting reality; it was reporting its own failed lookup.

```ts
if (!res.ok) return {Providers: []};   // 429 / 4xx / 5xx -> reads as "not announced"
...
} catch { return false; }              // network / DNS / parse -> reads as "not announced"
if (!peerId) return false;             // could not even identify the node -> same
```

The same shape applies to the CID-gateway probe and the eth.limo probe: a probe that could not be MADE is recorded identically to a gateway that answered and did not serve.

This is the FIFTH instance of one defect class in this codebase (the earlier four: `readSiteMetadata` on the write path treating an outage as "no metadata"; `deploy --set-mode ipns` treating "cannot sign" as "nothing to do"; a bare `--endpoint` treating a missing value as "not supplied"; an unknown `--mode` treating an unreadable flag as no flag). Fix it here AND pin the rule so it stops recurring.

### 1. Three-state the three external checks

Each of `announced`, the CID-gateway serve check, and the eth.limo serve check becomes THREE-valued: **yes** / **no** / **unknown (could not check)**, with the REASON carried (an HTTP status, or a short error kind).

- `!res.ok` must NOT be flattened into an empty provider list. Distinguish "the router answered, your peer is not in it" (a real no) from "the router did not answer" (unknown), carrying the status code (a `429` is the expected rate-limit case and must read as unknown, never as a red cross).
- A thrown/network/parse failure is UNKNOWN, not a no.
- `!peerId` is UNKNOWN (we could not identify the node), not a no.
- The eth.limo check already has a NOT-APPLICABLE state (no resolved name, shipped in `ethlimo-warming-status-visible-and-honest`). Keep that DISTINCT from the new unknown: "nothing to check" and "could not check" are different answers. Four display states total for that column.
- Surface it in all three renderers: the CLI `status` line (e.g. `announced=unknown (429)`), the JSON payload (machine-readable, unannotated), and the dashboard (a muted/neutral indicator plus the reason, NOT the red cross that means a real negative).
- Keep the existing error policy: none of these checks may throw or fail the report. This changes what is RECORDED, not whether failures propagate.
- The overall per-site `status: 'ok' | 'unverified'` roll-up must treat unknown as UNVERIFIED, never as ok and never as a failure.

### 2. Pin the rule in `CONTEXT.md`

Add to the existing `## Conventions` section a standing rule, in the same voice as the changeset rule already there. It must state, concisely:

> A check that could not RUN never reports a definitive negative. Distinguish "we asked and the answer is no" from "we could not ask", and say which. A swallowed error that becomes `false` / `{}` / "absent" is a bug, not a default.

Reference the worked examples so it is not abstract: the metadata read (tolerant for DISCOVERY, strict for WRITES), and these three status checks. Keep it SHORT: it is a convention, not an essay, and the detail lives in the code it describes.

## Acceptance criteria

- [ ] A providers lookup returning non-2xx (e.g. `429`) reports announced as UNKNOWN with the status code, NOT `false` (tested).
- [ ] A providers lookup that THROWS reports UNKNOWN, not `false` (tested).
- [ ] A providers lookup that SUCCEEDS without the peer still reports a real `no` (tested) — the true negative must survive.
- [ ] A successful lookup CONTAINING the peer reports `yes` (tested; this is the case the live box got wrong).
- [ ] An empty/absent `peerId` reports UNKNOWN, not `false` (tested).
- [ ] The CID-gateway and eth.limo probes report UNKNOWN when the probe could not be made, distinct from a gateway that answered and did not serve (tested both).
- [ ] The eth.limo column keeps NOT-APPLICABLE (no resolved name) DISTINCT from UNKNOWN (tested).
- [ ] All three states appear in the CLI line, the JSON payload and the dashboard; the dashboard shows unknown as a NEUTRAL indicator with its reason, never the negative one (tested).
- [ ] The per-site `ok`/`unverified` roll-up treats unknown as unverified (tested).
- [ ] No check throws or fails the report; `status` still renders fully when every external call fails (tested).
- [ ] `CONTEXT.md` `## Conventions` carries the rule, short, with the worked examples referenced.
- [ ] Test-first; no live network in tests. A changeset is included.

## Blocked by

- None. `src/status/status-report.ts`, `src/status/status-html.ts`, the `status` CLI arm, `CONTEXT.md`.

## Prompt

> Goal: stop `status` from reporting a failed check as a confident negative, and pin the rule so this stops recurring. Read `src/status/status-report.ts` (`checkAnnounced`, `probeGateway`, `defaultProvidersLookup` with its `if (!res.ok) return {Providers: []}`, `ProvidersLookup`, `GatewayProbe`), `src/status/status-html.ts` (`indicator`), and the `## Conventions` section of `CONTEXT.md`.
>
> A live box reported `announced=false` for a site the delegated router was, at that moment, listing correctly. The lookup had failed (rate limiting is the likely cause) and a failed lookup is indistinguishable from a real negative in the current code. The same holds for both gateway probes.
>
> Make all three checks three-valued (yes / no / unknown-with-reason), keep the eth.limo not-applicable state distinct from unknown, render unknown neutrally rather than as a red cross, and keep the never-throw policy unchanged. Then add the standing rule to CONTEXT.md's Conventions: a check that could not run never reports a definitive negative.
>
> This is the fifth instance of this defect class in this repo. The convention is the point; the code change is its worked example.
