---
title: build decisions for 'pin-from-ipns-migrate' (pinnace pin --from-ipns)
date: 2026-07-25
status: open
reviewOf: pin-from-ipns-migrate
---

# `pinnace pin --from-ipns <source>` build decisions (2026-07-25)

Decisions recorded while building the task `pin-from-ipns-migrate` (migrate a site FROM an existing IPNS name). Captured here per the work contract because each either touches another flag/command, sets a user-visible surface, or fixes what a value MEANS downstream, so a reviewer/human can ratify or reverse it.

Where this note is referenced from (so it is discoverable without trusting a claim): the `src/pin/pin-external.ts` module JSDoc names it by path, and the completion report links it. The vocabulary half lives in `CONTEXT.md` (the amended **pin** entry: a pin's SOURCE is a cid XOR an IPNS name to migrate from).

## 1. The resolve lives in the CORE `pinExternal` (a `fromIpns` source), not in the CLI

`--from-ipns` is a passthrough: the CLI hands `fromIpns` to `pinExternal`, which resolves it and then runs its existing flow on the resolved cid. Rationale: CONTEXT.md `core vs cli` says all logic lives in the core so the same operation is usable as a TypeScript API, so a library caller gets one-call migrate too, and there is exactly one place that knows "a pin has one source". Alternatives considered: (a) resolving in `runPin` and passing a cid to the core, rejected because the CLI would then own domain logic and library users would have to re-compose it; (b) a separate exported core function (`resolveIpnsSource`) the CLI composes, rejected for the same reason plus a second public entry point to keep in step. Consequence: `PinExternalInput.cid` became OPTIONAL (with a required cid-XOR-fromIpns guard), which is a shape change for library callers even though a cid-only call behaves exactly as before. Touches: `PinExternalInput`/`PinExternalResult` (public types), `ClientDeps.pinExternal`, any non-CLI caller.

## 2. Which node resolves: the FIRST target that answers, tried in order, sequentially

The task said "on one reachable node, e.g. the first target / the publisher". Implemented as: try the targets in the order the caller gave them (the CLI's order is the `pinnace.json` host order, narrowed by `--host`), first success wins, and the resolving node is reported (`resolvedBy`, printed as `via <baseUrl>`). The later targets are a REACHABILITY fallback, not a quorum: one `name/resolve` is one DHT lookup for an answer every node would give alike, so fanning out would multiply work for nothing and raise the question of what to do when two nodes disagree (an answer nobody has asked for yet). Alternatives considered: only ever the first target (rejected: one down box would sink a migrate the operator can obviously still do); the publisher specifically (rejected: resolving needs no key, so tying it to the signing role would be a false coupling, and in `ipfs` mode there may be no stated publisher at all). Consequence to ratify: with a stale/disagreeing node first in the list, that node's view of the name is what gets pinned, which is why the resolving node is printed. Touches: `--host` narrowing, host order in `pinnace.json`, the printed report.

## 3. `nameResolve` returns the path AFTER `/ipfs/`, so a name pointing INTO a directory is kept

`name/resolve` normally answers `/ipfs/<cid>`, but a source MAY publish `/ipfs/<cid>/<subpath>`. The client returns everything after `/ipfs/`, so such a name yields `<cid>/<subpath>` and the pin flow pins exactly what the name said (`pin/add`, `files/cp` and `name/publish` all accept an `/ipfs/...` path, so nothing downstream changes). Alternatives considered: keeping only the first segment (rejected: it would silently pin the PARENT directory: wrong content, no error), and refusing a sub-path outright (rejected: a new refusal for a case that works fine end to end). Consequence to ratify: `PinExternalResult.cid` is documented as "a cid, or a cid+subpath when the source name points into a directory", so a consumer treating it as a bare CID string would need to split it. Touches: `PinExternalResult.cid`, `PinNodeOk.cid`, the MFS entry the pin creates.

## 4. `ipns://<id>` is accepted as an input form, not only printed as an output

`--from-ipns` normalises three forms: a bare `k51...`, an `/ipns/<id>` path, and `ipns://<id>`. The third is deliberate: `ipns://<id>` is exactly what pinnace itself PRINTS and what an ENS contenthash carries, so refusing the string an operator just copied out of pinnace (or out of ENS) would be gratuitous. A bare DNSLink name (`example.com`) normalises the same way and is Kubo's business to resolve; nothing here special-cases it. Touches: the `--from-ipns` input surface, the `ipns://<id>` output pinnace prints elsewhere.

## 5. A new LOUD failure `PinSourceResolveError`, thrown before anything is pinned

A source name that resolves on NO target is an error, not an empty pin: `PinSourceResolveError` carries the source name and each node's own Kubo message (`routing: not found`), and is thrown BEFORE any `pin/add`, so a failed migrate leaves no half-done state. It is also thrown AFTER the existing `ipns`-mode refusals (unset master, no publisher), so a refusal never even asks the network to resolve. The CLI catches this one class (it cannot pre-check reachability) and turns it into `pinnace pin: <message>` + exit 1. The cid-XOR-fromIpns violation is by contrast a PLAIN `Error` in the core (matching the existing empty-`cid`/`name` guards) with the loud usage message living in the CLI, where the operator's own words can be quoted back. Touches: the error family (`PinStageError`, `PinPublisherRequiredError`), the exported surface in `src/index.ts`, `runPin`'s exit codes.

## 6. `recursive=true` is sent explicitly on `name/resolve`

Kubo's own default for `name/resolve` is already recursive, but the parameter is sent explicitly, exactly as `pinAdd` sends `recursive`, so the request shape states the intent (follow a chain of names to the content it ends at) rather than inheriting a daemon default that could change. No `--dht-timeout` passthrough was added: the task called it optional, and the honest bound is Kubo's own resolve behaviour, so adding a flag nobody asked for would widen the CLI surface for nothing. Touches: the `name/resolve` call shape; a future `--dht-timeout` would extend it.

## 7. The CLI PRINTS the snapshot-not-a-follow caveat on every migrate

Alongside `resolved ipns <src> -> <cid>`, a migrate prints `note: a snapshot of <src>, not a follow. Re-run this command to pull a newer one (pinnace never tracks the source itself)`. The task asked for that distinction to be stated clearly, and the docs alone are the wrong place: the misconception ("my site now mirrors theirs live") is formed exactly at the moment the operator runs the command. Alternative considered: documentation only, rejected as the caveat is load-bearing for the ENS story. Touches: `pin`'s stdout shape (a scripted consumer parsing stdout sees one extra line, on the migrate path only).
