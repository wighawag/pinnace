---
title: IPNS-front an external pin — pinnace pin <cid> --as <name> --mode ipns
slug: pin-external-cid-ipns-mode
spec: pinnace
blockedBy: []
covers: [8, 11, 12, 15]
---

## What to build

Extend `pinnace pin` with a `--mode ipns` option so that pinning an external CID ALSO publishes a stable, operator-controlled IPNS name pointing at that pinned CID. This gives the operator `ipns://<their-derived-id>` for content they MIRROR: a mutable pointer THEY control, so when they later `pin` a NEWER CID under the same `--as <name>`, the IPNS name updates to it. The content is still someone else's; the NAME is the operator's own (their key, derived from their master), which is the honest model — they are not claiming the external content's authorship, they are publishing their own stable pointer to a snapshot they keep alive.

Default stays `--mode ipfs` (the current behaviour): pin + MFS only, addressed by the immutable `ipfs://<cid>`, no key, no publish. `--mode ipns` ADDS the publish path, exactly mirroring `deploy`'s per-site mode branch — reuse those seams, do NOT fork a parallel publish flow:

- Derive the per-site key from the master + the `--as <name>` id (`deriveIpnsKey`, the SAME single-`id`-is-the-KDF-input rule as deploy/derive/promote).
- Import it onto the PUBLISHER node's keystore (`importIpnsKeyIntoPublisher`, the same call `promote` makes) if not already present.
- Publish the pinned CID under that key: `key/list` to resolve the id, then `name/publish arg=/ipfs/<cid> key=<name>` — ONLY on the publisher target (a replica never signs; it will mirror via the on-box `republish`/`mirror` timers exactly as for a deployed ipns site).
- The pin is still fanned out to ALL nodes (redundant pin), but the PUBLISH happens only on the publisher — same publisher/replica split as deploy's ipns mode.

Because the CID is placed at `/sites/<name>` with a same-named key on the publisher, the on-box `republish` timer already refreshes + exports the record and replicas mirror it — so an ipns-mode external pin gets the SAME failover machinery as a deployed ipns site, for free. Re-pinning a newer CID under the same name + re-publishing updates the record (the operator re-runs `pin --mode ipns`, or the next deploy-like publish picks up the new MFS CID).

Master is env-only (`resolveMasterSecret`), as everywhere. `--mode ipns` requires a publisher among the targets (error clearly if the operator's config has no publisher / `--host` points at a replica — a replica cannot sign).

## Acceptance criteria

- [ ] `pinnace pin <cid> --as <name> --mode ipns` pins the CID on all nodes (redundant), imports the master-derived key onto the publisher, and `name/publish`es the pinned CID under it; prints the resulting `ipns://<id>`.
- [ ] `--mode ipfs` (the default) is UNCHANGED: pin + MFS only, no key, no publish.
- [ ] The publish path REUSES the existing seams (`deriveIpnsKey`, `importIpnsKeyIntoPublisher`, `key/list` + `name/publish`) — no forked/duplicated publish logic; the publisher/replica split matches deploy's ipns mode (only the publisher signs).
- [ ] Re-pinning a newer CID under the same `--as <name>` in ipns mode updates the published record to the new CID (the name is stable, the CID it points at changes).
- [ ] `--mode ipns` with no publisher target (or `--host` = a replica) fails LOUD (a replica cannot sign); master resolves env-only.
- [ ] The derived id equals the golden derivation for that `name` (same `id` -> same `k51...` as `derive`/`promote`), so an operator can pre-set the id before pinning.
- [ ] Test-first at the mock Kubo RPC seam: `--mode ipfs` issues only pin/add + MFS; `--mode ipns` ADDS key import (publisher only) + `key/list` + `name/publish arg=/ipfs/<cid>`; a replica target never publishes; the no-publisher case errors. No live daemon; master isolated in tests.

## Blocked by

- None — `pin-external-cid` (the pin + fan-out + MFS), `deploy-multi-target` (the ipns mode branch to mirror), `ipns-key-derivation` (`deriveIpnsKey`), `key-import-publisher` (`importIpnsKeyIntoPublisher`), and `publisher-replica-model` (the record machinery the on-box timers run) are all in `tasks/done/`.

## Prompt

> Goal: add `--mode ipns` to `pinnace pin`, so pinning an external CID also publishes a stable IPNS name (the operator's own derived key) pointing at that pinned CID — a mutable pointer they control to content they mirror. Read the done tasks `pin-external-cid` (the pin + fan-out + `placeInMfs`), `deploy-multi-target` (its per-site mode branch — REUSE it, do not fork), `ipns-key-derivation` (`deriveIpnsKey`), `key-import-publisher` (`importIpnsKeyIntoPublisher`, same call `promote` makes), and `publisher-replica-model`. Read CONTEXT.md so `pin`/`deploy`/`mode` stay coherent.
>
> Default `--mode ipfs` is unchanged (pin + MFS, `ipfs://<cid>`). `--mode ipns` ADDS the publish path mirroring deploy's ipns mode: derive the key from master + the `--as <name>` id, import it onto the PUBLISHER (`importIpnsKeyIntoPublisher`), then `key/list` + `name/publish arg=/ipfs/<cid> key=<name>` on the publisher ONLY (a replica never signs — it mirrors via the on-box timers, since the CID is at `/sites/<name>` with a same-named key, so failover comes for free). The pin still fans out to all nodes; only publish is publisher-only. Re-pinning a newer CID under the same name re-publishes -> the name updates. Master env-only; `--mode ipns` with no publisher target (or `--host` a replica) errors loud. Test-first at the mock seam: ipfs = pin+MFS only; ipns ADDS key import + key/list + name/publish(/ipfs/<cid>); replica never publishes; no-publisher errors; derived id matches the golden `id`. Done means an operator can pin external content AND publish their own stable ipns:// pointer to it, updatable by re-pinning.
