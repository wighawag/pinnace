---
title: review-gate non-blocking nits for 'wire-client-cli-verbs-end-to-end' (Gate 2 approve)
date: 2026-07-25
status: open
reviewOf: wire-client-cli-verbs-end-to-end
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'wire-client-cli-verbs-end-to-end' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify the new per-node targeting idiom: site (list/remove/add) and promote take a --host <name> flag and default to the sole host when omitted, whereas deploy/status fan out to ALL configured hosts. This single-vs-all split is a reasonable design (list/remove/add/promote are inherently one-node ops) but it was unspecified by the task and not recorded in a Decisions block. Confirm the split is intended.
  (src/cli/run.ts pickHost/buildHostClient (site+promote) vs runDeploy/runStatus which iterate cfg.hosts)
- Coherence: --host is now overloaded. provision --host hetzner means the host PROVIDER (HostName / provider registry), while the new site/promote --host <name> selects a configured NODE by cfg.hosts[].name. The new flag aligns with the pre-existing PINNACE_HOST_<NAME>_TOKEN convention (host=node) but collides with provision's provider meaning. This fork pre-exists in the glossary (node a.k.a. box vs host provider); consider pinning host in CONTEXT.md so the term is not re-forked.
  (CONTEXT.md glossary: node vs host provider; spec story 1 provision --host hetzner)
- Trivial doc nit: the pickHost JSDoc references {@link selectHost}, but the function is named pickHost (no selectHost exists). Update the link.
  (src/cli/run.ts runSiteCli doc comment near line 687)
