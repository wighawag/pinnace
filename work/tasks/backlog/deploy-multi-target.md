---
title: Deploy — import same CAR to every node, per-site mode branch, MFS placement
slug: deploy-multi-target
spec: pinnace
promptGuidance.testFirst: true
blockedBy: [kubo-rpc-client, car-build, config-resolution]
covers: [4, 6, 7]
---

## What to build

The host-agnostic `deploy` operation in the core: build the CAR once (via the `car-build` seam), then import the SAME CAR into every configured node so all nodes serve the identical CID, pin it (`dag/import?pin-roots=true`), and place it in MFS at `/sites/<name>` (mkdir parents, rm old, cp `/ipfs/<cid>`) so gateway warming and IPNS auto-discover it. Fan out across targets, each with its OWN token (multi-target = same CID everywhere, no single point of failure). Report per-node success/failure (some-nodes-up is still a success, as the prototype does).

Implement the **per-site mode branch** at this seam:
- `ipfs` mode: land + pin + MFS only (no key, no publish); ENS uses `ipfs://<cid>` per deploy.
- `ipns` mode: everything above PLUS the publish path (`key/list` then `name/publish`) on the publisher only.

The actual publisher/replica record machinery and key import live in sibling tasks; here, test the API-CALL SEQUENCE per mode against the mock Kubo API: assert `ipfs` mode hits ONLY import+MFS, and `ipns` mode ADDS `key/list` + `name/publish`, and that a replica target (publish disabled) never publishes.

## Acceptance criteria

- [ ] `deploy` builds one CAR and imports the SAME CAR into every configured node (each with its own token), all pinned, all yielding the identical CID.
- [ ] Each node gets the site placed in MFS at `/sites/<name>` (mkdir parents / rm old / cp `/ipfs/<cid>`).
- [ ] Mode branch verified against the mock Kubo API: `ipfs` mode = import + MFS ONLY; `ipns` mode = ADDS `key/list` + `name/publish`.
- [ ] A replica / publish-disabled target performs import + MFS but NEVER `name/publish`.
- [ ] Multi-target fan-out: partial failure is reported per node and a non-empty subset succeeding is still an overall success (mirror the prototype's `allSettled` behaviour).
- [ ] Test-first: the failing per-mode call-sequence tests are written before the implementation, at the RPC (mock API) seam.
- [ ] Tests cover the new behaviour against the mock Kubo API, not a live daemon.

## Blocked by

- Blocked by `kubo-rpc-client` (the RPC seam + mock API), `car-build` (the CAR + root CID), and `config-resolution` (targets/sites/modes).

## Prompt

> Goal: build pinnace's host-agnostic **deploy**. Read CONTEXT.md (`CAR`, `CID`, `mode`, `node`) and the spec's deploy user stories (4, 6, 7) + the "Per-site mode branch" Implementation Decision. Reference prototype: `~/searches/ipfs-hetzner/deploy-car.mjs` (the multi-target fan-out, MFS placement, and mode branch) — PORT the behaviour into the TS core over the existing seams, do not copy verbatim.
>
> Flow: build the CAR ONCE via the `car-build` seam, then for EACH configured node (via the `kubo-rpc-client`, each node with its own token): `dag/import?pin-roots=true` (pin), then MFS `/sites/<name>` = mkdir(parents) + rm(old,recursive,force) + cp `/ipfs/<cid>`. Same CAR -> same CID on every node (redundancy, no single point of failure). Partial failure is per-node and a non-empty success subset is still success (mirror the prototype's `Promise.allSettled`).
>
> Mode branch (spec-verified): `ipfs` mode does land+pin+MFS ONLY; `ipns` mode ADDS the publish path (`key/list`, then `name/publish`) and only on a publisher target (a replica / publish-disabled target never publishes). The full publisher/replica record export+mirror and the key import into the keystore are SEPARATE tasks (`publisher-replica-model`, `key-import-publisher`) — here you only wire the per-mode call SEQUENCE.
>
> Test at the Kubo RPC boundary with the MOCK API from `kubo-rpc-client` (spec Testing Decisions: assert the exact call sequence per mode + multi-target fan-out + replica-never-publishes). Test-first: write the failing per-mode sequence assertions before implementing. Done means both modes drive the correct API calls across all targets, proven against the mock.
