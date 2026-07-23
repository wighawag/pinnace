---
title: Run the live IPNS failover verification against real Hetzner boxes
slug: verify-ipns-failover-live
spec: pinnace
humanOnly: true
blockedBy: [publisher-replica-model, cloud-init-generation]
covers: [13]
---

## What to build

Execute the live end-to-end IPNS failover verification the spec flags as a build-time acceptance step (it could not be exercised at design time). This is the real-daemon run of the smoke test that `publisher-replica-model` ships skip-guarded: provision at least two real Kubo nodes (one publisher, one keyless replica), deploy an `ipns`-mode site, and verify the C-2 grace-window behaviour against live daemons + the real IPNS/DHT:

- the publisher signs + publishes + exports the raw signed record;
- the replica fetches the exported record and re-announces it via `routing/put` (holding no key, never signing);
- with the publisher endpoint made unreachable, the replica re-announces its LAST CACHED record and the name STAYS resolvable through public gateways within the record's validity window;
- (optional, if in scope for the run) promote the replica to publisher within the validity window and confirm the name keeps resolving with no content downtime.

This task is `humanOnly: true` BY NATURE: it requires real provisioned Hetzner boxes + DNS + the operator's master secret and touches live infrastructure and real IPNS names. An agent must never run it autonomously. It is an OPERATIONAL verification, not new product code: its output is a confirmation (and, if the live behaviour diverges from the mock-proven sequence, a `notes/findings/` doc capturing the real behaviour + any follow-up task to reconcile).

## Acceptance criteria

- [ ] The skip-guarded live smoke test from `publisher-replica-model` is run against >=2 real Kubo nodes (publisher + keyless replica) with real endpoints/token supplied via env.
- [ ] Verified live: publisher publishes + exports; replica mirrors via `routing/put` and never signs; with the publisher down, the cached-record fallback keeps the name resolvable through a public gateway within the validity window.
- [ ] The result is recorded: a confirmation in the done record, and if live behaviour diverges from the mock-proven sequence, a `work/notes/findings/` doc (with a `source:` capturing the live run) plus any reconciliation task.
- [ ] No secrets or live tokens are committed; the master secret stays env-only (never written to the repo or `pinnace.json`).

## Blocked by

- Blocked by `publisher-replica-model` (it ships the smoke test being run) and `cloud-init-generation` (needed to provision the real boxes).

## Prompt

> Goal: run the LIVE IPNS failover verification the spec flags as a build-time acceptance step. This is `humanOnly` operational work: it needs real Hetzner boxes, DNS, and the operator's master secret, so an agent must never do it autonomously.
>
> Provision >=2 real Kubo nodes (one publisher, one keyless replica) via `pinnace provision`, deploy an `ipns`-mode site, then run the skip-guarded live smoke test that `publisher-replica-model` ships (supply the real node endpoints + token via env so it no longer self-skips). Confirm the C-2 grace window against live daemons + the real IPNS/DHT: publisher signs+publishes+exports; keyless replica fetches + `routing/put` re-announces without signing; with the publisher made unreachable, the replica re-announces its LAST CACHED record and the name stays resolvable through a public gateway within the record's validity window. Optionally exercise promote-a-replica within the window.
>
> Record the outcome: a confirmation in the done record; if the live behaviour diverges from the mock-proven sequence, capture it as a `work/notes/findings/` doc (with a `source:` naming the live run) + a reconciliation task. Do NOT commit any token/secret; the master stays env-only. Done means the live failover is confirmed (or the divergence is captured for reconciliation).
