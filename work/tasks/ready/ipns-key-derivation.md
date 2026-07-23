---
title: Frozen master-key -> per-site IPNS key derivation (golden vectors + ADR)
slug: ipns-key-derivation
spec: pinnace
promptGuidance.testFirst: true
blockedBy: [scaffold-pinnace-package]
covers: [8, 9, 22]
---

## What to build

The deterministic derivation of a per-site IPNS key from the operator's master secret. This is a FROZEN CONTRACT and MUST NOT change once any name is live, because changing any input changes every derived name irreversibly. Implement exactly:

`seed_i = HKDF-SHA256(ikm = master, info = "pinnace:ipns:v1:" + keyId, length = 32)` -> the 32 bytes are the ed25519 private seed -> its public key IS the IPNS name (`k51...`).

`keyId` is frozen and internal; the ENS name is separate and mutable (derivation NEVER consumes the ENS name). Also expose a way to derive and PRINT a site's IPNS id from master + keyId WITHOUT deploying (user story 22, so an operator can set the ENS contenthash before the first deploy).

Because this is irreversible once names are live, this task has TWO mandatory guardrails beyond the code:

1. **Golden-vector tests**: a fixed master + fixed keyId must ALWAYS produce the same ed25519 key AND the same `k51...` IPNS id. Pin the vectors in the test. Also assert `keyId` independence from the ENS name (same keyId + different ensName -> same id).
2. **An ADR in `docs/adr/`** pinning the scheme (the KDF, the exact `info` prefix `pinnace:ipns:v1:`, the keyId-as-info source, and the ed25519-from-32-bytes step), recording WHY it is frozen and that the version lives in the `info` string (`v1`).

Key IMPORT into a node's keystore and the "no client signing" boundary are a SEPARATE task (`key-import-publisher`); this task is derivation + id only.

## Acceptance criteria

- [ ] Derivation implements `HKDF-SHA256(master, info = "pinnace:ipns:v1:" + keyId, 32)` -> ed25519 seed -> `k51...` IPNS id, exactly.
- [ ] The ENS name is NEVER an input to derivation; `keyId` is the sole per-site input to the `info` string.
- [ ] A derive-and-print path returns a site's IPNS id from master + keyId with no deploy/network (covers story 22).
- [ ] Golden-vector tests pin fixed (master, keyId) -> fixed ed25519 key + fixed `k51...` id, and assert keyId independence from ensName.
- [ ] An ADR under `docs/adr/` pins the frozen scheme (KDF, `info` prefix `pinnace:ipns:v1:`, keyId source, ed25519-from-32-bytes, versioning via the `info` string).
- [ ] Test-first: the failing golden-vector test is written before the implementation.
- [ ] Tests cover the new behaviour (golden vectors + keyId/ensName independence); tests touch no shared/global location.

## Blocked by

- Blocked by `scaffold-pinnace-package`.

## Prompt

> Goal: implement pinnace's **master-key -> per-site IPNS key derivation**, a FROZEN CONTRACT. Read CONTEXT.md (`master key`, `keyId`, `ENS name`) and the spec's "Master-key -> per-site IPNS key" Implementation Decision.
>
> The scheme, exactly (do NOT deviate — it is irreversible once names are live):
> `seed = HKDF-SHA256(ikm = master, info = "pinnace:ipns:v1:" + keyId, length = 32)`; the 32 bytes ARE the ed25519 private seed; the public key IS the IPNS name (`k51...`). The version is encoded in the `info` string (`v1`). `keyId` is frozen + internal and is the ONLY per-site input; the ENS name is separate and mutable and MUST NOT enter derivation. Also expose deriving+printing a site's IPNS id from master + keyId with no deploy (spec user story 22 — set ENS contenthash before first deploy).
>
> TWO mandatory guardrails because this is a frozen, irreversible contract:
> 1. Golden-vector tests: pin a fixed master + keyId and assert it ALWAYS yields the same ed25519 key and the same `k51...` id; and assert same keyId + different ensName -> same id (independence). Write these FAILING first (test-first is on).
> 2. Write an ADR in `docs/adr/` (format: `work/protocol/ADR-FORMAT.md`, sequential `NNNN-slug.md`) pinning the KDF, the exact `info` prefix `pinnace:ipns:v1:`, the keyId-as-info source, the ed25519-from-32-bytes step, and WHY it is frozen (changing any input changes every live name). This is the durable, irreversible-scheme record the review findings require.
>
> Out of scope here: importing the key into a node keystore and the "no client signing" boundary — that is the sibling task `key-import-publisher`. Done means: deterministic derivation matching the golden vectors, a derive-print path, and the frozen-scheme ADR committed.
