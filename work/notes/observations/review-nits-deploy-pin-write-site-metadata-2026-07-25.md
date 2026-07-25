---
title: review-gate non-blocking nits for 'deploy-pin-write-site-metadata' (Gate 2 approve)
date: 2026-07-25
status: open
reviewOf: deploy-pin-write-site-metadata
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'deploy-pin-write-site-metadata' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- The preserve read-modify-write treats ANY files/read failure as 'no metadata', so a transient RPC/auth failure between the CAR land and the placement silently drops an existing ensName (or an existing empty-string opt-out) instead of failing loud. Should preserve distinguish absence from an outage (or at least refuse to write when the read failed), and should this conflation be recorded in the decisions note?
  (src/site/site-wrapper.ts: resolveSiteMetadataToWrite preserve branch calls readSiteMetadata, whose catch-all absorbs every error into {} (a conflation accepted earlier for the READ/discovery path, now reused on a DESTRUCTIVE write path). Not listed in work/notes/observations/deploy-pin-write-site-metadata-decisions.md.)
- Ratify decision 5: deploy still resolves mode as --mode > the pinnace.json site entry, while the task acceptance says mode comes from --mode (arg > default). Deferring the config-source removal to config-drop-sites-and-make-optional is defensible (that task is blockedBy this one, so deploy never has a window with no mode source) but it is a knowing deviation from the acceptance wording.
  (src/cli/run.ts runDeploy: cfg.sites.find(s => s.id === siteId)?.mode retained; work/tasks/backlog/config-drop-sites-and-make-optional.md carries blockedBy: [deploy-pin-write-site-metadata].)
- Ratify decision 3's pin corollary: mode is always overwritten by the operation, but pin's mode is OPTIONAL and defaults to ipfs, so a re-pin without --mode rewrites a stored ipns site's metadata.json to mode ipfs. The task justified no-preserve-for-mode with 'mode is required for the op', which is true for deploy but not for pin. Once the on-box loop reads mode for republish, is that silent demotion acceptable?
  (src/pin/pin-external.ts: const mode = input.mode ?? 'ipfs' then passed into resolveSiteMetadataToWrite; backlog task onbox-loop-reads-metadata-ensname-warming will consume the stored mode.)
- Coherence: DeployInput.ensName / PinExternalInput.ensName hold an EnsNameIntent OBJECT, while ensName everywhere else (CONTEXT.md glossary, SiteMetadata, metadata.json) is the string hint. Would ensNameIntent be the clearer field name? Related: resolveSiteMetadataToWrite has no exhaustiveness guard, so an unrecognised kind (e.g. a JS caller passing a bare string) falls through to preserve and is silently ignored rather than refused.
  (src/site/site-wrapper.ts EnsNameIntent + resolveSiteMetadataToWrite if-chain; src/deploy/deploy.ts and src/pin/pin-external.ts input fields.)
- Arg-order hazard for the optional-value flag: the printed usage shows --set-ens-name BEFORE the positionals, but in that position the BARE form swallows the next positional (deploy ./dist my.eth becomes name=./dist; pin --set-ens-name bafy... becomes name=bafy...). The result is a loud but misleading usage/no-source error. Worth reordering the usage strings so the bare form is shown last, or naming the hazard in the error?
  (src/cli/run.ts parseArgs (a following token not starting with -- is consumed as the value) plus the deploy usage string and PIN_USAGE.)
- Ratify decision 6: site add still writes {mode:'ipfs'} with no preserve, so re-adding an existing site drops its ensName and demotes its stored mode, defeating the never-silently-wipe guarantee this task establishes for the sibling verbs. Should a follow-up task extend the preserve semantics (or a refusal) to add?
  (src/site/site-management.ts addSite untouched; already tracked as an open nit in work/notes/observations/review-nits-mfs-site-wrapper-layout-and-metadata-seam-2026-07-25.md.)
