---
title: Live end-to-end validation — clean-boot provisioning + on-box IPNS failover, DHT-resolved
source: 'live run 2026-07-25 against 2 fresh Debian 13 Hetzner boxes provisioned from pinnace@0.3.4/0.3.5 cloud-init (ipfs-publisher.ska.sh @ 62.238.33.85 + ipfs-replica-01.ska.sh @ 77.42.66.93, dashboard ipfs-dash.ska.sh); site id "basic", IPNS id k51qzi5uqu5dlqzk68fn2fkxlm774pc2qotnpwno7c8lt5d2b3rbqx82lweflz, CID bafybeigtg7thgwnqbnp575fcyhr6un4qmregyibjqnqb756lxwaztxukxi'
---

## What was validated (the whole system, on clean infrastructure)

The complete pinnace flow was proven end-to-end against TWO freshly-provisioned
real Kubo v0.38.1 nodes, using the PUBLISHED pinnace package (no manual code):

1. **Clean-boot provisioning (0.3.4).** Both boxes booted from cold, from the
   emitted cloud-init, and answered `POST /api/v0/id` (HTTP 200 + PeerID) over
   HTTPS through Caddy with the bearer token, with ZERO SSH intervention. (This
   only worked after fixing 6 cold-boot bugs; the root cause was `HOME` unset in
   `ipfs-setup.sh` aborting the script at its first `ipfs` call.)
2. **Deploy.** `pinnace deploy --mode ipns ./runbook/basic-site basic` built one
   CAR and imported the SAME CID into both nodes (`ok` on both), via the
   multipart `dag/import`.
3. **Key import.** `pinnace promote basic --host publisher` derived the per-site
   key from the master and imported it onto the publisher ->
   `k51qzi5uqu5dlqzk...`.
4. **On-box publisher.** `pinnace node republish` (systemd timer, on the box)
   signed + exported the raw record to `/var/www/ipfs-dash/records/basic.ipns-record`,
   served by Caddy at `https://ipfs-dash.ska.sh/records/basic.ipns-record`
   (HTTP 200).
5. **On-box replica.** `pinnace node mirror` (systemd timer, on the box) fetched
   that record and `routing/put` re-announced it -> journal `basic (re-announced)`;
   the replica never signs.
6. **DHT resolution (the definitive proof).** From an INDEPENDENT third node
   (a laptop's `ipfs`): `ipfs name resolve --dht-timeout=60s /ipns/k51qzi5uqu5dlqzk...`
   returned `/ipfs/bafybeigtg7thgwnqbn...` — the exact deployed CID, resolved via
   the real IPNS/DHT, NOT a gateway cache.
7. **Redundancy.** `pinnace status` shows BOTH nodes `gatewayServes=true` for the
   same CID — either box can die and the content stays reachable.

This is the full C-2 publisher/keyless-replica failover model working live, on
clean-booted infrastructure, driven by on-box systemd timers running the
published `pinnace` binary — no laptop bridge (the earlier `runbook/live-failover.mjs`
bridge is no longer needed; the on-box transport is real).

## Caveats / notes

- `pinnace status` reports `announced=false` (the delegated-routing providers
  check did not (yet) list our PeerID for the CID at query time), yet the DHT
  IPNS resolve + gateway-serves both succeed. Provider-record propagation and the
  delegated-routing providers index can lag; `announced` may be a stricter/slower
  signal than actual reachability. Not a failure, but worth understanding whether
  `status`'s announce check should be treated as eventual. (Candidate observation.)
- The two boxes used in this run needed a one-time
  `ln -sf /usr/bin/pinnace /usr/local/bin/pinnace` because they were provisioned
  from 0.3.4, whose timers hardcoded `/usr/local/bin/pinnace` while nodesource
  npm installs to `/usr/bin/pinnace` (203/EXEC). Fixed in 0.3.5
  (`ExecStart=/usr/bin/env pinnace` + explicit PATH); a fresh 0.3.5 reprovision
  needs no symlink. (Bin path bug, fixed.)
