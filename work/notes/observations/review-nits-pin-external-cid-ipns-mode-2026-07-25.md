---
title: review-gate non-blocking nits for 'pin-external-cid-ipns-mode' (Gate 2 approve)
date: 2026-07-25
status: open
reviewOf: pin-external-cid-ipns-mode
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'pin-external-cid-ipns-mode' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify decision 2: pin --mode never consults a pinnace.json sites entry, while deploy resolves mode as --mode > site entry (and errors if neither). So an operator with a sites entry named like the pin and mode ipns gets no publish from pin unless they type --mode ipns. Intended asymmetry between the two carriers of one concept?
  (src/cli/run.ts runPin (mode = flags[mode] ?? ipfs, cfg.sites never read) vs runDeploy line ~504 (flags[mode] ?? siteEntry?.mode); recorded in work/notes/observations/pin-external-cid-ipns-mode-decisions.md #2)
- Ratify decision 6 plus its exit-code consequence: a publisher whose name/publish fails is counted as a FAILED node, so with one healthy replica the run still exits 0 while the IPNS name did NOT move (only a stderr FAIL line says so). CI would read that as success. Same semantics as deploy, so consistent, but confirm 0 is right for ipns mode.
  (pin-external.ts pinOnNode throws PinStageError(publish); pinExternal success = ok.length > 0; run.ts returns result.success ? 0 : 1)
- Ratify decision 3 plus decision 4: the key/list + name/publish shape and the RECORD_LIFETIME/RECORD_TTL constants moved to src/publisher/ipns-publish.ts (record-sequence re-exports them, deploy and the on-box republish rewired), and PinTarget gained an optional role where absent means cannot sign. Both look right and reduce duplication; they do touch deploy and the on-box timer, so worth an explicit nod.
  (new src/publisher/ipns-publish.ts; record-sequence.ts line 70 re-export; deploy.ts publish() now delegates; pin-external.ts canSign(target) checks role === publisher)
- Un-recorded decision to ratify: this ships new PUBLIC package surface (lookupIpnsKeyId, publishSiteRecord, PublishSiteRecordInput, PinPublisherRequiredError) and makes mode on PinExternalResult and published on PinNodeOk REQUIRED fields, under a minor changeset. Type-level breaking for any library consumer that builds those result shapes (pre-1.0, so probably fine).
  (src/index.ts additions; PinExternalResult.mode and PinNodeOk.published are non-optional; .changeset/pin-external-cid-ipns-mode.md marks minor)
- Un-recorded decision to ratify: user-visible CLI output gains a per-node suffix (ipns <id>) and a trailing ipns://<id> line, and every PinTarget now carries role even in ipfs mode (unused there). Harmless, but it is a new default output shape any scripted consumer of pin sees in ipns mode.
  (run.ts runPin: ok line template plus if (result.ipns) rc.out(ipns://...); targets map now sets role: h.role unconditionally)
- Follow-up candidate: nothing guards --as <name> colliding with an EXISTING deployed ipns site of that id. The MFS clobber was already there in ipfs mode, but ipns mode now immediately re-points the operator's own live name at mirrored external content, with no confirmation. Worth a guard or a warning task?
  (placeInMfs does files/rm then files/cp at /sites/<name>; publishPin then name/publishes under the same-named key. Adjacent to pin-external-cid-decisions.md line 19 (the shared id surface))
