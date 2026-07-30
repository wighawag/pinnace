---
title: A NEW signer's IPNS sequence silently resets to 0 when the DHT lookup for the existing record fails, so its record LOSES to the old one for the rest of the 72h validity
slug: ipns-sequence-resets-to-zero-on-a-new-signer
source: 'boxo namesys/ipns_publisher.go @ dd8cfd29e481 (2026-07-21), functions GetPublished + updateRecord, read 2026-07-30; cross-checked against kubo v0.38.1 core/commands/name/publish.go (the --sequence option) and the IPNS record spec (specs.ipfs.tech/ipns/ipns-record: records compared by sequence number) + docs.ipfs.tech/concepts/ipns (the sequence increments only when the content path changes)'
---

## The behaviour our failover story assumes, and what actually happens

pinnace's whole publisher/replica model rests on the idea that a name can be recovered by making some OTHER node sign it: a reprovisioned publisher, or (were node state reachable) a promoted replica. Both cases are the same primitive: **a node that holds no prior record for the key issues `name/publish` for a name that is already live in the network.**

In IPNS, records are compared by SEQUENCE NUMBER: among unexpired records, the highest sequence wins. So the new signer's record only takes effect if its sequence exceeds the dead publisher's last one.

Here is how boxo actually picks that sequence (`namesys/ipns_publisher.go`, `updateRecord`):

```go
// get previous records sequence number
rec, err := p.GetPublished(ctx, name, true)   // checkRouting = true
...
seq := uint64(0)
if rec != nil {
    // continue from the existing sequence (and ++ only if the value changed)
} else if opts.Sequence != nil {
    // caller-supplied sequence
}
// If no existing record and no custom sequence, seq remains 0
```

`GetPublished` is called with `checkRouting = true`, so on a fresh node it does the right thing FIRST: local datastore miss, then a DHT lookup for the existing record. That path is why failover works at all when the network cooperates.

**The hazard is the failure branch, which is silent:**

```go
case ds.ErrNotFound:
    if !checkRouting { return nil, nil }
    routingKey := name.RoutingKey()
    value, err = p.routing.GetValue(ctx, string(routingKey))
    if err != nil {
        // Not found or other network issue. Can't really do
        // anything about this case.
        if err != routing.ErrNotFound { log.Debugf(...) }
        return nil, nil          // <-- indistinguishable from "no record exists"
    }
```

A DHT lookup that fails for ANY reason (not-found, network issue, or the 30s `context.WithTimeout` in `GetPublished` expiring) returns `nil, nil`. `updateRecord` cannot tell that apart from a genuinely new name, so `seq` stays **0**.

A `seq 0` record loses to the dead publisher's `seq N` record, which remains valid, cached in replicas' fallback caches, and served by resolvers, for the remainder of the ~72h `RECORD_LIFETIME`. The new publisher signs happily, exports a record, replicas mirror it, every pinnace-visible indicator is green, and the name keeps resolving to the OLD CID.

## Why pinnace is unusually exposed to the failure branch

Three of our own choices line up on it:

- `publishSiteRecord` (`src/publisher/ipns-publish.ts`) sends `allow-offline=true`, documented as being for "a freshly-booted node with no peers yet". That is precisely a node whose DHT lookup will fail.
- The `republish` timer fires at `OnBootSec=8min` (`src/provision/cloud-init.ts`), i.e. on a brand-new box while DHT connectivity is at its worst.
- Sequence numbers stay LOW in pinnace, because the sequence increments only when the content path changes. So `N` equals roughly the number of deploys, and 0 is not far below it. This does not make it safe: 0 still loses to any N >= 1.

The failure presents as "the name still points at the old CID", which is indistinguishable from ordinary post-deploy propagation lag, and pinnace's `status` reports no sequence number at all.

## The lever that exists

Kubo **v0.38.1** (the version pinned in `cloud-init.ts` as `DEFAULT_KUBO_VERSION`) already accepts a custom sequence on `name/publish`:

```
--sequence uint64  Set a custom sequence number for the IPNS record (must be higher than current).
```

Its own help text names our exact case: *"useful for manually coordinating updates across multiple writers."* Added in ipfs/kubo#10851, merged 2025-08-13, before v0.38.0 (2025-10-02).

Semantics worth knowing before using it:
- with an existing record, `*opts.Sequence <= currentSeq` is rejected with `ErrInvalidSequence`;
- with NO existing record, a supplied sequence must be at least 1 (0 is rejected);
- so it is a safe upper-bound override: passing a comfortably high number cannot silently do the wrong thing, it either applies or errors.

`KuboRpcClient.namePublish` (`src/rpc/kubo-rpc-client.ts`) does not send this parameter today, and nothing in pinnace reads or records a name's current sequence.

## What this does NOT say

It does not say failover is broken in general: when the new signer's DHT lookup succeeds, boxo continues the sequence correctly and failover works. The 2026-07-25 live run (now `notes/observations/live-end-to-end-validated-clean-boot-onbox-failover.md`, reclassified because its REPLICA half turned out to be unconfirmed) exercised a FIRST publish, not a second signer taking over an already-live name, so it neither confirms nor contradicts this.

It says the mechanism has a silent failure branch that pinnace neither avoids, detects, nor reports, and that this is a property of the failover PRIMITIVE, so it applies identically whether the new signer arrives by reprovisioning a box or by any future in-place role change.
