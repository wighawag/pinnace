---
title: review-gate non-blocking nits for 'cli-command-wrapper' (Gate 2 approve)
date: 2026-07-24
status: open
reviewOf: cli-command-wrapper
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'cli-command-wrapper' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify: derive is the primary verb with ipns-id as an accepted alias. Chosen to match core deriveIpnsId while honouring the task naming derive/ipns-id. Reversible (drop alias).
  (run.ts runDerive; decisions note 2; task names it a derive/ipns-id command)
- Ratify: deploy mode resolves --mode arg > matching pinnace.json site entry, and ERRORS (loud refusal) if neither yields ipfs/ipns rather than defaulting. Note the CI emitter separately defaults SITE_MODE to ipns in its emitted workflow; the two surfaces intentionally differ. Confirm the no-default refusal is the wanted behaviour.
  (run.ts runDeploy mode check; decisions note 3; ci-emit SITE_MODE default)
- Ratify: per-host CLI overrides use --host-token.<name> / --host-endpoint.<name> and --gateways a,b, mapping onto the existing CliOverrides shape (no new precedence in the CLI). Confirm this flag spelling is acceptable operator UX.
  (run.ts cliOverridesFromFlags; decisions note 4; CliOverrides in config-resolution)
- Minor: parseArgs treats any flag whose value token begins with -- as empty-string, so a value legitimately starting with -- cannot be passed. None of the v1 inputs need such values, so impact is nil today; worth a note if future flags take arbitrary strings.
  (run.ts parseArgs next.startsWith('--') branch)
