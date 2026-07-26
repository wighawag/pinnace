---
title: review-gate non-blocking nits for 'authorize-replaces-promote' (Gate 2 approve)
date: 2026-07-26
status: open
reviewOf: authorize-replaces-promote
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'authorize-replaces-promote' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- The second-signer guard exists only on authorize; deploy --set-mode ipns and pin --set-mode ipns still call importIpnsKeyIntoPublisher with no equivalent check. An operator whose old publisher (now declared replica) still holds the key can recreate the exact two-signer hazard through deploy and never see the refusal. Should the guard move to the shared key-import seam, or is authorize-only deliberate and worth a named follow-up task?
  (src/publisher/authorize.ts (AuthorizeSecondSignerError, pre-flight) vs src/deploy/deploy.ts step 2 and src/pin/pin-external.ts, which both import via the same seam unguarded.)
- Bare authorize can report success while doing nothing: discoverSites swallows ANY files/ls failure (not just a missing /sites) and returns [], so a wrong or stale publisher token yields exit 0 plus the line 'no sites in MFS on <host> to authorize'. The named-id form surfaces the same failure loudly (key/list is not caught). Is a silent exit 0 on an unreachable/401 publisher acceptable here?
  (src/node/node-commands.ts:244 catch returns []; src/cli/run.ts runAuthorize prints the no-sites line and returns 0.)
- Ratify an unrecorded decision: the CLI refuses more than one positional (pinnace authorize a b is a usage error) even though the core input takes ids as an ARRAY. Was capping the CLI at one id intended, or should multiple ids be accepted since the core already supports them?
  (src/cli/run.ts runAuthorize positionals.length > 1 check; AuthorizeInput.ids is string[].)
- Ratify recorded decision 4: a configured host that cannot be asked (down, 401, or no token exported) is collected into a note line and the run still succeeds, so authorize can import a key while an unreachable box silently holds a duplicate. Confirm best-effort-plus-note is the wanted policy rather than a refusal.
  (work/notes/observations/authorize-replaces-promote-decisions.md section 4; src/publisher/authorize.ts unchecked[]; run.ts unaskable[].)
- Stale promote/failover wording survives outside the files the acceptance criteria enumerated: two UNRELEASED changesets still tell operators to run 'pinnace promote <id> --host <name>', and they will publish into CHANGELOG.md in the same release that deletes the verb. The repo root README also still advertises publisher/replica failover and a provision to deploy to failover flow, which the package README now explicitly reframes as a grace window, not a handover.
  (.changeset/deploy-auto-imports-site-key-in-ipns-mode.md, .changeset/endpoint-flag-loud-and-global.md, README.md:7 and README.md:42-44.)
