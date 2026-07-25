---
title: Wire the client CLI verbs end-to-end (assemble context + invoke the core)
slug: wire-client-cli-verbs-end-to-end
spec: pinnace
blockedBy: []
covers: [2, 12, 13, 16, 18, 19, 20, 22]
---

## What to build

Make the `pinnace` CLI actually EXECUTE its client and on-box verbs end-to-end. Across several tasks the CLI routers were deliberately built as thin validate-and-return-0 stubs, with real context assembly + core invocation deferred to "a later CLI task" (the repo's consistent deferred-CLI pattern). That later task is this one: no task currently owns actually connecting the parsed CLI args to the resolved config + the core functions for the on-box and site namespaces (and the promote verb).

Observed deferrals to close (from the Gate-2 review nits):
- `runNodeCli` (node-agent-commands) validates the verb and returns 0 without assembling context or invoking `runNodeCommand`.
- `runSiteCli` (site-management) validates the verb and returns 0 without assembling a client or invoking `listSites`/`removeSite`/`addSite`.
- `makeStatusOp` (status-report) is exported + tested but NOT wired into `DEFAULT_OPS.status`; the production node `status` verb still runs the thin `defaultStatus` stand-in.
- `promoteReplicaToPublisher` (publisher-replica-model, story 14) is implemented + exported + tested but not reachable as a dispatchable CLI verb.

`cli-command-wrapper` established the injectable `RunContext`/`ClientDeps` seam and wired the CLIENT verbs (provision/deploy/install-ci/status/derive); reuse that SAME seam (do not fork a second one) to finish wiring the node/site namespaces, the real `status` op, and the promote verb, so every documented verb runs the core over correctly-resolved config.

### On-box context assembly (the load-bearing part for a REAL failover)

The on-box `node` verbs run on a provisioned box, invoked by systemd timers with `EnvironmentFile=/etc/pinnace-node.env`. `runNodeCli` MUST assemble a `NodeCommandContext` from that env (NOT return 0): a per-node `KuboRpcClient` against the LOCAL Kubo (`127.0.0.1:5001` + the box's bearer token), plus the on-box PATHS the context needs — `role` (`NODE_ROLE`), `recordsDir` (where the publisher EXPORTS records, the dashboard's records dir), `cacheDir` (replica fallback cache), `publisherEndpoint` (replica: where to fetch the publisher's records), and `dashboardDir` (status output). A live run (2026-07-24) confirmed that WITHOUT this, `pinnace node republish` is a clean no-op, so the publisher never populates `/records/` and a replica gets `no-record` — the on-box IPNS record transport is dead. See `work/notes/findings/live-ipns-record-transport-depends-on-dashboard-vhost-and-on-box-timer.md`.

This pairs with a cloud-init requirement (fix in `cloud-init-generation` if the emitted `/etc/pinnace-node.env` lacks them): the env file MUST carry the paths the on-box verbs read — e.g. `RECORDS_DIR=/var/www/ipfs-dash/records`, `CACHE_DIR=...`, `DASHBOARD_DIR=/var/www/ipfs-dash`, `PUBLISHER_ENDPOINT` (already present for replicas) — so `runNodeCli` can resolve `recordsDir`/`cacheDir`/`dashboardDir` from env. Name the exact env keys and where they are read; if the cloud-init needs a matching change, capture it as a sibling `cloud-init-generation` follow-up (or do it here) so the publisher's exported record actually lands under the dashboard's `/records/` that the replica fetches.

## Acceptance criteria

- [ ] The on-box `node` verbs (republish/mirror/warm/status) assemble context from resolved config and invoke `runNodeCommand` (no longer validate-and-return-0), reusing the `RunContext`/`ClientDeps` seam.
- [ ] The `site` verbs (list/remove/add) assemble a client and invoke `listSites`/`removeSite`/`addSite`.
- [ ] The production node `status` path uses `makeStatusOp` (the real per-site CID/IPNS/announce/gateway report), not the thin `defaultStatus` stub.
- [ ] `promote` (story 14) is dispatchable as a CLI verb that invokes `promoteReplicaToPublisher`.
- [ ] Dispatch tests assert each verb calls the correct core function with correctly-resolved args (stub/mock the core or the mock RPC seam), not re-testing core internals.
- [ ] Tests isolate env/config (temp/scratch via the ldenv/env lever) and assert the operator's real env/config is untouched.

## Blocked by

- None. (Previously blocked by `unify-ipns-key-name-convention`, now CANCELLED/subsumed by `config-token-env-only-and-single-site-id`: a site is a single `id` used as both the MFS entry and the keystore key name, so deploy's publish lookup and key-import's import name agree by construction — no name convention left to settle.)

## Prompt

> Goal: finish the `pinnace` CLI so every documented verb runs end-to-end. Several routers were shipped as intentional validate-and-return-0 stubs (the repo's deferred-CLI pattern); wire them to the resolved config + core now. Read CONTEXT.md (`core vs cli`, `config resolution`), and the done tasks `cli-command-wrapper` (the `RunContext`/`ClientDeps` seam to REUSE), `node-agent-commands`, `site-management`, `status-report`, `publisher-replica-model`.
>
> Close these observed deferrals (see the `work/notes/observations/review-nits-*.md`): `runNodeCli` + `runSiteCli` currently only validate the verb; the node `status` verb still uses `defaultStatus` instead of the tested `makeStatusOp`; `promoteReplicaToPublisher` (story 14) is core-only, not a dispatchable verb. Reuse the existing injectable seam (do NOT fork a second dispatch idiom). Keep the CLI thin: parse/validate → resolve config (arg > env > file, master env-only) → call core → format. Test-first: assert each verb dispatches to the right core fn with resolved args (stub/mock), isolate env/config in tests.
>
> CRITICAL on-box part: `runNodeCli` must assemble a `NodeCommandContext` from `/etc/pinnace-node.env` (local Kubo client at 127.0.0.1:5001 + bearer, `role` from `NODE_ROLE`, `recordsDir`/`cacheDir`/`dashboardDir`/`publisherEndpoint` from named env keys) and invoke `runNodeCommand`. A live run proved that without this the on-box `republish`/`mirror` timers are no-ops (publisher never populates `/records/`, replica gets `no-record`) — see the findings note. If the emitted `/etc/pinnace-node.env` lacks those path keys, add them in `cloud-init-generation` (e.g. `RECORDS_DIR=/var/www/ipfs-dash/records`, `DASHBOARD_DIR=/var/www/ipfs-dash`) so the export lands under the dashboard `/records/` the replica fetches; name the exact keys and where read.
>
> Done means node/site/status/promote all execute the core (proven by dispatch tests), the on-box `node` verbs assemble context from the box env, and the operator's real env/config is untouched.
