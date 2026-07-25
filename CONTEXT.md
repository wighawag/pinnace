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
- **pin** (the `pinnace pin <cid> --as <name>` verb) — taking custody of an EXTERNAL network CID: content the operator has ONLY the CID for, which Kubo FETCHES over the network (`pin/add`, recursive by default) and pins on EVERY node, then tracks in MFS at `/sites/<name>` so it is warmed, reported and dashboard-visible like any site. Its **mode** defaults to `ipfs` (pin + MFS only, addressed `ipfs://<cid>`); `--mode ipns` ADDS the operator's OWN stable name for that mirrored content (their master-derived key imported onto the publisher, which signs `name/publish` for the pinned CID), so re-pinning a newer CID under the same `--as <name>` moves the name. The content stays someone else's; the NAME is the operator's. It is the third, distinct member of a trio that must not be conflated: **deploy** builds a **CAR** from LOCAL files and imports it (the operator has the bytes, a new CID is minted); **`site add`** places an ALREADY-LOCAL `/ipfs/<cid>` into MFS (no fetch, no pin); **pin** fetches a possibly-remote CID and pins it (the only one that needs a live provider to be serving the content). Removal is NOT a fourth verb: `site remove <name>` already drops the MFS entry and unpins, for deployed and pinned sites alike.
- **IPNS record** — a signed, sequence-numbered, expiring record mapping an IPNS name to a CID. Refreshing validity requires re-signing (the key); re-announcing does not.
- **master key** — one high-entropy secret (operator-held, never on a node) from which every site's IPNS key is deterministically derived. Makes names recoverable and provisioning stateless. Read from env via `ldenv`, never from the config file. (Its class-mate the bearer **token** is treated identically: env-only, never a config-file field.)
- **token** — a node's bearer secret guarding its Kubo RPC API. Same CLASS as the master: env-ONLY by construction, NEVER a `pinnace.json` field. Resolved as `CLI > env(PINNACE_HOST_<NAME>_TOKEN)`; a host with no resolvable token is a LOUD error naming that exact env var (never a silent empty token / downstream 401). There is no `token` field on a host config to leak.
- **id** — a site's SINGLE identifier: ONE value that is BOTH its MFS entry (`/sites/<id>`) AND the frozen KDF input (`HKDF-SHA256(master, info = "pinnace:ipns:v1:" + id)` -> ed25519 seed -> IPNS id, ADR-0001). There is no separate `name` and no separate `keyId` — one `id` is the whole site-identity surface. Immutable once a name is live (changing it moves the derived IPNS id). The frozen derivation (ADR-0001) keeps the internal parameter name `keyId`, but the config/user surface feeds `id` into it.
- **ensName** — an OPTIONAL per-site eth.limo-warming hint, NOT part of identity and NEVER an input to the key derivation. When set, the site is ALSO warmed via `https://<ensName>.limo`. Wiring an id/CID into ENS/DNSLink is the consumer's job, out of scope for pinnace.
- **mode** — `ipfs` (land + pin + MFS only; the address is `ipfs://<cid>`, updated per deploy) or `ipns` (also publish/refresh; the address is `ipns://<id>`, stable). ONE concept with two carriers: per SITE for `deploy` (from `pinnace.json` or `--mode`) and per PIN for `pin --mode` (default `ipfs`). In both, `ipns` means the same thing — the PUBLISHER (never a replica) signs `name/publish` for the content under the master-derived key named by the single `id`.
- **gateway warming** — re-fetching a site's CID through configured public gateways (dweb.link, eth.limo, ...) so their caches stay hot; sites auto-discovered from MFS. A site with an `ensName` is additionally warmed via `https://<ensName>.limo`.
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
