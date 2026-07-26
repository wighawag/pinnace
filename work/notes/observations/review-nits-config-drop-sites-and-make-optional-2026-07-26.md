---
title: review-gate non-blocking nits for 'config-drop-sites-and-make-optional' (Gate 2 approve)
date: 2026-07-26
status: open
reviewOf: config-drop-sites-and-make-optional
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'config-drop-sites-and-make-optional' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify the synthetic host NAME for --endpoint: it is hard-coded to 'publisher', which is the same namespace real config hosts use (the README sample config declares a host literally named publisher). Consequence: an operator with PINNACE_HOST_PUBLISHER_TOKEN set for their own publisher who runs 'pinnace deploy --endpoint https://other.example ...' silently sends THAT token to the other endpoint, because --endpoint replaces the file hosts but keeps the same token env convention. Ratify (it is the documented convention and the operator typed the URL), or scope the CLI node under a name that cannot collide.
  (src/config/config-resolution.ts CLI_ENDPOINT_HOST_NAME = 'publisher' + hostTokenEnvVar; decisions note 2 in work/notes/observations/config-drop-sites-decisions.md)
- Ratify the replica-only fan-out rewrite: with no publisher among the targets (pin --host <replica>, or a publisher-less config) the mode resolves to the ipfs DEFAULT and that value is WRITTEN into a replica whose metadata said ipns. Nothing signs either way today and no code reads a replica's stored mode, so impact is latent, but a later on-box loop that does read it would see a demoted replica. The alternative (per-node preserve when there is no publisher) was rejected deliberately; the human should ratify or reverse.
  (src/pin/pin-external.ts resolveFanOutMode returns DEFAULT_SITE_MODE when findIndex(canSign) < 0, then states it to every node; decisions note 5 records this as a residual to ratify)
- The preserve tier degrades silently on a publisher READ failure: readSiteMetadata absorbs every error into empty metadata, so a publisher that is down, or answering 401 on a stale token, makes a no-flag re-deploy resolve to ipfs, write mode ipfs into the surviving replicas, and report mode ipfs with exit 0. The publisher's own metadata is untouched so the next successful deploy recovers, but the run is quietly demoted. Worth deciding whether the resolved-by-default case should be reported (or the mode read kept loud) now that mode, not just ensName, rides on that tolerant read.
  (src/site/site-wrapper.ts readSiteMetadata catch-all (its DECISION block accepts the absence/outage conflation, written when only ensName depended on it); src/deploy/deploy.ts resolveFanOutMode)
- Bare --endpoint (no value) is silently IGNORED, which contradicts the bare-flag policy this same diff establishes for --set-mode (a flag the operator typed must never mean nothing). 'deploy --endpoint --set-mode ipns ./dist mysite' parses endpoint as the empty string, so cliOverridesFromFlags drops it and the deploy WIDENS back to every host in pinnace.json instead of narrowing to one node. Cheap to make loud.
  (src/cli/run.ts cliOverridesFromFlags: if (flags['endpoint']) cli.endpoint = flags['endpoint']; parseArgs assigns '' to a flag followed by another --flag)
- Two blocked-by backlog doc tasks still name the removed flag: context-glossary-mfs-sites-metadata says mode comes 'from --mode at deploy/pin' and readmes-mfs-metadata-and-optional-config says '--mode, the ens-name flags'. Both instruct verifying against the code, so a careful agent will catch it, but decision 4 of the decisions note says these tasks must be updated to '--set-mode > stored metadata > ipfs'. Update them so the glossary cannot re-pin a flag that no longer exists.
  (work/tasks/backlog/context-glossary-mfs-sites-metadata.md:16 and work/tasks/backlog/readmes-mfs-metadata-and-optional-config.md:16)
- Ratify pin's eager key derivation: with no --set-mode, the CLI now derives the per-site key whenever PINNACE_MASTER is set, even for a pin that resolves to ipfs, because only the core knows the stored mode. It is a local KDF with no node contact and the key is imported only when the resolved mode is ipns, but it is a user-visible change to when key material is computed, and the pre-check refusals (missing master, no publisher) now guard only the STATED ipns path, with the preserved path refused later by the core.
  (src/cli/run.ts runPin: if (statedIpns || mode.kind === 'preserve') { ... if (master) derived = ... }; PinDerivedKeyRequiredError in src/pin/pin-external.ts)
- Bookkeeping: the task file was moved into work/tasks/done/ on this branch while its frontmatter still reads needsAnswers: true, and work/questions/task-config-drop-sites-and-make-optional.md is still present, although the human answered in the Requeue 2026-07-26 block. A later reader sees a done item advertising open questions.
  (work/tasks/done/config-drop-sites-and-make-optional.md frontmatter; work/questions/task-config-drop-sites-and-make-optional.md)
