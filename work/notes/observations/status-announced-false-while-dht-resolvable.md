---
title: status reports announced=false while the name IS DHT-resolvable and gateway-served
date: 2026-07-25
status: open
reviewOf: status-report
---

## What was observed (live)

After a full deploy + on-box republish/mirror, `pinnace status` reported for
both nodes:

```
basic: cid bafybeigtg7... ipns k51qzi5uqu5dlqzk... announced=false gatewayServes=true
```

Yet at the same time:
- `ipfs name resolve /ipns/k51qzi5uqu5dlqzk...` (from an independent node, real
  DHT) returned the correct CID, and
- both nodes' `gatewayServes=true`.

So `announced=false` is at odds with the site actually being reachable/resolvable.

## Why (hypothesis, unverified)

`status`'s announce check is the delegated-routing providers lookup
(`delegated-ipfs.dev/routing/v1/providers/<cid>` -> does `.Providers[].ID`
include our PeerID?). Provider-record publication + the delegated-routing index
can LAG well behind the content actually being pinned + the IPNS record being
announced. So `announced` may be a slower / stricter / eventually-consistent
signal than real reachability, and reporting a bare `false` at query time can be
misleading right after a deploy (the operator sees "announced=false" and thinks
it failed, when it is merely not-yet-indexed).

## Suggested disposition

Decide whether `status` should:
- treat `announced` as an EVENTUAL signal and label it accordingly (e.g.
  "not yet" vs a hard false), and/or
- give the reprovide/announce time before the check, and/or
- document that `announced` reflects the delegated-routing INDEX (which lags),
  distinct from `gatewayServes` (actual fetch) and DHT resolvability.
Not a correctness bug in deploy/publish (the name resolves); it is a
status-reporting fidelity question. Verify the lag hypothesis against a repeat
check a few minutes later (does announced flip to true?).
