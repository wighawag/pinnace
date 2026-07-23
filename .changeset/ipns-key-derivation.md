---
'pinnace': minor
---

Add the frozen master-key -> per-site IPNS key derivation (`deriveIpnsKey` / `deriveIpnsId`): `HKDF-SHA256(master, info = "pinnace:ipns:v1:" + keyId, 32)` -> ed25519 seed -> `k51...` IPNS id, with the ENS name deliberately never an input. `deriveIpnsId` is the no-deploy/no-network derive-and-print path (user story 22, set the ENS contenthash before the first deploy). Golden-vector tests pin the fixed (master, keyId) -> fixed seed/pubkey/id and assert keyId independence from the ENS name, and ADR-0001 records the frozen scheme (KDF, the exact `pinnace:ipns:v1:` info prefix carrying the version, the empty-salt default, keyId-as-info source, and the ed25519-from-32-bytes step) and why it must never change once names are live.
