# Node state (`NODE_ROLE`, `PUBLISHER_ENDPOINT`) belongs in MFS, like site metadata

2026-07-26, surfaced while renaming `promote` to `authorize`.

The `sites-metadata-in-mfs` spec moved PER-SITE state out of the client's config and into MFS, because the box can only act on what it can SEE, and what it can see is MFS over its bearer-guarded Kubo RPC. **Per-NODE state has the identical problem, one level up, and it is still stuck in a boot-time env file.**

Two values are written into the box's cloud-init env file at first boot and are unreachable over Kubo RPC afterwards:

- **`NODE_ROLE`** gates which on-box timers do anything (`republish` only on a publisher, `mirror` only on a replica; the verbs self-gate on it).
- **`PUBLISHER_ENDPOINT`** tells a replica where to fetch the publisher's exported signed records.

## The three symptoms this causes

1. **Failover is a REPROVISION, not an operation.** Moving the keys to a surviving replica is pure RPC and easy, but the new publisher will never sign, because its `NODE_ROLE` still says `replica`. And every OTHER replica keeps mirroring the dead box, because their `PUBLISHER_ENDPOINT` still points at it. Both need SSH or a rebuild. This is why the old `promote` verb degenerated into importing a key and returning a synthesised `role: 'publisher'` string that persisted nothing: the honest operation was not reachable.
2. **The replica guard cannot be enforced under `--endpoint`.** `--endpoint` mints a synthetic host with `role: 'publisher'`, so the client invents the role it then checks, and the box's real role is invisible. `authorize --endpoint <url>` at a machine that is actually a replica will import a key onto a box that must never hold one, and nothing can detect it. With the role in MFS, the guard becomes real on BOTH paths.
3. **The two-signer hazard is only half-detectable.** With a config, `authorize` can check the other hosts' keystores before importing. Under `--endpoint` only one box is visible, so nothing catches a second signer racing IPNS sequence numbers.

## The shape of the fix

Store node state in MFS (`filesWrite`/`filesRead` already exist, added by `kubo-client-files-read-write`) rather than the env file, and have the on-box verbs read it from there. Then:

- a box's role is CLIENT-CHANGEABLE over the same bearer-guarded RPC everything else uses;
- `authorize` can verify the target's ACTUAL role and refuse a replica for real;
- failover becomes a genuine client-driven operation, roughly: attempt `key/rm` on the old publisher (best-effort, it is usually down, which is why you are failing over), rewrite the role + publisher-endpoint state on the affected boxes, update `pinnace.json` to match, then `authorize`. Note `key/rm` is NOT wrapped on `KuboRpcClient` today (it has `key/list` + `key/import` only), so that is a prerequisite.

## The residual hazard that this does NOT fix

If the old publisher was unreachable when its keys were removed and it later comes back holding them, two boxes sign the same name and race sequence numbers. Best-effort removal cannot close that; only taking the old box out of service can. Any failover design must say so rather than imply the split-brain is handled.

Not tasked. This is a spec seed (it touches ADR-0002's on-box boundary and the provisioning contract), not a change to make inside a rename.
