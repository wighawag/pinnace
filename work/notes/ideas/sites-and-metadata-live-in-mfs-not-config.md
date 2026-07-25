---
title: Sites + per-site metadata live in MFS (the node), not pinnace.json — config is infra-only and optional
date: 2026-07-25
---

## The proposal (operator, 2026-07-25)

Move the SOURCE OF TRUTH for sites and their per-site metadata OUT of the
client's `pinnace.json` and INTO MFS on the node — where sites ALREADY live and
are ALREADY the discovery mechanism. `pinnace.json` shrinks to INFRASTRUCTURE
only (publisher + replica nodes), and becomes OPTIONAL: if a publisher endpoint
(+ token) is given on the CLI, no config file is needed at all.

Owner words: "pinnace.json should not have site info, it should only be about
publisher and replica and if given a publisher endpoint on cli, the config file
should be optional. Right now we already store sites on MFS, no need to be in
pinnace.json, same for ens: it is specified on deploy/update time and then stored
on MFS like the site, maybe with a metadata.json."

## Why this is the right shape (it dissolves a whole class of problem)

It resolves the `ensName`-to-on-box-warm channel problem
(`work/notes/observations/ensname-hint-channel-to-onbox-warm-undecided.md`) AND
every future "the on-box loop needs to know something per-site" problem, by the
principle the operator already established twice (status-refresh + ensName):

- The NODE owns what it does continuously (warm/republish/status); it must act on
  what IT can see. MFS is what it can see. So per-site metadata (ensName, mode, …)
  belongs in MFS, read by the on-box loop from there — NOT pushed through a config
  channel (env file / a client-only pinnace.json the box never reads).
- The CLIENT legitimately writes to MFS when DOING AN OPERATION (deploy/update
  place the site; they can also write its metadata). That is "doing an
  operation", not "secretly driving the box with client config". The earlier
  rejected idea (client AUTHORS the node's status into MFS) is different and still
  rejected — the node authors its SELF-REPORT; the client places CONTENT + the
  metadata that DEFINES the site it is deploying.

So: metadata reaches the box THROUGH the site's own presence in MFS. No config
channel, no env-file staleness, no new network surface.

## The shape (to be pinned during spec reconcile)

- **`pinnace.json` = infra only:** `hosts` (publisher/replica: endpoint, role,
  publisherEndpoint). DROP the `sites` array. Master + tokens stay env-only.
- **Config optional:** a CLI publisher endpoint + token is enough to operate
  (deploy/pin/status against that node) with NO config file. Config file is for
  convenience / multi-node, not required.
- **Per-site metadata in MFS.** Today `/sites/<id>` IS the site's content CID
  (a UnixFS dir), so there is no room for a sibling file as-is. Two candidate
  layouts (decide in the reconcile):
  - (i) `/sites/<id>` becomes a WRAPPER dir: `/sites/<id>/content` (the CID) +
    `/sites/<id>/metadata.json`. Changes what "a site in MFS" is; every verb's
    discovery reads content + metadata.
  - (ii) a PARALLEL meta tree: `/sites-meta/<id>.json` beside `/sites/<id>`.
    Less invasive to the content path; discovery reads both trees.
  metadata.json holds: `ensName` (the eth.limo warming hint, with the three-way
  explicit / `.eth`-inference / `""`-opt-out rule the cancelled task wanted —
  now IMPLEMENTABLE because the box reads it from MFS), `mode` (ipfs|ipns), and
  room to grow. `keyId`/derivation stays master+id (unchanged, frozen).
- **deploy / update WRITE the metadata** to MFS alongside placing the site (the
  client has ensName/mode at operation time). Changing ensName later = an update
  op, not a re-provision.
- **The on-box loop READS metadata from MFS:** `discoverSites` returns
  `{id, cid, meta}`; `warm` uses `meta.ensName` (resolving the three-way rule),
  `republish` uses `meta.mode`, `status` reports it. `provision`/cloud-init carry
  NO per-site data (stays arg-driven — the exact property option (a) in the
  ensName note violated).

## What it supersedes / touches

- SUPERSEDES the cancelled `ensname-resolution-and-eth-opt-out` premise (the
  ensName lever becomes implementable via MFS metadata, its natural home).
- RESHAPES `config-resolution` (drop `sites` from the schema; config optional) —
  a change to a shipped, tasked surface.
- Spec `work/specs/tasked/pinnace.md` stories 9, 15, 19 + the sites-in-config
  model must be reconciled (story 19 "durable config in pinnace.json" and the
  sites array; story 15's MFS-discovery already aligns). Per the work contract
  this is a SPEC-level reshape: reopen `specs/tasked/ -> specs/ready/`, reconcile,
  re-task (do NOT hand-write the implementation tasks first).

## Why this is an IDEA (spec-level), not a task

It moves the source of truth for a core concept (sites) from config to MFS,
makes config optional, changes the MFS site layout, and contradicts a tasked
user story (19) + the sites-in-config model. That is a spec reconcile +
re-decomposition, not a single task. Promote by reopening the `pinnace` spec,
reconciling stories 9/15/19 to this MFS-first model, then re-tasking the slices
(config-schema-shrink + optional-config; MFS metadata layout + read/write;
deploy/update writes metadata; on-box loop reads it; the ensName three-way rule
on top).
