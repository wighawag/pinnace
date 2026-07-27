---
title: review-gate non-blocking nits for 'show-inferred-ens-name-not-none' (Gate 2 approve)
date: 2026-07-27
status: open
reviewOf: show-inferred-ens-name-not-none
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'show-inferred-ens-name-not-none' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Stale claim in code: src/site/site-wrapper.ts still says the dashboard renderer 'stays a pure, import-free view', but status-html.ts now imports ens-name-display.js. The build recorded this softening against the observation note (decision 2) but missed the in-code twin. Should that JSDoc sentence be reworded to 'resolves nothing itself' (the property that actually holds)?
  (packages/pinnace/src/site/site-wrapper.ts:322-324 (ethLimoUrl JSDoc) vs packages/pinnace/src/status/status-html.ts:33 import; work/notes/observations/inferred-ens-name-display-decisions.md decision 2)
- RATIFY decision 1: the four-state classifier was consolidated into a NEW module src/status/ens-name-display.ts (not exported from index.ts, so no new public API), rather than living beside resolveEnsNameToWarm or staying duplicated. The task invited consolidation only if clean; this places a presentation concern under status/ and gives the previously import-free HTML view one import.
  (packages/pinnace/src/status/ens-name-display.ts (new, leaf module); decisions note item 1)
- RATIFY decision 3: user-visible wording. The CLI status line field value now contains a space (ensName ronan.eth (inferred)), and the dashboard gets a NEW css class .inferred sharing the muted colour with .none/.empty. Any operator script splitting the status line on whitespace by position sees an extra token (status.json is untouched, so machine readers are unaffected).
  (packages/pinnace/src/cli/run.ts:862-874; status-html.ts:229-250 and PAGE_CSS .none,.empty,.inferred; note that ens-name-display.ts header still describes a CLI line as one greppable text token per field)
- RATIFY decision 4: the genuinely-none case deliberately keeps its divergent existing tokens (unset on the CLI, none on the dashboard), and opted-out / opted out likewise. Unifying them was judged a separate breaking change. Is leaving the two surfaces lexically different acceptable long-term?
  (decisions note item 4; run.ts prints unset, status-html.ts prints none)
