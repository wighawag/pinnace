---
title: pinnace — self-hosted IPFS website CLI + library
slug: pinnace
promptGuidance.testFirst: true
---

> Launch snapshot — records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks. (The technical-detail sections below are trimmed by `to-task` once the work is tasked — they move into tasks/ADRs and this spec settles to its durable framing: Problem / Solution / User Stories / Out of Scope.)

## Problem Statement

I want to host a static website on IPFS and be confident it stays pinned and reachable, without depending on a paid pinning service. The hosted options keep degrading or disappearing (Pinata soured on price/quality; Storacha sunset its IPFS upload service; Eternum shut down; Filebase's free tier excludes websites). Running my own Kubo node on a cheap box (Hetzner) is reliable and accessible if configured right, but the setup is fiddly: the node must be dialable and, crucially, *discoverable* (fresh provider records so public gateways like dweb.link and eth.limo can find it); uploads want a token-guarded API; gateway caches want warming; and for a mutable name (IPNS) the record must be signed and refreshed without races or losing the name if a box dies. Doing this by hand across one or more boxes, plus wiring CI to deploy on push, is exactly the repetitive, error-prone work a tool should own.

## Solution

`pinnace` is a TypeScript **library core** with a thin **CLI** wrapper (same operations usable as a TS API) that owns the whole lifecycle of self-hosting a static site on IPFS across one or more self-owned Kubo nodes:

- **Provision** nodes by generating cloud-init (Hetzner first, other hosts behind a seam): installs Kubo hardened, opens swarm port 4001 (TCP+UDP), keeps discoverability fresh (AcceleratedDHTClient + reprovide + delegated routing/IPNI), exposes the Kubo RPC API only via HTTPS + bearer token, warms gateway caches, and (for IPNS sites) runs the publisher/replica record machinery.
- **Deploy** a built site directory by building a CAR client-side (the `ipfs-car` library, the tested default and primary path), importing it into every configured node (`dag/import`, pinned) so all nodes serve the **same CID**, placing it in MFS so warming/IPNS auto-discover it.
- **Per-site mode:** `ipfs` (immutable; ENS contenthash = `ipfs://<cid>`, updated per deploy) or `ipns` (mutable; ENS contenthash = `ipns://<id>` set once). IPNS keys are **derived from one master secret** (per-site, deterministic), so names are recoverable and provisioning is stateless. The master never touches a node; one **publisher** node signs/refreshes the record, **keyless replica** nodes mirror the signed record.
- **Install CI** (GitHub Actions first, other systems behind a seam): writes a deploy pipeline and reports the secrets/vars to set.
- **Status:** report per-site CID, IPNS id, whether the network announces the node (external delegated-routing check), and whether public gateways serve it.

The result: own your website's availability on cheap self-owned infrastructure, no paid pinning service, no vendor lock-in, one command to deploy.

## User Stories

1. As an operator, I want to run `pinnace provision --host hetzner ...` and get a ready-to-paste cloud-init, so that I can create a working IPFS node without hand-editing YAML.
2. As an operator, I want the generated node to keep its provider records fresh (AcceleratedDHTClient + reprovide + delegated routing), so that public gateways can discover and fetch my content.
3. As an operator, I want the node's swarm port 4001 open (TCP+UDP) and the RPC API bound to localhost behind HTTPS + a bearer token, so that the node is dialable but the admin API is never exposed raw.
4. As an operator, I want `pinnace deploy ./dist <site>` to build a CAR locally and import it into every configured node, so that all nodes serve the identical CID with no single point of failure.
5. As an operator, I want the CAR built via the `ipfs-car` library in-process (no external CLI, no output scraping), so that the root CID is authoritative and the build is reproducible.
6. As an operator, I want a deploy to preserve the site's directory structure (index.html + assets at correct paths), so that the site renders correctly through any gateway.
7. As an operator, I want to choose per site between `ipfs` mode (immutable, ENS `ipfs://<cid>` per deploy) and `ipns` mode (mutable, ENS `ipns://<id>` once), so that each site uses the addressing that fits it.
8. As an operator, I want each `ipns` site's key derived deterministically from one master secret via a frozen KDF, so that I can lose every box and still recover the name from the master.
9. As an operator, I want a site's key identity (`keyId`) to be internal and frozen, decoupled from its ENS name, so that I can point any `<other-name>.eth` at it or change the ENS name without shifting the IPNS id.
10. As an operator, I want the master secret to live only in my environment (read via `ldenv`) and never be written to a node or the config file, so that a compromised node cannot hijack any name.
11. As an operator, I want deploy to derive the per-site key and import it into the publisher node's keystore, while the node performs the actual IPNS record signing, so that no client-side record signing is introduced.
12. As an operator, I want exactly one publisher node per shared IPNS name (others keyless replicas), so that there is a single sequence-number writer and no IPNS flap during deploys.
13. As an operator, I want the publisher to export its signed IPNS record and replicas to fetch and re-announce it (`routing/put`), falling back to the last cached record if the publisher is unreachable, so that the name stays reachable with a grace window if the publisher dies.
14. As an operator, I want to promote a replica to publisher (import the key, flip role) within the record's validity window, so that I can recover the name without downtime of the content.
15. As an operator, I want the node to warm a configurable set of public gateways (dweb.link, eth.limo for `.eth` names, ...) for every site discovered in MFS, so that first-load latency stays low without maintaining a CID list.
16. As an operator, I want `pinnace install-ci --system github ...` to write a deploy workflow and print the required repo secrets/vars, so that pushes auto-deploy.
17. As an operator, I want the CI workflow to support multiple target nodes and per-site mode, so that CI deploys the same CID to all nodes and publishes only where appropriate.
18. As an operator, I want `pinnace status` to show, per site, the CID, IPNS id, whether the network announces my node for that CID, and whether a cold public gateway serves it, so that I can verify a deploy actually landed everywhere.
19. As an operator, I want every setting resolvable as CLI arg > env (`ldenv`) > `pinnace.json`, so that I can override anything at the command line while keeping durable config in a file.
20. As a developer, I want all logic in a library core that the CLI merely calls, so that I can drive provision/deploy/status/derive from my own TypeScript instead of shelling out.
21. As an operator, I want to add a new host or CI system later without touching deploy/publish logic, so that Hetzner/GitHub are just the first implementations behind a provider seam.
22. As an operator, I want a way to derive and print a site's IPNS id from the master + keyId without deploying, so that I can set the ENS contenthash before the first deploy.

### Autonomy notes (the two gate axes)

- **`humanOnly`:** omitted. The spec is straightforwardly agent-taskable; no human is required to drive the tasking. (Individual tasks touching secret handling / key derivation may be gated by the tasker on their own build-nature, which is disjoint from this spec flag.)
- **`needsAnswers`:** omitted. The design was fully resolved in the originating conversation (host = Hetzner first behind a seam; CAR default and only primary path; per-site `ipfs|ipns`; master-key derivation with frozen KDF; `keyId` decoupled from ENS name; no client signing; config precedence arg > env(`ldenv`) > `pinnace.json`; v1 commands = provision, deploy, install-ci, status).

## Out of Scope

- **Client-side IPNS record signing (the fully-keyless-boxes "C-1" model).** Deliberately excluded: pinnace derives keys client-side but the publisher node signs records. Signing records in the CLI (and owning sequence numbers/validity client-side) is a separate future capability, not v1. If revisited, it lives as a new idea in `work/notes/ideas/`.
- **Streaming CAR for very large sites.** The in-process build buffers blocks (fine for normal static sites). Streaming is a later optimization, not v1.
- **Hosts other than Hetzner and CI systems other than GitHub Actions in v1.** The seams exist so they can be added later; only Hetzner + GitHub are implemented first.
- **A hosted/paid pinning-service integration.** Intentionally avoided — the whole point is self-hosting without a paid service. (An optional external mirror pin was discussed but excluded as it reintroduces a paid dependency.)
- **Running the actual `routing/get`/`routing/put` failover against a live daemon** was not possible in the design conversation; a live end-to-end verification of the publisher-export / replica-mirror path is a build-time acceptance step, not a design assumption.

## Where the detail went

This spec has been tasked. Its Implementation/Testing detail now lives in the emitted tasks under `work/tasks/` (the `pinnace`-spec tasks), and the durable rationale that outlives them lives in `docs/adr/` (notably: the frozen master-key -> IPNS KDF; that client-side key derivation is NOT client-side record signing; and the boundary that Kubo owns pinning + reprovide while the same `pinnace` binary runs the recurring on-box loop via systemd timers). The reference prototype artifacts (`deploy-car.mjs`, `cloud-init.yaml` + `make-cloud-init.sh`, `status.sh`, the GitHub Action) live in a scratch workspace (`~/searches/ipfs-hetzner/`) and are behavioural references to PORT, not copy — the shell `sed` templating and CLI-scraping approaches were superseded (programmatic YAML; the `ipfs-car` + `files-from-path` libraries). Corrections the build honours (captured in the relevant tasks): an IPNS key maps 1:1 to one name; `keyId` is decoupled from the ENS name; the CAR root is the last encoder block (never scraped); `filesFromPaths(["dist"])` already yields site-relative paths (do not strip a segment).
