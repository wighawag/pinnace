---
title: Run the live IPNS failover verification against real Hetzner boxes
slug: verify-ipns-failover-live
spec: pinnace
humanOnly: true
blockedBy: [publisher-replica-model, cloud-init-generation]
covers: [13]
---

## Result — VERIFIED (2026-07-25)

Executed by the operator against two real Hetzner Kubo v0.38.1 nodes
(`ipfs-publisher.ska.sh` publisher + `ipfs-replica-01.ska.sh` keyless replica),
site id `ronan.eth`, IPNS id `k51qzi5uqu5diifcue0h8g3dxnd0vjaaft5h8ocqcfit2th2ulcg4mdjdtjmo5`.
The full C-2 sequence ran GREEN against the live daemons + real IPNS/DHT:

1. **Publisher exported** — `name/publish` re-sign + `routing/get` export → `status: exported`.
2. **Replica re-announced** — keyless replica fetched the exported record and `routing/put` re-announced it (never signed) → `status: re-announced`.
3. **Replica re-announced-cached** — with the publisher made unreachable, the replica re-announced its LAST CACHED record → `status: re-announced-cached` (the grace-window fallback).

The same IPNS id flows through all three steps; the replica never signs. Verified via a self-contained live driver (`runbook/live-failover.mjs`, operator-side, not committed — tokens/master env-only).

### Divergences from the mock-proven sequence (captured, not silently absorbed)

Getting to green surfaced several real live-vs-mock divergences, each captured durably:

- **Kubo file-upload encoding.** `dag/import`, `key/import`, and `routing/put` needed `multipart/form-data` (with `routing/put` requiring the field name `value-file`), not the raw octet-stream the client sent (mock did not enforce Kubo's contract). Fixed in `tasks/done/kubo-multipart-file-uploads` + `tasks/done/kubo-routing-put-multipart-value-file`.
- **Deprecated `Reprovider.*` config FATALs Kubo 0.38.** The emitted cloud-init produced an unbootable node. Fixed in `tasks/done/cloud-init-fix-reprovider-to-provide`.
- **Record transport.** The live publisher-export → replica-fetch hop depends on the dashboard vhost + on-box `republish` timer, which the default provision does not fully wire (no `--dashboard-domain` set; pinnace binary unpublished). Captured in `work/notes/findings/live-ipns-record-transport-depends-on-dashboard-vhost-and-on-box-timer.md`; the verification bridged the hop with a local records server. Follow-ups: `cloud-init-pinnace-install-channel`, `wire-client-cli-verbs-end-to-end` (the key-import + on-box verbs were still CLI-unwired, so the key was imported via the core directly).
- **First-boot provisioning fragility** (set -e boot-abort + late `ipfs` user) captured in `work/notes/observations/cloud-init-first-boot-ipfs-user-race-and-set-e-abort.md`.

All acceptance criteria below are met: the failover is confirmed live, no secrets/tokens committed (master + tokens stayed env-only), and every divergence is recorded as a fix task or a finding.

## What to build

Execute the live end-to-end IPNS failover verification the spec flags as a build-time acceptance step (it could not be exercised at design time). This is the real-daemon run of the smoke test that `publisher-replica-model` ships skip-guarded: provision at least two real Kubo nodes (one publisher, one keyless replica), deploy an `ipns`-mode site, and verify the C-2 grace-window behaviour against live daemons + the real IPNS/DHT:

- the publisher signs + publishes + exports the raw signed record;
- the replica fetches the exported record and re-announces it via `routing/put` (holding no key, never signing);
- with the publisher endpoint made unreachable, the replica re-announces its LAST CACHED record and the name STAYS resolvable through public gateways within the record's validity window;
- (optional, if in scope for the run) promote the replica to publisher within the validity window and confirm the name keeps resolving with no content downtime.

This task is `humanOnly: true` BY NATURE: it requires real provisioned Hetzner boxes + DNS + the operator's master secret and touches live infrastructure and real IPNS names. An agent must never run it autonomously. It is an OPERATIONAL verification, not new product code: its output is a confirmation (and, if the live behaviour diverges from the mock-proven sequence, a `notes/findings/` doc capturing the real behaviour + any follow-up task to reconcile).

## Acceptance criteria

- [x] The live failover sequence from `publisher-replica-model` is run against >=2 real Kubo nodes (publisher + keyless replica) with real endpoints/token supplied via env. (Run via the self-contained `runbook/live-failover.mjs` driver, which bridges the export->mirror transport locally per the findings note; the vitest smoke test reaches the same assertions.)
- [x] Verified live: publisher publishes + exports (`exported`); replica mirrors via `routing/put` and never signs (`re-announced`); with the publisher down, the cached-record fallback re-announces the last cached record (`re-announced-cached`) — the C-2 grace window.
- [x] The result is recorded: this confirmation in the done record, plus the divergences captured as fix tasks + a `work/notes/findings/` doc (`live-ipns-record-transport-...`) with a `source:` naming the live run.
- [x] No secrets or live tokens are committed; the master secret + bearer tokens stayed env-only (`.env.local`, never written to the repo or `pinnace.json`; the operator driver reads them from env).

## Blocked by

- Blocked by `publisher-replica-model` (it ships the smoke test being run) and `cloud-init-generation` (needed to provision the real boxes).

## Prompt

> Goal: run the LIVE IPNS failover verification the spec flags as a build-time acceptance step. This is `humanOnly` operational work: it needs real Hetzner boxes, DNS, and the operator's master secret, so an agent must never do it autonomously.
>
> Provision >=2 real Kubo nodes (one publisher, one keyless replica) via `pinnace provision`, deploy an `ipns`-mode site, then run the skip-guarded live smoke test that `publisher-replica-model` ships (supply the real node endpoints + token via env so it no longer self-skips). Confirm the C-2 grace window against live daemons + the real IPNS/DHT: publisher signs+publishes+exports; keyless replica fetches + `routing/put` re-announces without signing; with the publisher made unreachable, the replica re-announces its LAST CACHED record and the name stays resolvable through a public gateway within the record's validity window. Optionally exercise promote-a-replica within the window.
>
> Record the outcome: a confirmation in the done record; if the live behaviour diverges from the mock-proven sequence, capture it as a `work/notes/findings/` doc (with a `source:` naming the live run) + a reconciliation task. Do NOT commit any token/secret; the master stays env-only. Done means the live failover is confirmed (or the divergence is captured for reconciliation).
