---
title: review-gate non-blocking nits for 'unavailable-check-reports-unknown' (Gate 2 approve)
date: 2026-07-27
status: open
reviewOf: unavailable-check-reports-unknown
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'unavailable-check-reports-unknown' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify the routing 404 mapping: defaultProvidersLookup now throws CheckUnavailableError for ANY non-2xx, so a 404 reads as unknown (http 404) instead of a real no. The http-routing-v1 spec says a client MUST interpret 404 as a 200 with 0 results, i.e. the router ANSWERED and does not list us. If delegated-ipfs.dev (or a future endpoint) ever 404s an unprovided CID, the true negative the announced column exists for silently disappears. One-line predicate change if you want 404 excluded from the unknown branch. Not recorded in the decisions note (decision 3 covers gateways, not this sub-case).
  (packages/pinnace/src/status/status-report.ts:462 (if (!res.ok) throw new CheckUnavailableError(`http ${res.status}`)); specs.ipfs.tech/routing/http-routing-v1 section 4.1.3)
- Ratify the BREAKING report/status.json shape (decision 2): announced / gatewayServes / ethLimoServes are now objects, not booleans, in SiteStatus, SiteOutcome, StatusPageSite and the on-box status.json, shipped as a minor at 0.x. No in-repo consumer reads status.json back, and gatewayHttp/ethLimoHttp are untouched, but any external script testing announced === true breaks silently (it becomes truthy-always).
  (work/notes/observations/unavailable-check-reports-unknown-decisions.md decision 2; .changeset/unavailable-check-reports-unknown.md (minor))
- Ratify the dashboard behaviour change for reports that ran NO check (decision 5): indicator() now paints an ABSENT verdict as neutral unknown instead of the red no, so the thin on-box defaultStatus stand-in path shows two neutral cells per site where it used to show two crosses. Honest, but it is a visible change to a path this task did not target.
  (packages/pinnace/src/status/status-html.ts indicator() via checkState(undefined) === unknown; node-commands.ts defaultStatus fills neither field)
- Ratify the accepted grey area (decision 3): a 429 from a GATEWAY is recorded as a real no, while a 429 from the ROUTER is unknown. The asymmetry is deliberate and documented (it matches safeWarm counting any non-2xx as not-warmed), but a rate-limited dweb.link/eth.limo probe will still show a red no.
  (packages/pinnace/src/status/status-report.ts probeServes: checkAnswer(servesStatus(http)) for any returned status)
- Ratify the public-API growth (decision 1): nine new exports from index.ts (CheckOutcome, CheckState, CHECK_YES, CHECK_NO, UNKNOWN_CHECK_REASON, CheckUnavailableError, checkAnswer, checkUnknown, checkState, isYes, unavailableReason). Justified as shared vocabulary since the outcome is now part of the report shape, but it is a permanent surface consumers can depend on.
  (packages/pinnace/src/index.ts new export block; src/status/check-outcome.ts)
