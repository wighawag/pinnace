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
- **Per-site metadata lives in MFS, next to the site.** A site becomes a WRAPPER directory `/sites/<id>/` containing `content` (the site's UnixFS root CID) and `metadata.json` (the per-site metadata: `ensName`, `mode`, room to grow). The client WRITES this metadata to MFS when it deploys a site — when it legitimately has that information and is doing an operation — exactly as it writes the content. ("Update" is NOT a new verb: re-running `deploy` for the same `id` re-writes the content + metadata, which is how a site's metadata is changed. `deploy` is already idempotent — `placeInMfs` does mkdir/rm/cp — so a re-deploy simply replaces the wrapper's `content` and `metadata.json`.)
- **The on-box loop READS metadata from MFS.** Discovery returns each site's `{id, contentCid, metadata}`; `warm` uses `metadata.ensName` (the three-way eth.limo rule), `republish` uses `metadata.mode`, `status` reports it. The box thus gets per-site config through the site's own presence in MFS — no config channel, no env-file staleness, no new network surface. This is consistent with the node-autonomy principle (ADR-0002): the node owns its recurring loop and acts on what it can see; the client places content + the metadata that DEFINES the site (an operation), but never authors the node's self-report (status stays the node's).

The eth.limo `ensName` lever that could not be built before (its own task bounced — see `work/notes/observations/ensname-hint-channel-to-onbox-warm-undecided.md`) becomes implementable here, because `metadata.json` is its natural home and the box reads it from MFS.

## User Stories

1. As an operator, I want `pinnace.json` to describe only my nodes (publisher/replica), not my sites, so that I do not duplicate site state that MFS already holds and must keep in sync by hand.
2. As an operator, I want the config file to be OPTIONAL — a publisher endpoint + token on the CLI is enough to deploy/pin/status against a single node — so that trivial setups need no file.
3. As an operator, I want a site stored in MFS as a wrapper `/sites/<id>/{content, metadata.json}`, so that the site's per-site metadata travels WITH the site on the node.
4. As an operator, I want `deploy` to write the site's `metadata.json` (its `ensName`, `mode`) into MFS when it deploys, so that changing a site's metadata is just a re-`deploy` (idempotent), not a re-provision or a config-file edit the box never sees. (There is no separate `update` verb; re-running `deploy` for the same `id` IS the update.)
5. As an operator, I want the on-box loop (warm/republish/status) to READ each site's metadata from MFS, so that per-site behaviour (eth.limo warming, ipns vs ipfs) is driven by what the node can actually see, staying autonomous.
6. As an operator, I want eth.limo warming resolved from `metadata.ensName` with the three-way rule — explicit non-empty warms `<ensName>.limo`; unset + `.eth` id infers `ensName = id`; `ensName: ""` opts out even for a `.eth` id — so that a `.eth`-named site auto-warms eth.limo and I can opt out, and the lever the docs promise actually works.
7. As an operator, I want `site remove <id>` to still cleanly remove a site (MFS entry + unpin) under the new wrapper layout, so that I can delete a site regardless of layout.
8. ~~As an operator migrating from the old flat layout (`/sites/<id>` = the content CID directly), I want to remove the old entries and re-deploy under the new wrapper layout without ceremony, so that the transition is a delete + re-deploy.~~ **DROPPED (2026-07-26, human decision).** There is no installed base to migrate: pinnace has no users on the flat layout, so the story protects nobody. Deliberately accepted consequences, should a flat-layout site exist anywhere: a re-`deploy` over one SUCCEEDS but leaves the old content tree as garbage inside the new wrapper, and `site remove` cannot resolve its content cid so it drops the MFS entry while reporting `unpinned: false` and leaking the pin. Neither is worth code. If an installed base ever appears, this becomes a fresh spec, not a revival of this story.

## Implementation Decisions

- **MFS layout = wrapper directory (chosen over a parallel meta tree).** `/sites/<id>/content` = the UnixFS root CID (what was at `/sites/<id>` before); `/sites/<id>/metadata.json` = the per-site metadata. Chosen for elegance/co-location (metadata travels with the site as one MFS subtree) over a parallel `/sites-meta/<id>.json`. CONSEQUENCE: what "a site in MFS" means changes — discovery lists `/sites/*` as before, but each entry is now a DIR; the content CID is read from `/sites/<id>/content` (not the entry itself), and gateway/IPNS addressing must target the content CID, not the wrapper. Every content-CID reader/writer must target `/sites/<id>/content`, not the wrapper: **deploy** placement (`placeInMfs` -> write `/sites/<id>/content` + `/sites/<id>/metadata.json`); **status** `files/stat`; **warm**'s `{cid}`; **publish**'s `/ipfs/<cid>`; **`site remove`**'s unpin (`statCid` must read `/sites/<id>/content` before `files/rm /sites/<id>`); and **BOTH** `pin` entry points — `pin <cid>` AND `pin --from-ipns` (they both call `placeInMfs` at `/sites/<name>` in `pin-external.ts`, and must move to the wrapper + write metadata like deploy). The content-CID-reader sweep task must enumerate ALL of these (do not miss pin's two paths).
- **CONTEXT.md glossary must be re-pinned** (the wrapper layout re-means an existing glossary term): today `id` is defined as "BOTH its MFS entry `/sites/<id>` AND the KDF input" and `gateway warming`/`pin` describe `/sites/<name>` as the content entry. After the reshape, `/sites/<id>` is a wrapper dir (`content` + `metadata.json`). A task must update the `id`, `pin`, `mode`, `ensName`, and `gateway warming` glossary entries so `/sites/<id>` reads as the wrapper and `ensName`/`mode` are documented as MFS metadata (not config), so the next author cannot re-fork the term.
- **`metadata.json` shape:** at least `{ ensName?: string, mode: "ipfs" | "ipns" }`, JSON, small, human-readable; written by the client on `deploy`, read by the client (status) and the on-box loop (warm/republish). `ensName: ""` (empty) is DISTINCT from absent (opt-out vs infer) — the read side must preserve that.
- **NEW client RPC surface required: `filesWrite` + `filesRead`.** Writing/reading `metadata.json` needs Kubo's `files/write` and `files/read`, which `KuboRpcClient` does NOT wrap today (it has `filesMkdir`/`filesRm`/`filesCp`/`filesLs`/`filesStat` only). A task MUST add `filesWrite(path, bytes)` and `filesRead(path)` to the client (same pattern + bearer + loud-error as the existing files/* methods; Kubo exposes both endpoints). Do not assume they exist.
- **Config shrink is NOT purely additive — it changes three live consumers of `cfg.sites`, which must be reworked, not just deleted:**
  1. `deploy` currently resolves a site's `mode` from the matching config entry when `--mode` is absent (`cfg.sites.find(s => s.id === siteId)?.mode`). With `sites` gone, deploy's mode comes from `--mode` (and, going forward, is persisted into / read from the MFS `metadata.json`); the config-based mode fallback is REMOVED. State the new mode-source order explicitly (arg > metadata; no config entry).
  2. `derive` and `promote` currently normalise the id via `cfg.sites.find(s => s.id === siteId)?.id ?? siteId`. With `sites` gone this becomes just `siteId` (the arg) — a compile-forcing change (those `.find` calls must be removed), harmless in effect (the `?? siteId` already covered the no-match case).
  So the config-shrink task must: remove `SiteConfig`/`sites` from the schema, AND update those three call sites, AND re-state deploy's mode resolution. Master + host tokens stay env-only (unchanged).
- **Config optional:** a CLI publisher endpoint + token (env-only token) yields a usable single-node target with NO config file. The config file is a convenience for multi-node / durable setups, not required.
- **`keyId`/derivation is UNCHANGED and frozen** (ADR-0001): the site `id` is still the KDF input; nothing about IPNS key derivation moves into metadata.
- **The on-box loop reads metadata via Kubo RPC** (`files/read` of `/sites/<id>/metadata.json`, using the new `filesRead` above) during discovery, so `DiscoveredSite` gains the metadata; no new NETWORK surface (it is the same bearer-guarded Kubo RPC), no env-file per-site data (provision/cloud-init stay arg-driven, carrying NO site data).

## Testing Decisions

Test at the existing seams: the mock Kubo RPC API for MFS reads/writes (`files/mkdir`/`cp`/`write`/`read`/`ls`/`stat` of the wrapper layout + `metadata.json`), and the warm/status/publish ops reading metadata. Assert: deploy writes `/sites/<id>/{content,metadata.json}`; discovery returns the content cid + parsed metadata; warm resolves the three-way ensName rule (explicit / `.eth`-infer / `""`-opt-out / non-`.eth` no-op); `site remove` removes the wrapper + unpins the CONTENT cid; config is optional (a CLI endpoint yields a target with no file); `ensName: ""` is preserved distinct from absent. No live daemon; env/config isolated.

## Out of Scope

- ANY handling of existing flat-layout sites, in place or otherwise: out of scope, and story 8 (the delete + re-deploy transition) is now DROPPED outright rather than merely unautomated — there is no installed base, so no migration path is built, documented or tested. See story 8 for the accepted consequences.
- Arbitrary/extensible metadata schemas or a metadata versioning scheme: v1 metadata is a small fixed shape (`ensName`, `mode`); growth is expected but not a v1 concern.
- Changing IPNS key derivation, the publisher/replica record machinery, or the dashboard rendering (they consume the new discovery output but their own logic is unchanged here).

## Further Notes

Supersedes the config-first sites model of the original `pinnace` spec (`specs/tasked/`, stories 9/15/19) for the parts about where sites/metadata live; that spec stays the historical record. Directly enables the cancelled `ensname-resolution-and-eth-opt-out` intent. Source: `work/notes/ideas/sites-and-metadata-live-in-mfs-not-config.md`.
