# CONTEXT — pinnace domain language

The domain glossary for `pinnace`. Agents and skills use THIS vocabulary when naming modules, tests, and discussing the system. Architectural rationale lives in `docs/adr/` (decisions); product framing lives in `work/specs/`.

## What pinnace is

`pinnace` is a TypeScript CLI and library for self-hosting a static website on IPFS across one or more self-owned Kubo nodes (Hetzner first, other hosts behind a provider seam). It provisions nodes via generated cloud-init, deploys sites as content-addressed archives (CAR) pinned on every node with the same CID, manages per-site `ipfs://` (immutable, updated per deploy) or `ipns://` (mutable, stable name) publishing via a master-key-derived per-site IPNS key, keeps public-gateway caches warm, installs CI (GitHub Actions first, behind a provider seam), and reports discoverability/health, all without relying on paid pinning services.

## Core domain terms

- **node** (a.k.a. box) — a self-owned server running the Kubo IPFS daemon that pins content and is dialable/discoverable on the IPFS network. Reached only via its Kubo RPC API (`POST /api/v0/...`, bearer-token guarded).
- **publisher** — the one node per shared IPNS name that holds the IPNS key and signs/refreshes (`name/publish`) the IPNS record. It exports the raw signed record for replicas to mirror.
- **replica** — a keyless node that pins the same CID and re-announces (`routing/put`) the publisher's signed record it fetched from the publisher endpoint (falling back to its last cached record). It never signs.
- **CAR** — Content Addressable aRchive; the DAG of a site built client-side (via the `ipfs-car` library) and imported into nodes with `dag/import`. The default and primary deploy artifact.
- **CID** — the content identifier (root of the site's UnixFS directory). Identical across all nodes for a given deploy.
- **IPNS record** — a signed, sequence-numbered, expiring record mapping an IPNS name to a CID. Refreshing validity requires re-signing (the key); re-announcing does not.
- **master key** — one high-entropy secret (operator-held, never on a node) from which every site's IPNS key is deterministically derived. Makes names recoverable and provisioning stateless. Read from env via `ldenv`, never from the config file.
- **keyId** — a site's frozen, internal key identity: the KDF input (`HKDF-SHA256(master, info = "pinnace:ipns:v1:" + keyId)` -> ed25519 seed -> IPNS id). Immutable once a name is live; NOT the ENS name.
- **ENS name** — the (mutable) `<name>.eth` a site publishes under, deliberately UNTIED from `keyId` so it can change without shifting the IPNS id.
- **mode** — per-site `ipfs` (land + pin + MFS only; ENS uses `ipfs://<cid>`) or `ipns` (also publish/refresh; ENS uses `ipns://<id>` once).
- **gateway warming** — re-fetching a site's CID through configured public gateways (dweb.link, eth.limo, ...) so their caches stay hot; sites auto-discovered from MFS.
- **host provider seam** — the interface behind which host-specific provisioning (cloud-init, firewall, server creation) lives; Hetzner is the first implementation. Deploy/publish are host-agnostic (they speak only Kubo RPC).
- **CI provider seam** — the interface behind which CI-system emitters live (GitHub Actions first); each writes a deploy pipeline + lists the required secrets/vars.
- **core vs cli** — the library core owns all logic (build CAR, deploy, derive keys, generate cloud-init, emit CI); the CLI is a thin wrapper so the same operations are usable as a TypeScript API.
- **config resolution** — every setting resolves as CLI arg > env (`ldenv`) > `pinnace.json` config file.
- **promptGuidance** — the per-repo NUDGE namespace in `dorfl.json` whose members (currently just `testFirst`) strengthen the wording in the worker's in-band prompt. NOT a gate: the `verify` step is still the only acceptance bar. Omitted ⇒ off; absence is the default.
- **work/ contract** — the on-disk system this repo uses, defined by the reference docs in **`work/protocol/`** (copied here by `setup`): `WORK-CONTRACT.md` (the contract), `CLAIM-PROTOCOL.md`, `REVIEW-PROTOCOL.md`, `TASKING-PROTOCOL.md`, `SURFACE-PROTOCOL.md`, `task-template.md`, `spec-template.md`, `ADR-FORMAT.md`. Three REGIME umbrellas — `notes/` (capture buckets), `tasks/` (the build board), `specs/` (the spec lifecycle) — plus top-level `questions/` and `protocol/`. One markdown file per item, status = the folder it lives in (never a field). Capture buckets: `notes/ideas/` (proposed), `notes/observations/` (spotted, unverified, append-only), `notes/findings/` (verified external/domain ground truth, each with a `source:`). ADRs (`docs/adr/`, format in `work/protocol/ADR-FORMAT.md`) record what WE decided and why.

## Conventions

Standing per-change rules agents must follow in this repo.

Every change requires a changeset (`pnpm changeset`). For enforcement, wire a check (e.g. `changeset status --since=main`) into the `dorfl.json` `verify` gate.

## Skills this repo uses

- Required: `setup` (onboarding/migration), `to-spec`, `to-task`.
- Recommended: `review`, `grill-me`.
