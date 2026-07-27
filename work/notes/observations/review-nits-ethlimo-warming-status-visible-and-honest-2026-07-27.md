---
title: review-gate non-blocking nits for 'ethlimo-warming-status-visible-and-honest' (Gate 2 approve)
date: 2026-07-27
status: open
reviewOf: ethlimo-warming-status-visible-and-honest
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'ethlimo-warming-status-visible-and-honest' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify: the exported GatewayProbe type was widened from (cid) to (url), a breaking change for any library consumer injecting its own probe, yet the changeset is a patch. Is patch the intended semver for an exported-type break, or should this be a minor?
  (.changeset/ethlimo-warming-status-visible-and-honest.md declares pinnace: patch; src/status/status-report.ts GatewayProbe = (url: string) => Promise<number>. Package is 0.8.1 and the prior behaviour-changing task also shipped patch, so precedent supports it. Recorded as decision 1 in work/notes/observations/ethlimo-probe-and-warm-outcome-decisions.md, but the semver call itself is not.)
- Ratify the new user-visible warm vocabulary: warmed / partly-warmed / warm-failed / nothing-to-warm, printed per site by pinnace node warm. Any operator script matching on warmed now sees three new tokens.
  (src/node/node-commands.ts WarmStatus + warmStatus(); printed by cli/run.ts node arm. nothing-to-warm can only appear when no gateways are configured AND no ENS name resolves, so it is rare on a provisioned box. Recorded as decision 5.)
- Ratify: an eth.limo outage never flips a site to unverified, so a consumer alerting on the status.json roll-up token will not learn eth.limo is down (it must read ethLimoServes).
  (src/status/status-report.ts makeStatusOp keeps status: gatewayServes && announced ? ok : unverified. Deliberate (decision 4) to avoid re-meaning a shipped field; the dashboard column does show the verdict.)
- Ratify three new public exports that the task did not ask for: ethLimoUrl, cidGatewayUrl and the WarmStatus type. Note WarmStatus is exported but SiteOutcome.status is still typed string, so the union is documentation only and nothing type-checks a wrong token.
  (src/index.ts adds all three; src/node/node-commands.ts SiteOutcome.status?: string. Not listed in the decisions note.)
- Stale doc lines: statusReport JSDoc still says it runs the two external checks to fill the four fields, and a test describe still says per-site four-field report shape, although there are now three checks. Worth a one-line fix next time this file is touched.
  (packages/pinnace/src/status/status-report.ts around line 202; packages/pinnace/test/status/status-report.test.ts describe block. The module header WAS updated to list check (5).)
- CONTEXT.md gateway warming glossary entry still describes warming only as re-fetching, with no mention of the eth.limo probe or the recorded warm outcomes; README was updated but the glossary was not. Pin the vocabulary there so the next author cannot re-fork it?
  (CONTEXT.md line 25 vs packages/pinnace/README.md gateway warming bullet, which now lists the four tokens. Prior merged task also left CONTEXT.md untouched.)
- Cross-check: the spec sites-metadata-in-mfs lists dashboard rendering as out of scope, while this task deliberately changes the eth.limo column to carry a verdict. The task text authorises it, so this is a ratification, not a defect.
  (work/specs/tasked/sites-metadata-in-mfs.md Out of Scope vs the task's Half 1 third bullet and src/status/status-html.ts renderSiteRow.)
