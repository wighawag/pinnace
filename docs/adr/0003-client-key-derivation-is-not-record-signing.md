# Client-side key derivation is NOT client-side record signing (the "no client signing" invariant)

**Status:** accepted

pinnace derives every `ipns`-mode site's ed25519 key CLIENT-SIDE (from the operator master, ADR-0001) and imports it into the publisher node's keystore via Kubo `key/import`. A future reader will look at that flow and reasonably ask: *isn't holding + serializing the private key client-side already client-side signing? Doesn't this cross the line the spec's "Out of Scope" C-1 (fully-keyless boxes, client signs records) deliberately drew?* It does NOT, and this ADR records why, so nobody "notices" client-side derivation and either (a) assumes we already do client signing and builds on that false premise, or (b) tries to "finish the job" by moving record signing into the CLI.

## The decision

Deriving/serializing a key client-side supplies key **MATERIAL** to the node; it is NOT signing an IPNS **record**. The split is load-bearing:

- **The CLIENT only ever produces key material.** `deriveIpnsKey` (ADR-0001) turns `(master, keyId)` into the ed25519 seed + public key with no node and no network. `serializeIpnsKeyForImport` reshapes those bytes into the `libp2p-protobuf-cleartext` `PrivateKey` form and `importIpnsKeyIntoPublisher` POSTs them to the publisher's `key/import`. No signing primitive runs client-side; the ONLY RPC issued by the import path is `key/import`.
- **The NODE signs and owns the record.** Once the key is in the publisher's keystore, the node performs the actual IPNS record signing via `name/publish` (owned by the on-box `republish` verb, ADR-0002) and owns the record's **sequence numbers** and **validity/lifetime**. The client never mints, sequences, signs, or refreshes a record.

So "no client-side record signing" holds even though key derivation is client-side: the client hands over material, the node is the sole record signer and sequence-number writer.

## Publisher-only

The key lands on exactly ONE node per shared IPNS name (the **publisher**). Replicas are **keyless** and only re-announce the publisher's signed record (`routing/put`), never signing. `importIpnsKeyIntoPublisher` therefore REFUSES (`KeyImportRoleError`) to import onto a `replica` rather than silently proceeding: putting a signing key on a box that must never hold one is a caller error, not a no-op. (This refusal is a new loud ERROR gated on the existing `HostRole` concept; it does not invent a role.)

## Why the C-1 fully-keyless model is out of scope (the trade-off)

The alternative considered and rejected for v1 is C-1: the boxes hold no key at all and the CLI signs each IPNS record client-side, owning sequence numbers and validity itself. That is a genuinely different capability (client owns the signing loop, races, and sequence state across deploys) and a larger, riskier surface. v1 deliberately keeps the node as the single record signer/sequencer (one publisher, ADR-0002's boundary) and the client as a material supplier only. If C-1 is ever revisited it enters as a NEW idea under `work/notes/ideas/`, not as a quiet extension of this import path.

## Consequences

- The seam is testable without a live daemon: the `key-import-publisher` tests assert (against the mock Kubo RPC) that the serialized key lands via `key/import` on the publisher, that a replica import is refused with no RPC issued, and that the import path issues ONLY `key/import` (no `name/publish`/`routing/put`, i.e. nothing that signs or re-announces) and reaches for no signing primitive in source.
- Anyone extending deploy/publish must preserve this split: client derives + imports MATERIAL; the node signs the record. Moving record signing client-side is a scope change (C-1), not a refactor.
