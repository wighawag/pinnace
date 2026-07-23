---
title: Import derived key into publisher keystore (no client-side record signing) + ADR
slug: key-import-publisher
spec: pinnace
promptGuidance.testFirst: true
blockedBy: [ipns-key-derivation, kubo-rpc-client]
covers: [11]
---

## What to build

Wire the derived per-site key (from `ipns-key-derivation`) into the PUBLISHER node's keystore: export the derived ed25519 keypair in the libp2p/protobuf format `ipfs key import` expects, then import it via the Kubo RPC `key/import` endpoint into the publisher's keystore only. The node — not the client — performs the actual IPNS record signing (`name/publish`, a separate concern the deploy/publisher tasks own). Deriving a key client-side is NOT client-side record signing; that distinction is the whole "no client signing" invariant and is durable rationale.

Because a future reader will look at client-side key derivation and reasonably wonder "isn't this client-side signing?", record an **ADR in `docs/adr/`** stating explicitly that deriving a key client-side is NOT signing a record: the publisher node still signs/owns sequence numbers via `name/publish`; the client only supplies key MATERIAL. This keeps the "no client signing" invariant (spec Out of Scope C-1) as durable rationale.

Test at the RPC seam (mock Kubo API): assert the derived key is serialized to the import format and lands via `key/import` on the publisher, and that NO record-signing primitive is invoked client-side.

## Acceptance criteria

- [ ] The derived keypair is serialized to the libp2p/protobuf format `ipfs key import` expects, and imported via Kubo `key/import` into the PUBLISHER node's keystore only.
- [ ] No client-side record signing occurs: the client supplies key material; signing is left to the node's `name/publish`. A test asserts no signing primitive runs client-side.
- [ ] Import is targeted at the publisher; replicas receive no key.
- [ ] An ADR under `docs/adr/` records that client-side key derivation is NOT client-side record signing (the "no client signing" invariant, spec Out of Scope C-1) as durable rationale.
- [ ] Test-first: the failing key-import test (against the mock Kubo API) is written before the implementation.
- [ ] Tests cover the new behaviour at the mock RPC seam; no shared/global keystore is touched (the mock, not a real node).

## Blocked by

- Blocked by `ipns-key-derivation` (the derived keypair) and `kubo-rpc-client` (the `key/import` endpoint + mock API).

## Prompt

> Goal: take the derived per-site ed25519 keypair (from `ipns-key-derivation`) and import it into the **publisher** node's keystore via Kubo RPC `key/import`, serializing it into the libp2p/protobuf form `ipfs key import` expects. Read CONTEXT.md (`publisher`, `replica`, `master key`) and spec user story 11 + the "Master-key -> per-site IPNS key" Implementation Decision.
>
> The load-bearing invariant: deriving a key client-side is NOT client-side record signing. The NODE signs the IPNS record (`name/publish`) and owns sequence numbers/validity; the client only supplies key MATERIAL. Spec Out of Scope explicitly excludes client-side record signing (the "C-1" fully-keyless model). Record this as an ADR in `docs/adr/` (format: `work/protocol/ADR-FORMAT.md`) so the "no client signing" invariant has durable rationale — a future reader WILL look at client-side derivation and wonder if it violates the no-signing rule; the ADR pre-empts that.
>
> Scope: ONLY key import into the publisher (replicas get no key). The publish/refresh timers and record export/mirror are the `publisher-replica-model` task; deriving the key is the `ipns-key-derivation` task. Test at the mock Kubo RPC seam (from `kubo-rpc-client`): assert the serialized key lands via `key/import` on the publisher and that no signing primitive is invoked client-side. Test-first. Done means the publisher gets the key, no client signing, ADR written.
