---
title: Wire the client CLI verbs end-to-end (assemble context + invoke the core)
slug: wire-client-cli-verbs-end-to-end
spec: pinnace
blockedBy: [unify-ipns-key-name-convention]
covers: [16, 18, 19, 20, 22]
---

## What to build

Make the `pinnace` CLI actually EXECUTE its client and on-box verbs end-to-end. Across several tasks the CLI routers were deliberately built as thin validate-and-return-0 stubs, with real context assembly + core invocation deferred to "a later CLI task" (the repo's consistent deferred-CLI pattern). That later task is this one: no task currently owns actually connecting the parsed CLI args to the resolved config + the core functions for the on-box and site namespaces (and the promote verb).

Observed deferrals to close (from the Gate-2 review nits):
- `runNodeCli` (node-agent-commands) validates the verb and returns 0 without assembling context or invoking `runNodeCommand`.
- `runSiteCli` (site-management) validates the verb and returns 0 without assembling a client or invoking `listSites`/`removeSite`/`addSite`.
- `makeStatusOp` (status-report) is exported + tested but NOT wired into `DEFAULT_OPS.status`; the production node `status` verb still runs the thin `defaultStatus` stand-in.
- `promoteReplicaToPublisher` (publisher-replica-model, story 14) is implemented + exported + tested but not reachable as a dispatchable CLI verb.

`cli-command-wrapper` established the injectable `RunContext`/`ClientDeps` seam and wired the CLIENT verbs (provision/deploy/install-ci/status/derive); reuse that SAME seam (do not fork a second one) to finish wiring the node/site namespaces, the real `status` op, and the promote verb, so every documented verb runs the core over correctly-resolved config.

## Acceptance criteria

- [ ] The on-box `node` verbs (republish/mirror/warm/status) assemble context from resolved config and invoke `runNodeCommand` (no longer validate-and-return-0), reusing the `RunContext`/`ClientDeps` seam.
- [ ] The `site` verbs (list/remove/add) assemble a client and invoke `listSites`/`removeSite`/`addSite`.
- [ ] The production node `status` path uses `makeStatusOp` (the real per-site CID/IPNS/announce/gateway report), not the thin `defaultStatus` stub.
- [ ] `promote` (story 14) is dispatchable as a CLI verb that invokes `promoteReplicaToPublisher`.
- [ ] Dispatch tests assert each verb calls the correct core function with correctly-resolved args (stub/mock the core or the mock RPC seam), not re-testing core internals.
- [ ] Tests isolate env/config (temp/scratch via the ldenv/env lever) and assert the operator's real env/config is untouched.

## Blocked by

- Blocked by `unify-ipns-key-name-convention` (the CLI is exactly where deploy's publish name and key-import's key name get bound, so the shared convention must be settled first to avoid wiring in the silent-skip mismatch).

## Prompt

> Goal: finish the `pinnace` CLI so every documented verb runs end-to-end. Several routers were shipped as intentional validate-and-return-0 stubs (the repo's deferred-CLI pattern); wire them to the resolved config + core now. Read CONTEXT.md (`core vs cli`, `config resolution`), and the done tasks `cli-command-wrapper` (the `RunContext`/`ClientDeps` seam to REUSE), `node-agent-commands`, `site-management`, `status-report`, `publisher-replica-model`.
>
> Close these observed deferrals (see the `work/notes/observations/review-nits-*.md`): `runNodeCli` + `runSiteCli` currently only validate the verb; the node `status` verb still uses `defaultStatus` instead of the tested `makeStatusOp`; `promoteReplicaToPublisher` (story 14) is core-only, not a dispatchable verb. Reuse the existing injectable seam (do NOT fork a second dispatch idiom). Keep the CLI thin: parse/validate → resolve config (arg > env > file, master env-only) → call core → format. Test-first: assert each verb dispatches to the right core fn with resolved args (stub/mock), isolate env/config in tests. Done means node/site/status/promote all execute the core, proven by dispatch tests, with the operator's real env/config untouched.
