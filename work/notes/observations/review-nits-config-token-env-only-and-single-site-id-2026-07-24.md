---
title: review-gate non-blocking nits for 'config-token-env-only-and-single-site-id' (Gate 2 approve)
date: 2026-07-24
status: open
reviewOf: config-token-env-only-and-single-site-id
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'config-token-env-only-and-single-site-id' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify: token failure is LAZY (per-host, at client-build time) not eager, and empty-string PINNACE_HOST_X_TOKEN counts as unresolved. Both are recorded in the decisions note + module JSDoc + tested. Reasonable; confirm.
  (work/notes/observations/config-token-env-only-and-single-id-decisions.md decisions 1-2; resolveHostToken throws on undefined OR '')
- Ratify cross-task claim: this task SUBSUMES staged unify-ipns-key-name-convention (keystore key name IS the single id by construction). Decisions note recommends cancelling/superseding that sibling; human should action the supersede.
  (decisions note item 3; deploy publish k.Name===id, key-import keyName=id)
- Ratify out-of-scope deferral: CI emitter still names its var SITE_NAME / 'site name or ENS name' after the single-id change. Left out of scope (owned by ci-emitter-github snapshot contract) and captured as an observation. Confirm the deferral.
  (work/notes/observations/ci-emitter-site-name-var-vs-single-id.md)
