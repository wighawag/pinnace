<!-- dorfl-sidecar: item=task:config-drop-sites-and-make-optional type=task slug=config-drop-sites-and-make-optional allAnswered=false -->

## Q1

**'task:config-drop-sites-and-make-optional' was bounced — how should we proceed?**

> PR/code review (Gate 2) ran but its verdict could not be parsed: review agent launch failed

<!-- q1 fields: id=q1 kind=stuck -->

**Your answer** (write below this line):

## Q2

**'task:config-drop-sites-and-make-optional' was bounced — how should we proceed?**

> PR/code review (Gate 2) ran but its verdict could not be parsed: review agent launch failed

<!-- q2 fields: id=q2 kind=stuck -->

**Your answer** (write below this line):

## Q3

**'task:config-drop-sites-and-make-optional' was bounced — how should we proceed?**

> PR/code review (Gate 2) ran but its verdict could not be parsed: review agent launch failed

<!-- q3 fields: id=q3 kind=stuck -->

**Your answer** (write below this line):

## Q4

**'task:config-drop-sites-and-make-optional' was bounced — how should we proceed?**

> PR/code review (Gate 2) ran but its verdict could not be parsed: review agent launch failed

<!-- q4 fields: id=q4 kind=stuck -->

**Your answer** (write below this line):

## Q5

**'task:config-drop-sites-and-make-optional' was bounced — how should we proceed?**

> PR/code review (Gate 2) ran but its verdict could not be parsed: review agent launch failed

<!-- q5 fields: id=q5 kind=stuck -->

**Your answer** (write below this line):

## Q6

**'task:config-drop-sites-and-make-optional' was bounced — how should we proceed?**

> PR/code review (Gate 2) blocked this work:
> - deploy's mode is now --mode > a hardcoded 'ipfs' constant, with NO fallback to the site's stored MFS metadata. The spec's Impl Decision states the order as arg > metadata; no config entry. As landed, re-running 'pinnace deploy ./dist mysite' on a live ipns site (the exact command that worked before this PR via the config entry) exits 0, signs nothing, AND overwrites metadata.mode to ipfs, which the on-box republish loop honours, so the live name silently stops being refreshed and eventually lapses. readSiteMetadata + the preserve pattern already exist in resolveSiteMetadataToWrite (used for ensName), so an arg > stored-metadata > ipfs tier was in reach; as written, ensName is preserved carefully while mode, the field that decides whether the name keeps being signed, is clobbered. Human call: ratify the bare ipfs default (and fix the spec wording), or add the metadata tier the spec named. (src/cli/run.ts:521 mode = flags['mode'] ?? DEFAULT_DEPLOY_MODE; src/site/site-wrapper.ts:175 'The mode is always the one this operation runs in, never the stored one'; spec sites-metadata-in-mfs, Impl Decisions bullet 1 'arg > metadata; no config entry')
> PR/code review (Gate 2) did not reach a unanimous approve across reviewMaxRounds=2 round(s) (a block is terminal and is never re-rolled); forcing needs-attention (never silently merged or looped).

<!-- q6 fields: id=q6 kind=stuck -->

**Your answer** (write below this line):
