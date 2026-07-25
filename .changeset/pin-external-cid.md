---
'pinnace': minor
---

New verb `pinnace pin <cid> --as <name> [--host <name>] [--no-recursive]`: pin an ARBITRARY network CID (content you have only the CID for, not the files) REDUNDANTLY across every configured node and track it in MFS at `/sites/<name>`, so it is gateway-warmed, reported by `status`, and visible on the dashboard exactly like a deployed site. `--host` narrows the fan-out to one node; `--no-recursive` pins the root block only. This makes the operator's own boxes a self-hosted pinning service for external content, not only for their own deploys.

Under it: a new `KuboRpcClient.pinAdd(cid, {recursive})` (`pin/add?arg=<cid>&recursive=true`, bearer-guarded, loud `KuboRpcError` on non-2xx) and a new core `pinExternal({targets, cid, name, recursive})` export that fans `pin/add` + the existing `placeInMfs` across nodes with deploy's `Promise.allSettled` partial-failure semantics (a non-empty success subset is still success). Per-node failures name the stage that failed (`pin` = Kubo could not fetch/retrieve the content, `place` = the MFS placement) via the new `PinStageError`. Note that `pin/add` BLOCKS while Kubo fetches the DAG and no client-side timeout is imposed; removing a pinned CID uses the existing `pinnace site remove <name>` (MFS entry + unpin), not a new verb.
