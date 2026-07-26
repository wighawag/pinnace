---
title: review-gate non-blocking nits for 'site-metadata-write-path-no-silent-loss' (Gate 2 approve)
date: 2026-07-26
status: open
reviewOf: site-metadata-write-path-no-silent-loss
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'site-metadata-write-path-no-silent-loss' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Should a metadata.json that is READ successfully but is MALFORMED also refuse, rather than silently reset the site to the defaults? parseSiteMetadata is tolerant (returns {} for truncated/mangled/array JSON, and drops a wrongly-typed or unknown-cased mode), and the strict write read reuses it, so a corrupt or hand-edited file makes a no-flag re-deploy write {mode: ipfs}, drop the stored ensName, and exit 0 - the exact shape the task exists to kill, just reached through a parse failure instead of an RPC failure. Defensible (you cannot preserve what you cannot parse) but it is an in-scope decision the agent made silently: it is not in the 6-entry decisions note. Human call: ratify tolerant-parse-on-write, or make an unparseable file an outage too.
  (packages/pinnace/src/site/site-wrapper.ts:350 parseSiteMetadata returns {} on bad JSON; site-wrapper.ts:513 readSiteMetadataForWrite calls it directly inside the strict branch; work/notes/observations/site-metadata-write-path-decisions.md has no entry for it)
- Ratify the new refusal on site add, which has NO way past it. Every other verb can bypass the read by stating the whole record (--set-mode plus --set-ens-name/--unset-ens-name), but site add has neither flag, so against a down or 401ing node the verb now simply fails where it previously succeeded. The agent recorded this (decisions note item 3) and deliberately declined to widen add's flag surface; it needs a human yes.
  (work/notes/observations/site-metadata-write-path-decisions.md item 3; packages/pinnace/src/site/site-management.ts:224 addSite resolves before placing)
- SiteMetadataUnreadableError is not caught by any CLI verb handler, so it rejects out of run() instead of being printed as pinnace deploy: ... / pinnace site add: ... with exit 1. It still reaches the operator (bin.ts prints err.message and exits 1), but it is the only operator-facing refusal on these verbs that skips the rc.err prefix convention used for MissingHostTokenError, PinSourceResolveError and PinDerivedKeyRequiredError, and any programmatic caller of run() now gets a rejection rather than an exit code for a routine operational condition. No CLI-level test covers it. Not recorded as a decision.
  (packages/pinnace/src/cli/run.ts:1137 addSite call is unguarded; run.ts:857 pin catch lists only PinSourceResolveError/PinDerivedKeyRequiredError; packages/pinnace/src/cli/bin.ts prints err.message)
- listMfsEntryNames is a third near-identical copy of the files/ls Entries-to-names extraction (node-commands.ts:221 and site-management.ts:282 already have one each), differing only in fail-soft vs loud. It also inherits filesLs's long=true default, so the write-path probe stats every entry of the sites dir when it only needs names. Worth folding into one shared helper with an explicit tolerance argument rather than adding a fourth later.
  (packages/pinnace/src/site/site-wrapper.ts:536; packages/pinnace/src/rpc/kubo-rpc-client.ts:274 filesLs(path, long = true))
