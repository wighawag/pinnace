---
title: review-gate non-blocking nits for 'node-agent-commands' (Gate 2 approve)
date: 2026-07-23
status: open
reviewOf: node-agent-commands
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'node-agent-commands' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- No Decisions block in the PR/commit: the agent shipped several in-scope choices a human should ratify. Please ratify or reverse each.
  (git commit body has no ## Decisions block; the choices below were made unrecorded.)
- Ratify: the default core ops (defaultRepublish/defaultMirror) implement the FULL export/fetch/put/fallback record sequence that publisher-replica-model OWNS, not thin stubs. This duplicates logic across two tasks that must reconcile behind the NodeCommandOps seam; risk of drift until that task lands and replaces them.
  (node-commands.ts defaultRepublish/defaultMirror; task says the SEQUENCE is owned/tested by publisher-replica-model. Seam is designed for replacement so reversible, but the overlap is real.)
- Ratify: runNodeCli validates the verb and returns 0 WITHOUT assembling context or invoking runNodeCommand; actual on-box execution wiring is deferred to a later (cloud-init/config) task. Intended, but the CLI path is currently a no-op beyond validation.
  (src/cli/run.ts runNodeCli returns 0 after verb check; JSDoc states context assembly is a later task.)
- Coherence: task+ADR say verbs self-gate on NODE_ROLE (env), but the gate reads ctx.role sourced from config-resolution HostRole, not an env var literally named NODE_ROLE. Confirm the config resolver is the intended single source for role so the NODE_ROLE wording does not later spawn a second role lever.
  (VERB_ROLE_GATE checks ctx.role; config-resolution.ts HostRole. CONTEXT.md defines role via config, consistent.)
- Isolation: tests assert writes land under temp recordsDir/cacheDir/dashboardDir but do not explicitly assert a real global path is UNTOUCHED. Structurally safe (paths are required ctx fields; undefined = skip, no default), so low risk, but the explicit untouched-assertion the contract prefers is absent.
  (node-commands.test.ts uses mkdtemp fixtures; writeStatusReport/defaultRepublish gate on ctx.*Dir being set.)
