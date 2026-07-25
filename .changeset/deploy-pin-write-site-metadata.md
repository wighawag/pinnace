---
'pinnace': minor
---

`deploy` and `pin` now write the REAL per-site metadata into the MFS wrapper's `metadata.json`: the `mode` the operation ran in, plus the site's `ensName` (the eth.limo warming lever the on-box loop reads). Two verb-flags reach every state of that three-valued field, on `deploy` and on BOTH `pin` entry points (`pin <cid>` and `pin --from-ipns`):

- `--set-ens-name <name>` sets `ensName` to that name (warm `<name>.limo`); the name and the site id do NOT have to be `.eth` (the ENS name is decoupled from the id).
- `--set-ens-name` with NO value REMOVES the key, so the on-box rule INFERS the name from a `.eth` id. It fails loud when the id does not end in `.eth` (there would be nothing to infer). Bare = the flag at the end of the args or immediately followed by another `--flag`, the existing no-value convention.
- `--unset-ens-name` persists `""`, the opt-out: never warm eth.limo, even for a `.eth` id.
- OMITTING both LEAVES the site's `ensName` alone: a first deploy/pin leaves it ABSENT (a `.eth` id then warms by inference), and a re-deploy/re-pin PRESERVES the existing value — including a prior `""` opt-out — via a read-modify-write of the site's current `metadata.json` on each node. Omitting is never a delete, and never authors a name.

The two flags are mutually exclusive (a usage error), and both refusals happen before any node is touched. Library callers get the same lever through the new `ensName` intent on `deploy()`/`pinExternal()` (`EnsNameIntent`, `resolveSiteMetadataToWrite`, `assertEnsNameIntent`, `EnsNameInferenceError`, exported from the package root). Resolving eth.limo warming FROM this metadata remains the on-box loop's own change.
