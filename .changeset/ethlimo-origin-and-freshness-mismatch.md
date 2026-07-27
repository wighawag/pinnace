---
'pinnace': minor
---

`status` can now say "your ENS name is not pointing at this site" and "eth.limo is serving an older CID".

Until now the eth.limo column answered one question: does `<name>.limo` respond? A live box answered YES, with every other indicator green, while eth.limo was resolving through a DIFFERENT publisher's name — the operator had pinned the content with `pin --from-ipns` and never repointed the ENS contenthash, so pinnace was refreshing an ORPHANED name nothing referenced and the site was one old-publisher outage away from going dark.

Each site now reports TWO INDEPENDENT axes, read from the `x-ipfs-path` / `x-ipfs-roots` headers of the probe that already ran (no second request, no second seam), in the CLI `status` line, the `status.json` payload and the dashboard:

- `ethLimoOrigin`: `ours` (the path names this site's IPNS id, or its CID for an `ipfs`-mode site), `foreign (<path>)` NAMING the other name/cid it points at instead, `frozen (<path>)` (an `ipns`-mode site whose ENS holds an immutable `/ipfs/<cid>`: correct today, but it will never follow a future deploy), `unknown (<reason>)`, or `n/a` for a site that resolves no ENS name.
- `ethLimoFreshness`: `current`, `stale (<served cid>)`, `unknown (<reason>)`, or `n/a`.

They are never collapsed into one verdict — the regression above is precisely a `foreign` origin serving a `current` cid. `stale` and `frozen` render as neutral ATTENTION states, never the red negative: a gateway lagging a fresh deploy is normal IPNS propagation, not a fault. A missing header or a probe that could not be made reports `unknown` WITH its reason on both axes, never a confident negative, and a site with no ENS name reports `n/a` (nothing to ask), which stays distinct from `unknown` (could not ask).

HONESTY, stated in the code docs, the README, the dashboard footer and the glossary: these axes observe what eth.limo RESOLVED AND SERVED through its own cache. They are NOT a read of the ENS record (pinnace speaks no Ethereum RPC — wiring a name into ENS is the consumer's job), so they can lag reality and cannot tell a wrong contenthash from a stale gateway cache.

BREAKING for library consumers who inject their own gateway probe: `GatewayProbe` now resolves to `{status, headers?}` instead of a bare status number, so the ONE probe seam carries the headers these axes need rather than a second probe type being introduced. `defaultGatewayProbe` and every CID-gateway behaviour are otherwise unchanged.

## Decisions

Full rationale (alternatives considered, what each touches): `work/notes/observations/ethlimo-origin-and-freshness-decisions.md`.

- **The probe seam was WIDENED once** to a result object rather than forked into a header-reading probe beside it, and rather than returning a `number | object` union that would leave one seam with two shapes. Touches every injector of `GatewayProbe`.
- **This is a `minor`, not a `patch`**, answering the open review question about the previous widening of this same exported type: a change to an exported type's shape is a minor, even pre-1.0.
- **`frozen` applies to ANY `/ipfs/<cid>` under a name-publishing site**, whether or not that cid is current: `origin` judges what the record POINTS AT, and `freshness` answers separately whether it is ours. Folding the cid comparison into the origin axis is the collapsing the two axes exist to avoid.
- **`foreign` is the only new state painted as a negative.** For an `ipfs`-mode site it may be an older cid of your own; from outside there is no way to tell that from another site's cid, and the docs say so.
- **Cids are compared as strings**, so a different encoding of the same cid reads as `stale` — one more reason `stale` is an attention state, not an accusation.
- **The `ok`/`unverified` roll-up token is unchanged**: a mismatch does not flip it, so a consumer alerting on it must read the two new fields.
