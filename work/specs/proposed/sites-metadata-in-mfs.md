---
title: Sites and per-site metadata live in MFS (node), not pinnace.json; config is infra-only and optional
slug: sites-metadata-in-mfs
taskedAfter: [pinnace]
promptGuidance.testFirst: true
---

> Launch snapshot — records intent at creation, NOT maintained. Current truth: `docs/adr/` + the code; remaining work: the tasks this spec fans out. Builds on the original `pinnace` spec (in `specs/tasked/`), which stays the historical record of the config-first model this supersedes.

## Problem Statement

Today a site's identity AND its per-site metadata live in the CLIENT's `pinnace.json` (`sites: [{id, mode, ensName, sourceDir, ...}]`), while the actual sites live in MFS on the node (`/sites/<id>`) and are the discovery mechanism for the on-box loop (warm/republish/status). This split is the root of a real, recurring problem: the on-box loop can only act on what it can SEE (MFS), but per-site config (e.g. `ensName` for eth.limo warming) lives only in `pinnace.json`, which the box never reads. So a documented lever like `ensName` cannot actually reach the on-box warm loop — there is no channel — and each such "the box needs to know something per-site" need would otherwise invent a new, stale config channel (env-file snapshots at provision, etc.). The config file also duplicates state that MFS already holds (the sites), so it must be kept in sync with reality by hand.

## Solution

Make MFS on the node the SOURCE OF TRUTH for sites and their per-site metadata, and shrink `pinnace.json` to infrastructure only.

- **`pinnace.json` = infra only, and OPTIONAL.** It carries only `hosts` (publisher/replica nodes: endpoint, role, publisherEndpoint). It no longer carries a `sites` array. If the operator passes a publisher endpoint (+ token) on the CLI, no config file is needed at all — the config file is a convenience for multi-node / durable setups, not a requirement.
- **Per-site metadata lives in MFS, next to the site.** A site becomes a WRAPPER directory `/sites/<id>/` containing `content` (the site's UnixFS root CID) and `metadata.json` (the per-site metadata: `ensName`, `mode`, room to grow). The client WRITES this metadata to MFS at deploy/update time — when it legitimately has that information and is doing an operation — exactly as it writes the content.
- **The on-box loop READS metadata from MFS.** Discovery returns each site's `{id, contentCid, metadata}`; `warm` uses `metadata.ensName` (the three-way eth.limo rule), `republish` uses `metadata.mode`, `status` reports it. The box thus gets per-site config through the site's own presence in MFS — no config channel, no env-file staleness, no new network surface. This is consistent with the node-autonomy principle (ADR-0002): the node owns its recurring loop and acts on what it can see; the client places content + the metadata that DEFINES the site (an operation), but never authors the node's self-report (status stays the node's).

The eth.limo `ensName` lever that could not be built before (its own task bounced — see `work/notes/observations/ensname-hint-channel-to-onbox-warm-undecided.md`) becomes implementable here, because `metadata.json` is its natural home and the box reads it from MFS.

## User Stories

1. As an operator, I want `pinnace.json` to describe only my nodes (publisher/replica), not my sites, so that I do not duplicate site state that MFS already holds and must keep in sync by hand.
2. As an operator, I want the config file to be OPTIONAL — a publisher endpoint + token on the CLI is enough to deploy/pin/status against a single node — so that trivial setups need no file.
3. As an operator, I want a site stored in MFS as a wrapper `/sites/<id>/{content, metadata.json}`, so that the site's per-site metadata travels WITH the site on the node.
4. As an operator, I want `deploy`/`update` to write the site's `metadata.json` (its `ensName`, `mode`) into MFS at operation time, so that changing a site's metadata is an update op, not a re-provision or a config-file edit the box never sees.
5. As an operator, I want the on-box loop (warm/republish/status) to READ each site's metadata from MFS, so that per-site behaviour (eth.limo warming, ipns vs ipfs) is driven by what the node can actually see, staying autonomous.
6. As an operator, I want eth.limo warming resolved from `metadata.ensName` with the three-way rule — explicit non-empty warms `<ensName>.limo`; unset + `.eth` id infers `ensName = id`; `ensName: ""` opts out even for a `.eth` id — so that a `.eth`-named site auto-warms eth.limo and I can opt out, and the lever the docs promise actually works.
7. As an operator, I want `site remove <id>` to still cleanly remove a site (MFS entry + unpin) under the new wrapper layout, so that I can delete a site regardless of layout.
8. As an operator migrating from the old flat layout (`/sites/<id>` = the content CID directly), I want to remove the old entries and re-deploy under the new wrapper layout without ceremony, so that the transition is a delete + re-deploy.

## Implementation Decisions

- **MFS layout = wrapper directory (chosen over a parallel meta tree).** `/sites/<id>/content` = the UnixFS root CID (what was at `/sites/<id>` before); `/sites/<id>/metadata.json` = the per-site metadata. Chosen for elegance/co-location (metadata travels with the site as one MFS subtree) over a parallel `/sites-meta/<id>.json`. CONSEQUENCE: what "a site in MFS" means changes — discovery lists `/sites/*` as before, but each entry is now a DIR; the content CID is read from `/sites/<id>/content` (not the entry itself), and gateway/IPNS addressing must target the content CID, not the wrapper. Every content-CID reader (deploy placement, status `files/stat`, warm's `{cid}`, publish's `/ipfs/<cid>`, `site remove`'s unpin, `pin`) must read the CONTENT cid, not the wrapper cid.
- **`metadata.json` shape:** at least `{ ensName?: string, mode: "ipfs" | "ipns" }`, JSON, small, human-readable; written by the client at deploy/update, read by the client (status) and the on-box loop (warm/republish). `ensName: ""` (empty) is DISTINCT from absent (opt-out vs infer) — the read side must preserve that.
- **Config shrink:** remove `sites` from the `pinnace.json` schema; keep `hosts`. Make the config file optional: a CLI publisher endpoint + token (env-only token) yields a usable single-node target with no file. Master + host tokens stay env-only (unchanged).
- **`keyId`/derivation is UNCHANGED and frozen** (ADR-0001): the site `id` is still the KDF input; nothing about IPNS key derivation moves into metadata.
- **The on-box loop reads metadata via Kubo RPC** (`files/read` of `/sites/<id>/metadata.json`) during discovery, so `DiscoveredSite` gains the metadata; no new network surface, no env-file per-site data (provision/cloud-init stay arg-driven, carrying NO site data).

## Testing Decisions

Test at the existing seams: the mock Kubo RPC API for MFS reads/writes (`files/mkdir`/`cp`/`write`/`read`/`ls`/`stat` of the wrapper layout + `metadata.json`), and the warm/status/publish ops reading metadata. Assert: deploy writes `/sites/<id>/{content,metadata.json}`; discovery returns the content cid + parsed metadata; warm resolves the three-way ensName rule (explicit / `.eth`-infer / `""`-opt-out / non-`.eth` no-op); `site remove` removes the wrapper + unpins the CONTENT cid; config is optional (a CLI endpoint yields a target with no file); `ensName: ""` is preserved distinct from absent. No live daemon; env/config isolated.

## Out of Scope

- Automatically MIGRATING existing flat-layout sites in place (rewriting `/sites/<id>` from content-CID to a wrapper dir): out of scope; the transition is delete + re-deploy (story 8). An in-place migration helper could be a later idea.
- Arbitrary/extensible metadata schemas or a metadata versioning scheme: v1 metadata is a small fixed shape (`ensName`, `mode`); growth is expected but not a v1 concern.
- Changing IPNS key derivation, the publisher/replica record machinery, or the dashboard rendering (they consume the new discovery output but their own logic is unchanged here).

## Further Notes

Supersedes the config-first sites model of the original `pinnace` spec (`specs/tasked/`, stories 9/15/19) for the parts about where sites/metadata live; that spec stays the historical record. Directly enables the cancelled `ensname-resolution-and-eth-opt-out` intent. Source: `work/notes/ideas/sites-and-metadata-live-in-mfs-not-config.md`.
