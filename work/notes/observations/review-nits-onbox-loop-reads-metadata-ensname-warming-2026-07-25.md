---
title: review-gate non-blocking nits for 'onbox-loop-reads-metadata-ensname-warming' (Gate 2 approve)
date: 2026-07-25
status: open
reviewOf: onbox-loop-reads-metadata-ensname-warming
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'onbox-loop-reads-metadata-ensname-warming' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify the placement + public export of the new rule: resolveEnsNameToWarm lives in src/site/site-wrapper.ts (beside the write side) and is re-exported from the package entrypoint index.ts, making it public API rather than an internal node-loop helper. The task named neither home nor visibility, and no decisions note was recorded for this task (both sibling tasks recorded one under work/notes/observations/).
  (packages/pinnace/src/site/site-wrapper.ts:200-232; packages/pinnace/src/index.ts:127; compare work/notes/observations/site-wrapper-metadata-seam-decisions.md and deploy-pin-write-site-metadata-decisions.md)
- Spec story 5 promises the on-box loop reads metadata for warm AND republish (mode) AND status (reports it). This task deliberately fenced to warm, and after it lands no backlog task delivers the rest: republish still infers ipfs-vs-ipns from keystore presence, and the status report surfaces no ensName/mode. Should a follow-up task be cut, or is this an accepted deliberate non-delivery?
  (work/specs/tasked/sites-metadata-in-mfs.md story 5; packages/pinnace/src/publisher/record-sequence.ts:93-105 (keys.get(site.id) gate); no metadata reference in src/status/status-report.ts; remaining backlog covers only 1,2,3,4,6 (docs/config))
- Second instance of the same test seam: the per-arg files/read interception is done by overwriting the mock instance field with Object.defineProperty(mock, 'fetchImpl', ...), which is also how status-report.test.ts fakes per-path responses. MockKuboApi has no per-arg response hook, so each new per-site test re-invents this. Worth growing the mock (e.g. on(path, spec, {arg})) instead of a third copy?
  (packages/pinnace/test/node/node-commands.test.ts:425-448; packages/pinnace/test/status/status-report.test.ts:51; the field is declared readonly in src/rpc/mock-kubo.ts, so the override deliberately bypasses the type)
- The acceptance clause says warming failures are recorded, never thrown, but safeWarm swallows the error with no record and defaultWarm still pushes status 'warmed' for a site whose every warm threw. The new test is even named 'records a failing warm' while asserting every site reports 'warmed'. Behaviour is unchanged from node-agent-commands and out of this task's scope, but the operator-visible status is optimistic: should a later task carry a warm-failure outcome?
  (packages/pinnace/src/node/node-commands.ts:355-360 (safeWarm) and the always-'warmed' outcome push; packages/pinnace/test/node/node-commands.test.ts, the failing-warm test)
