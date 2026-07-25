---
title: review-gate non-blocking nits for 'pin-external-cid' (Gate 2 approve)
date: 2026-07-25
status: open
reviewOf: pin-external-cid
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'pin-external-cid' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify: --host on pin NARROWS a fan-out (omitted = all nodes), while on site/promote --host SELECTS the single node and is required with several hosts (pickHost). Two readings of one flag; is the divergence accepted, or should pin use a different flag name (e.g. --only)?
  (src/cli/run.ts runPin resolves hosts inline instead of pickHost; recorded as decision 2 in work/notes/observations/pin-external-cid-decisions.md)
- Ratify: no timeout at all on the blocking pin/add (no default, no --timeout). An unretrievable CID leaves the CLI waiting until Kubo itself gives up; the only bound is the operator's Ctrl-C. Accept, or schedule widening FetchLike with AbortSignal as a follow-up?
  (decision 3 in the decisions note; pinAdd JSDoc in src/rpc/kubo-rpc-client.ts:167-188 documents the blocking behaviour)
- Ratify: --as <name> has NO collision guard. Pinning as an existing site id silently repoints /sites/<name> to the external CID (placeInMfs does files/rm --force then cp), leaves the old CID pinned, and in ipns mode the next republish would sign the FOREIGN CID under that site's IPNS name. Same power site add already has, but worth an explicit accept or a refuse/confirm.
  (src/pin/pin-external.ts pinOnNode step 2 -> placeInMfs (src/site/site-management.ts:182-191); republishAndExport signs per discovered MFS site (src/publisher/record-sequence.ts:92-107))
- Un-recorded in-scope decision to ratify: a trailing or value-less --host (typo, e.g. pin <cid> --as x --host) parses to the empty string, which is falsy, so pin silently fans out to EVERY node instead of failing loud. The pickHost verbs error in that situation.
  (src/cli/run.ts runPin: const hostName = flags['host']; if (hostName) {...} - empty value falls through to hosts = cfg.hosts)
- Un-recorded in-scope decision to ratify: PinTarget is a NEW type forked from DeployTarget rather than a shared node-target base (justified in JSDoc as role-free, but not in the Decisions note). Keep the fork or extract a common NodeTarget?
  (src/pin/pin-external.ts PinTarget vs src/deploy/deploy.ts DeployTarget - both baseUrl/token/fetchImpl)
- Ratify decision 5 and its cross-verb risk: parseArgs now takes an opt-in booleanFlags list, so ANY future value-less flag that forgets to register itself will silently swallow the next positional. No test guards that failure mode generically.
  (src/cli/run.ts parseArgs(argv, booleanFlags = []); only pin passes ['no-recursive'])
- Small claim drift: the decisions note states it is linked from the done record, and pin-external.ts says see the decisions note linked from the done record, but work/tasks/done/pin-external-cid.md contains no link to work/notes/observations/pin-external-cid-decisions.md. Third instance of this shape in this repo - consider fixing the convention, not the instance.
  (work/tasks/done/pin-external-cid.md has no Decisions/link section; same nit recorded for cloud-init-pinnace-install-channel)
- Coherence nit: CONTEXT.md now defines a glossary entry pin as the verb, while pin/pinned is used generically (IPFS pinning) throughout the same document and in the node entry. Consider pinning the term as external pin or pin (verb) so the next author cannot re-fork it.
  (CONTEXT.md Core domain terms, new pin entry)
