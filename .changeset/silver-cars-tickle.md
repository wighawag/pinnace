---
'pinnace': minor
---

Surface the IPNS record SEQUENCE, the number that decides which record wins, and document the failover procedure it belongs to.

Among unexpired IPNS records the highest sequence wins, and pinnace reported it nowhere. That mattered most in the one situation the publisher/replica model exists for: when a NEW box starts signing a name that is already live, Kubo looks for the existing record locally and then in the routing system, and if both miss (likely on a box that booted minutes ago) it cannot tell that apart from a genuinely new name and silently starts at sequence 0. That record loses to the dead publisher's for the rest of its ~72h validity while every indicator reads green.

- `status` now reports `seq` per site, on the CLI line, in `status.json` and as a dashboard column. It is three-valued: the number when read, `unknown (<reason>)` when the record could not be read, and absent when the node holds no key for the site. It is never a fallback `0`, because a spurious `0` is precisely the failure it exists to expose. Comparing `seq` across hosts is how a half-completed failover, or two boxes signing one name, becomes visible.
- `KuboRpcClient.namePublish` accepts an explicit `sequence`, the corrective lever (Kubo refuses anything not strictly higher than the current record, so it cannot silently regress a name). Deliberately not exposed as a CLI flag.
- New `KuboRpcClient.nameInspect` decodes a raw signed record via Kubo's `name/inspect`; pinnace decodes no protobuf itself.
- New failover runbook at `docs/failover.md`, and the README no longer implies that recovering a name means reprovisioning boxes: a replica's `PUBLISHER_ENDPOINT` is a URL against the publisher's dashboard vhost, so repointing one DNS record moves every replica to a new publisher with no SSH and nothing to reprovision.
