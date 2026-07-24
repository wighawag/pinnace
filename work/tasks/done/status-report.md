---
title: Status — per-site CID, IPNS id, announce check, gateway-serves check
slug: status-report
spec: pinnace
promptGuidance.testFirst: true
blockedBy: [kubo-rpc-client, config-resolution]
covers: [18]
---

## What to build

The `status` operation in the core: for every site (auto-discovered from MFS `/sites/*` via the Kubo RPC seam), report the current CID (`files/stat`), the IPNS id (from `key/list` if a key of that name exists), whether the NETWORK announces this node for that CID (an external delegated-routing providers check — the node's PeerID appears in the providers list), and whether a cold public gateway serves it (an HTTP HEAD/range check). This lets an operator verify a deploy actually landed everywhere.

The two external checks (delegated-routing providers lookup, public-gateway fetch) reach outside; make them injectable so tests use a fake HTTP layer rather than the live network. Port the check shapes from the reference `status.sh` (the `delegated-ipfs.dev/routing/v1/providers/<cid>` provider lookup and the `dweb.link` range-request gateway probe), into the TS core over the Kubo RPC seam.

## Acceptance criteria

- [ ] `status` discovers sites from MFS `/sites/*` and reports, per site: current CID, IPNS id (if a same-named key exists), network-announce (delegated-routing providers contains this node's PeerID), and gateway-serves (cold public gateway HTTP result).
- [ ] The delegated-routing and gateway probes are injectable so tests run against a fake HTTP layer, not the live network.
- [ ] Tested against the mock Kubo API (for `files/ls`/`files/stat`/`key/list`/`id`) + a fake external-HTTP layer (for the two checks).
- [ ] Test-first: the failing status-shape tests are written before the implementation.
- [ ] Tests cover the new behaviour and hit no live network / no shared location (mock + fakes only).

## Blocked by

- Blocked by `kubo-rpc-client` (MFS/key/id endpoints + mock API) and `config-resolution` (which nodes/sites).

## Prompt

> Goal: build pinnace's **`status`** (spec user story 18). For each site (auto-discovered from MFS `/sites/*` via the `kubo-rpc-client`), report: current CID (`files/stat --hash`), IPNS id (from `key/list -l` if a key of that name exists), whether the NETWORK announces this node for the CID (external delegated-routing providers lookup contains this node's PeerID from `id`), and whether a cold public gateway serves it (HTTP range/HEAD probe). CONTEXT.md: this is the `gateway warming` / discoverability verification surface.
>
> Reference prototype: `~/searches/ipfs-hetzner/status.sh` — PORT the two external check shapes into TS: the providers lookup at `https://delegated-ipfs.dev/routing/v1/providers/<cid>` (does `.Providers[].ID` include our PeerID?) and the `https://<cid>.ipfs.dweb.link/` range-request gateway probe. Do NOT copy verbatim.
>
> Make the two external HTTP checks INJECTABLE so tests use a fake HTTP layer, never the live network. Test the MFS/key parts against the mock Kubo API from `kubo-rpc-client`. Test-first (repo policy on): write the failing per-site status-shape assertions before implementing. Done means a status report with the four fields per site, fully tested against mock + fakes with no live-network dependency.
