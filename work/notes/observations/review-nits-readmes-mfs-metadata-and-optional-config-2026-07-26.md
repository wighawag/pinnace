---
title: review-gate non-blocking nits for 'readmes-mfs-metadata-and-optional-config' (Gate 2 approve)
date: 2026-07-26
status: open
reviewOf: readmes-mfs-metadata-and-optional-config
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'readmes-mfs-metadata-and-optional-config' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify the decision to swap the documented post-install smoke test from `pinnace --help` to `pinnace version` in BOTH READMEs, instead of treating the missing help surface as a bug. The alternative (file a task adding a `--help` that lists the verbs) leaves users with no discovery command at all today. Also: this decision is recorded in an observation note but is NOT linked from the done record, as CLAIM-PROTOCOL requires.
  (README.md:17 and packages/pinnace/README.md:23 now say `pinnace version`; work/notes/observations/cli-has-no-help-verb.md; run.ts:315/347 only handles version/--version/-v then errors unknown command)
- Ratify the decision to document the config sample as `hosts` ONLY and to leave the `gateways` config key and the `--gateways` global OUT of the command reference, on the grounds that nothing consumes it. CONTEXT.md's config-resolution entry defines pinnace.json as the operator's hosts AND the gateways to warm, so the README now under-documents a key the glossary names, and it still calls warming 'the configured public gateways' when the key is inert.
  (packages/pinnace/README.md:56-66 sample; :49 gateway-warming bullet; globals note at :209; work/notes/observations/config-gateways-key-resolved-but-unconsumed.md; CONTEXT.md:28)
- The changeset body overclaims against what landed: it says the sample config is shown as hosts AND gateways in every example, and that the command reference documents the `--gateways` global. Neither appears in either README. Changesets ship into the published CHANGELOG, so this is user-visible text that does not match the diff.
  (.changeset/readmes-mfs-metadata-and-optional-config.md, bullets 1 and 5 vs packages/pinnace/README.md:56-66 and :209)
- The new config-less examples show `deploy --endpoint <url> --set-mode ipns ./dist mysite` as a standalone quickstart, with no mention that the site's key must still be imported by `promote`. deploy SKIPS the publish on an unkeyed publisher, so that exact command lands + pins content, signs no name, prints no ipns line and returns 0. Worth one clause pointing at promote (the numbered walkthrough does cover it).
  (README.md:37 and packages/pinnace/README.md:76; src/publisher/ipns-publish.ts header: callers compose their own policy, deploy SKIPS an unkeyed publisher)
- Spec story 8 (an operator on the OLD flat layout removes the entry and re-deploys) is not mentioned in either README; it exists only as a MIGRATION line in the sibling wrapper-layout changeset. discoverSites silently SKIPS an entry with no resolvable `/sites/<id>/content`, so an upgraded box drops such a site from republish/warm/status with no error. Consider a short upgrade note in the package README, or a follow-up task, so the durable docs carry it.
  (.changeset/mfs-site-wrapper-layout-and-metadata-seam.md:7; packages/pinnace/src/node/node-commands.ts:217-245 discoverSites skips entries whose content stat fails; no task in this spec covers story 8)
