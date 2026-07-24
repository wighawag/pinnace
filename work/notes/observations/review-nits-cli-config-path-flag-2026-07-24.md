---
title: review-gate non-blocking nits for 'cli-config-path-flag' (Gate 2 approve)
date: 2026-07-24
status: open
reviewOf: cli-config-path-flag
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'cli-config-path-flag' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify: takeConfigFlag scans the WHOLE argv, so --config is accepted AFTER the command too (e.g. pinnace deploy --config x ...), not only BEFORE it as the task specified. Harmless today (no verb defines --config), but it silently makes --config a superset-position global and would swallow a future verb-level --config. Intended?
  (src/cli/run.ts:282 doc says 'scans the WHOLE argv'; task said 'may appear BEFORE the command'.)
- Ratify unspecified edge-case handling the agent chose: (a) repeated --config => last wins; (b) trailing --config with no value or a value starting with -- => empty path that then fails loud via ConfigLoadError; (c) a path literally starting with -- cannot be passed. No ## Decisions block recorded these.
  (src/cli/run.ts:293-301 takeConfigFlag; empty-path -> readFileSync('') throws -> loud.)
- Ratify: only the space form --config <path> is supported; --config=path (equals form) is not parsed and would fall through as an unknown/ignored token. Consistent with the CLI's existing parseArgs (also space-only), so likely fine, but undocumented for the operator.
  (parseArgs is long-form space-only; no = handling in takeConfigFlag.)
