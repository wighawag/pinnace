# Frozen master-key -> per-site IPNS key derivation

**Status:** accepted

Every `ipns`-mode site's IPNS key is derived deterministically from one operator-held master secret, so names are recoverable from the master alone and provisioning is stateless (a lost box loses nothing). The derivation is a **frozen contract**: it MUST NOT change once any name is live, because changing any input moves every derived name irreversibly. This ADR pins the scheme so a future reader cannot "improve" it and silently break every live site.

## The scheme (frozen)

```
seed = HKDF-SHA256(ikm = master, salt = "", info = "pinnace:ipns:v1:" + keyId, length = 32)
     -> the 32 bytes ARE the ed25519 private seed (RFC 8032)
     -> its public key IS the IPNS name, encoded as a CIDv1 `k51...` id.
```

Implemented in `packages/pinnace/src/derive/ipns-key-derivation.ts` (`deriveIpnsKey` / `deriveIpnsId`), verified by the golden vectors in `packages/pinnace/test/derive/ipns-key-derivation.test.ts`.

## What is pinned, and why each byte matters

- **KDF = HKDF-SHA256.** Standard, deterministic key derivation with a domain-separating `info` label. The full HKDF (extract + expand) is used, not a bare hash.
- **`info` prefix = exactly `pinnace:ipns:v1:`.** This label domain-separates pinnace's keys from any other use of the same master and carries the scheme **version**: `v1` lives **in the `info` string**, NOT in a separate parameter. A future v2 scheme uses a new prefix (e.g. `pinnace:ipns:v2:`) and therefore derives entirely new names; it never re-derives or disturbs v1 names.
- **`keyId` is the SOLE per-site input.** It is appended verbatim (UTF-8) to the info prefix. `keyId` is frozen and internal (CONTEXT.md `keyId`).
- **The ENS name is NEVER an input.** The `<name>.eth` a site publishes under is mutable and deliberately untied from the key (CONTEXT.md `ENS name`), so it can change without shifting the IPNS id. The derivation surface has no `ensName` parameter at all — independence is structural, not merely conventional.
- **HKDF `salt` = empty (zero-length), the RFC 5869 default.** The originating spec pins `ikm`, `info`, and `length` but does not name a salt. RFC 5869 defines the absent-salt case as a zero-length salt, so pinning it empty makes the contract total and removes any ambiguity. (Domain separation is already provided by the `info` label, which is HKDF's designed mechanism for it, so a per-derivation salt would add nothing here.)
- **ed25519-from-32-bytes.** The 32 HKDF output bytes are used **directly** as the ed25519 private seed (RFC 8032 / RFC 8410 PKCS#8), NOT re-hashed or expanded again. The raw 32-byte public key is extracted from the resulting keypair.
- **IPNS id = CIDv1(libp2p-key) over the identity-hashed PublicKey protobuf, base36.** The `k51...` name is `0x01 0x72` (CIDv1, libp2p-key) + `0x00 0x24` (identity multihash, length 36) + `0x08 0x01 0x12 0x20` (the libp2p PublicKey protobuf: Type = Ed25519, Data length 32) + the 32 raw public-key bytes, rendered in base36 with the `k` multibase prefix. This is the standard IPNS-name encoding for ed25519 (https://specs.ipfs.tech/ipns/ipns-record/), and the encoder is verified against a known live IPNS name.

## Why frozen

The IPNS id is a pure function of `(master, keyId)`. Any change to the KDF, the `info` prefix, the salt, the seed-to-ed25519 step, or the id encoding produces different ids for the *same* inputs. Because operators set their ENS contenthash to `ipns://<id>` (often before the first deploy — user story 22), a changed id silently orphans every live name with no migration path. The golden-vector tests exist precisely to turn any such change into a loud red test rather than a silent production break.

## Scope boundary

This decision covers derivation of the key + id only. Importing the derived key into the **publisher** node's keystore, and the "no client-side record signing" invariant (the client derives keys; the node signs records), are a separate concern recorded by the `key-import-publisher` task and its own ADR.
