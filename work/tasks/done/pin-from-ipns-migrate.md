---
title: Migrate from an existing IPNS name — pinnace pin --from-ipns <name> (resolve then pin)
slug: pin-from-ipns-migrate
spec: pinnace
blockedBy: []
covers: [8, 12, 15]
---

## What to build

Let `pinnace pin` take an existing IPNS NAME as its source, so an operator can migrate a site published under someone else's (or an old) IPNS name onto their OWN infrastructure + their OWN IPNS name, WITHOUT resolving the source by hand first. pinnace resolves the source IPNS name to its CURRENT CID, pins that CID redundantly on all nodes, and (with `--mode ipns`) publishes it under the operator's OWN derived key — giving `ipns://<their-id>` to point ENS at.

The concrete workflow this enables (e.g. `ronan.eth` currently -> some source IPNS):

```
pinnace pin --from-ipns <source-ipns-name> --as ronan --mode ipns
#  -> resolves <source-ipns-name> to its current /ipfs/<cid>
#  -> pins that CID on every node (redundant)
#  -> publishes it under the operator's own key -> ipns://<their-id>
#  then: set ENS contenthash -> ipns://<their-id>  (operator now controls the pointer)
```

Build:
- Add `KuboRpcClient.nameResolve(name)` -> `name/resolve?arg=/ipns/<name>` (accept a bare id or an `/ipns/<id>` path; normalise). Kubo resolves via the DHT and returns the current `/ipfs/<cid>`; parse out the CID. It BLOCKS while resolving; pass through Kubo's error if the name does not resolve (do not hang beyond Kubo's own behaviour; a `--dht-timeout` passthrough is optional if trivial).
- Extend the `pin` verb with a source selector: `pin --from-ipns <name> --as <name> [--mode ipfs|ipns] [--host <name>]` resolves the source IPNS -> CID (on one reachable node, e.g. the first target / the publisher) and then runs the EXISTING pin flow with that CID. `pin <cid> ...` (the current positional-CID form) is unchanged. Exactly ONE source must be given: a positional `<cid>` XOR `--from-ipns <name>` (error if both or neither).
- Everything downstream is the ALREADY-BUILT pin flow: redundant `pin/add` across nodes + `placeInMfs(/sites/<as-name>)`, and `--mode ipns` derives+imports the operator's key and `name/publish`es the resolved CID (publisher only) — all reused, no new publish/pin logic.
- Report the resolved CID (so the operator sees WHAT was pinned) and, in ipns mode, the operator's resulting `ipns://<id>`.

Coherence (CONTEXT.md): the SOURCE ipns name (what you migrate FROM) is distinct from the operator's OWN published name (what `--mode ipns` mints, derived from master + the `--as` id). Name them so they are not confused: `--from-ipns` is the source to resolve; `--as <name>` is the operator's site id (and, in ipns mode, the key id for their own name). Migrating does NOT give the operator the source's key — it gives them their own name pointing at a snapshot of the source's current content. Re-running `pin --from-ipns ... --mode ipns` re-resolves + re-publishes, so the operator can pull a newer snapshot on demand (this is a manual re-migrate, NOT an automatic follow-of the source — state that clearly; auto-follow is a separate, larger feature).

## Acceptance criteria

- [ ] `KuboRpcClient.nameResolve(name)` issues `name/resolve?arg=/ipns/<name>` (bare id or /ipns/ path normalised), sends the bearer token, parses the returned `/ipfs/<cid>`, and raises the loud `KuboRpcError` on non-2xx.
- [ ] `pin --from-ipns <name> --as <name> [--mode ...] [--host ...]` resolves the source IPNS to its current CID (on a reachable target) and then runs the existing pin flow with that CID; the resolved CID is reported.
- [ ] Exactly one source is required: positional `<cid>` XOR `--from-ipns <name>`; giving both or neither fails loud with usage.
- [ ] `--mode ipns` publishes the RESOLVED CID under the operator's own derived key (reusing the pin ipns-mode path); prints `ipns://<their-id>`. `--mode ipfs` pins + MFS only.
- [ ] A name that does not resolve produces a clear error (passed through from Kubo), not a silent success or an indefinite hang beyond Kubo's own resolve behaviour.
- [ ] Test-first at the mock Kubo RPC seam: `name/resolve` call shape + auth + CID parse; `--from-ipns` resolves then pins the resolved CID (not the name); the source-XOR-cid guard; ipns mode publishes the resolved CID. No live daemon.

## Blocked by

- None — `pin-external-cid` + `pin-external-cid-ipns-mode` (the pin flow + ipns publish), `kubo-rpc-client` (mock + client), and `cli-command-wrapper` (the CLI seam) are all in `tasks/done/`.

## Prompt

> Goal: let `pinnace pin` migrate FROM an existing IPNS name — resolve the source IPNS to its current CID, then pin (and optionally publish under the operator's own key). Enables one-command ENS migration: `pin --from-ipns <src> --as ronan --mode ipns` -> pins the current content on the operator's nodes + publishes THEIR `ipns://<id>` to point ENS at. Read the done tasks `pin-external-cid` + `pin-external-cid-ipns-mode` (the pin + ipns-publish flow to reuse), `kubo-rpc-client` (mock + `routingGet` for the endpoint style), `cli-command-wrapper`. Read CONTEXT.md so the SOURCE name vs the operator's OWN name stay distinct.
>
> Add `KuboRpcClient.nameResolve(name)` -> `name/resolve?arg=/ipns/<name>` (normalise bare id / /ipns/ path; parse the `/ipfs/<cid>`; bearer; loud error). Extend `pin` with `--from-ipns <name>`: resolve on a reachable target -> CID, then run the EXISTING pin flow with that CID (redundant pin + MFS + `--mode ipns` publish under the operator's derived key). Require exactly one source (positional `<cid>` XOR `--from-ipns`); report the resolved CID + (ipns) the operator's `ipns://<id>`. Migrating gives the operator THEIR OWN name pointing at a snapshot, not the source's key; re-running re-resolves (manual re-migrate, not auto-follow — say so). Test-first at the mock seam: name/resolve shape + parse, resolve-then-pin-resolved-CID, source XOR guard, ipns publishes the resolved CID. Done means `pin --from-ipns <name> --as <name> --mode ipns` migrates a live IPNS site onto the operator's own name in one command.
