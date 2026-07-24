---
title: review-gate non-blocking nits for 'status-report' (Gate 2 approve)
date: 2026-07-24
status: open
reviewOf: status-report
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'status-report' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify: makeStatusOp invents a new per-site status token vocabulary (status: 'ok' when gatewayServes && announced, else 'unverified'). The task never asked for a rolled-up status token, and SiteOutcome.status elsewhere carries verb-specific tokens (re-announced, no-key, warmed). This adds two new user-visible tokens and a second meaning of the word status. Coherent enough to ship, but a human should ratify the token names and the ok=announced-AND-serves rule.
  (status-report.ts makeStatusOp: status: s.gatewayServes && s.announced ? 'ok' : 'unverified'; no Decisions block in the PR/task recorded this.)
- Ratify: gatewayServes is true only for 2xx (including 206) and false for everything else, so a 3xx redirect (301/302) counts as NOT serving. Reference status.sh used curl -r 0-0 -w %{http_code}; confirm 3xx-as-not-served is the intended semantics.
  (servesStatus(): status >= 200 && status < 300; test asserts 301 -> false.)
- Note (not a defect): makeStatusOp is exported and unit-tested but is NOT wired into DEFAULT_OPS.status; the production node status verb still runs the thin defaultStatus stand-in. Per the seam design the operator/CLI wiring is a later task, so this is expected, but the core->verb connection is not yet live in dispatch.
  (node-commands.ts DEFAULT_OPS.status = defaultStatus; makeStatusOp only reachable via ctx.ops.status injection.)
