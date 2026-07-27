---
title: review-gate non-blocking nits for 'reject-unknown-cli-flags' (Gate 2 approve)
date: 2026-07-27
status: open
reviewOf: reject-unknown-cli-flags
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'reject-unknown-cli-flags' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify: deploy --host is now a hard refusal. It was previously parsed and dropped, so any script running 'pinnace deploy --host a ./dist mysite' will start failing; narrowing a deploy is now only --endpoint. The decision is recorded (decisions note item 2) and in the changeset, but it is a new refusal on a flag that exists on pin/site, so it needs a human OK.
  (VERB_FLAGS.deploy omits host; work/notes/observations/reject-unknown-cli-flags-decisions.md item 2)
- Ratify: any flag on 'pinnace node <verb>' or 'pinnace version' is now a refusal (both accept no flags). Generated cloud-init invokes 'pinnace node <verb>' with no flags, so no provisioned box breaks, but this newly refuses e.g. 'pinnace version --json'.
  (VERB_FLAGS.node / .version = empty; refuseUnknownFlags call in run() version branch and runNodeCli)
- Ratify the release level: the changeset is marked patch although it is an explicit BEHAVIOUR CHANGE that breaks previously-accepted command lines. Repo precedent (0.8.0) shipped the breaking authorize rename as a patch changeset plus a separate human-authored minor marker for the train; if the same is wanted here, the human must add it. The bump level was chosen by the agent and is not in the decisions note.
  (.changeset/reject-unknown-cli-flags.md front matter says patch; CHANGELOG 0.8.0 minor marker precedent)
- The claimed safety net for the hand-maintained allow-list is weaker than stated: test/cli/unknown-flag.test.ts only fails on an omitted VERB_FLAGS entry if the author ALSO adds the new flag to that verb's valid command line in verbCases. Nothing mechanically ties VERB_FLAGS to the flags the verbs actually read, so a future flag added to a verb and to neither table nor test becomes a silent false refusal.
  (decisions note item 6 mitigation (b); verbCases in test/cli/unknown-flag.test.ts:212-350)
- Ratify: --gateways stays accepted on deploy/pin/status/site/authorize even though no client verb reads cfg.gateways, so it is the one allow-listed flag that still means nothing. Captured as work/notes/observations/cli-gateways-flag-reaches-nobody.md rather than fixed here.
  (decisions note item 3; cliOverridesFromFlags reads it, nothing consumes it)
- Nit: decision 2's new refusal (deploy --host) has no dedicated test; it is only covered by the generic --nonsense loop. A one-line test would pin the intent so a later table edit cannot silently re-accept it.
  (no deploy + --host case in test/cli/unknown-flag.test.ts)
