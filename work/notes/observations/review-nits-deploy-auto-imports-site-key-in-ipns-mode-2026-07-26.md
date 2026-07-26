---
title: review-gate non-blocking nits for 'deploy-auto-imports-site-key-in-ipns-mode' (Gate 2 approve)
date: 2026-07-26
status: open
reviewOf: deploy-auto-imports-site-key-in-ipns-mode
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'deploy-auto-imports-site-key-in-ipns-mode' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify: a fan-out where EVERY target has publish:false, in a resolved ipns mode, now throws DeployPublisherRequiredError where it previously landed content and signed nothing. Library callers using publish:false as a mode-independent land-only switch will now get an exception instead of a successful deploy. Is the intended migration --set-mode ipfs?
  (Decisions note item 4; deploy.ts assertCanSign targets.some(shouldPublish) guard; the old single-target publish:false test was rewritten into a two-target shape)
- Ratify: with several publishers and no derived key, ONE keyless signer refuses the WHOLE run pre-flight, which is a deliberate exception to the fan-out partial-failure contract (a subset succeeding is normally still success). Correct for the content-landed-name-unmoved failure this task kills, but it means a single mis-provisioned publisher can now block a deploy the other publisher could serve.
  (Decisions note item 3; deploy.ts assertCanSign probes.findIndex kind absent)
- Ratify, and consider tightening the decisions note wording: a publisher whose pre-flight key/list FAILS is probed as unreachable and is not a refusal, so that node proceeds into the fan-out, lands the CAR/pin/MFS/metadata, and only then re-runs key/list and throws DeployDerivedKeyRequiredError as its per-node failure. So content CAN land on that node with its name unmoved. It is loud (FAIL line, exit 1 when it is the only node), but the note claims an unprobed node cannot land content and quietly skip signing, which overstates it: only the quietly part holds.
  (Decisions note item 2; deploy.ts publish() falls through to lookupIpnsKeyId when probe.kind is unreachable, after deployToNode steps 1-2 already wrote)
- Ratify the deliberate CLI asymmetry: pin --set-mode ipns with no PINNACE_MASTER refuses at the CLI, deploy --set-mode ipns with no master proceeds and lets the core decide. Justified by deploy's master-free CI path, but the two sibling verbs now behave differently for the same flag on the same missing env var. Is the named follow-up (give pin deploy's probe) wanted, or is the asymmetry accepted permanently?
  (Decisions note item 5; run.ts runDeploy derives only when master is present, no refusal)
- Residual hole in the goal statement (pre-existing, shared with pin, outside this task's fence): with NO --set-mode and NO publisher role in the fan-out, resolveFanOutMode returns DEFAULT_SITE_MODE (ipfs) without reading any stored metadata, so assertCanSign never runs and a site stored as ipns on replica-only targets is silently demoted to ipfs in its metadata and never signed. Worth a follow-up task rather than a fix here?
  (deploy.ts resolveFanOutMode returns DEFAULT_SITE_MODE when resolvedFrom < 0; identical shape at pin-external.ts:516; site-wrapper.ts:145 DEFAULT_SITE_MODE = ipfs)
- Un-recorded micro-decision: after an auto-import, the reported ipns id is imported.Id ?? derived.ipnsId, i.e. the NODE's answer wins over the locally derived one. By construction they are equal, so a divergence would mean the node imported something else and the operator would be told the node's id rather than the derived one. Ratify preferring the node's value (or assert they match).
  (deploy.ts publish(): ipns = imported.Id ?? derived.ipnsId; not in the decisions note)
