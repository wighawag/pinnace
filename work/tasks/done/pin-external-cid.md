---
title: Pin an external network CID redundantly across nodes (pinnace pin <cid> --as <name>)
slug: pin-external-cid
spec: pinnace
blockedBy: []
covers: [4, 15]
---

## What to build

Let pinnace pin an ARBITRARY IPFS CID that already exists on the network — content the operator does NOT have the local files for, only the CID. Kubo can fetch + pin any retrievable CID via `pin/add` (it resolves the DAG over the network); pinnace just needs to expose that. This turns the operator's nodes into a self-hosted pinning service for external content, not only their own deploys.

Decisions (already made with the operator — build to these):
- **Redundant by default:** pin on ALL configured nodes (like `deploy`'s fan-out), so the CID is pinned on every box. A `--host <name>` targets a single node instead.
- **Place it in MFS under a name:** `--as <name>` (or a required `<name>` arg) places the pinned CID at `/sites/<name>` so `status`, `warm`, and `republish`-discovery track it exactly like a deployed site (it shows on the dashboard, gets gateway-warmed). Reuse the existing `placeInMfs(client, sitesDir, id, cid)`.
- **Recursive:** pin the whole DAG (`pin/add?arg=<cid>&recursive=true`), the normal case.

Implementation (compose existing seams, minimal new surface):
- Add `pinAdd(cid, {recursive})` to `KuboRpcClient` mirroring the existing `pinRm`: `pin/add?arg=<cid>&recursive=true`. (Note: pinning a large external DAG can be slow as Kubo fetches it; the RPC blocks until done — fine, but document it.)
- A core `pinExternal({ targets, cid, name, recursive })` that fans out over the nodes with `Promise.allSettled` (mirror deploy's partial-failure semantics: a non-empty subset succeeding is still overall success, per-node ok/failed reported), and on each node: `pin/add` then `placeInMfs(sitesDir, name, cid)` so it is MFS-tracked.
- A thin CLI verb `pinnace pin <cid> --as <name> [--host <name>] [--no-recursive]` over the `RunContext`/`ClientDeps` seam (resolve targets from config like deploy; `--host` narrows to one). Report per-node success/failure like deploy.

Scope / caveats to honor:
- The content MUST be retrievable on the network at pin time (someone is serving it / a reachable provider has it). If nothing serves it and the operator lacks the bytes, no pin is possible — that is IPFS physics, not a pinnace gap. Surface a clear per-node error if `pin/add` fails to find the content (do not hang silently forever — pass through Kubo's error; a timeout knob is out of scope unless trivial).
- This is DISTINCT from `deploy` (which builds + imports a CAR from local files). `pin` takes only a CID. It also differs from `site add` (which places an ALREADY-local `/ipfs/<cid>` into MFS without fetching); `pin` FETCHES + pins a possibly-remote CID. Keep the vocabulary coherent (CONTEXT.md): do not re-mean `deploy`/`add`.
- Unpinning: removing a pinned external CID is already covered by `site remove <name>` (it `files/rm` + `pin/rm`). Confirm that path works for a pin-added site (same MFS entry + pin), and note it; do not build a second removal verb.

## Acceptance criteria

- [ ] `KuboRpcClient.pinAdd(cid, {recursive})` issues `pin/add?arg=<cid>&recursive=true` (recursive default true), sends the bearer token, and raises the loud `KuboRpcError` on non-2xx (mirrors `pinRm`).
- [ ] A core `pinExternal` fans `pin/add` + `placeInMfs(/sites/<name>)` across all configured nodes by default (redundant), with `--host` narrowing to one; partial failure is per-node and a non-empty success subset is overall success (mirror deploy's `allSettled`).
- [ ] The pinned CID is placed in MFS at `/sites/<name>` so `status`/`warm` discover it (it shows on the dashboard and is gateway-warmed).
- [ ] `pinnace pin <cid> --as <name> [--host <name>] [--no-recursive]` dispatches to the core with resolved targets and reports per-node ok/failure, staying a thin wrapper.
- [ ] `site remove <name>` correctly unpins + removes a pin-added site (verified against the mock); no second removal verb is added.
- [ ] Test-first: failing tests at the mock Kubo RPC seam assert the `pin/add` call shape (arg + recursive + auth), the multi-node fan-out + partial-failure semantics, and the MFS placement — no live daemon.
- [ ] The distinction from `deploy` (CAR from local files) and `site add` (place a local cid) is recorded (a `## Decisions` note or a CONTEXT.md line) so the vocabulary stays coherent.

## Blocked by

- None — `kubo-rpc-client` (mock API + `pinRm`), `deploy-multi-target` (fan-out pattern), `site-management` (`placeInMfs`), and `cli-command-wrapper` (`RunContext` seam) are all in `tasks/done/`.

## Prompt

> Goal: add `pinnace pin <cid> --as <name>` — pin an ARBITRARY network CID (content the operator has only the CID for, not the files) redundantly across all nodes, placed in MFS so it is tracked like a site. Kubo fetches + pins any retrievable CID via `pin/add`; expose that. Read the done tasks `kubo-rpc-client` (mock + `pinRm` to mirror), `deploy-multi-target` (the `Promise.allSettled` fan-out + partial-failure semantics), `site-management` (`placeInMfs`), and `cli-command-wrapper` (the `RunContext`/`ClientDeps` seam). Read CONTEXT.md so you keep `deploy`/`site add`/`pin` distinct.
>
> Build: `KuboRpcClient.pinAdd(cid, {recursive=true})` => `pin/add?arg=<cid>&recursive=true` (mirror `pinRm`, bearer + loud error). A core `pinExternal({targets, cid, name, recursive})` that fans `pin/add` + `placeInMfs(sitesDir, name, cid)` across all nodes by default (redundant; `--host` narrows to one), with deploy-style allSettled partial-failure (a non-empty success subset is success). A thin `pinnace pin <cid> --as <name> [--host <name>] [--no-recursive]` CLI verb reporting per-node results. Confirm `site remove <name>` already unpins a pin-added site (no second removal verb). Decisions to record: this differs from `deploy` (CAR from local files) and `site add` (place an already-local cid) — `pin` FETCHES a possibly-remote CID; surface a clear per-node error if the content is not retrievable (do not hang). Test-first at the mock RPC seam (pin/add shape + auth, multi-node fan-out + partial failure, MFS placement); no live daemon. Done means the operator can pin any public CID redundantly across their nodes and see it on the dashboard.
