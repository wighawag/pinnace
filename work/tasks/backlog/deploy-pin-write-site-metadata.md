---
title: deploy + pin write real site metadata (ensName, mode) into MFS
slug: deploy-pin-write-site-metadata
spec: sites-metadata-in-mfs
promptGuidance.testFirst: true
blockedBy: [mfs-site-wrapper-layout-and-metadata-seam]
covers: [3, 4, 6]
---

## What to build

Make `deploy` and `pin` write the REAL per-site metadata (`ensName`, `mode`) into the MFS wrapper's `metadata.json`, using the metadata seam the previous task added (`placeInMfs` now takes a `metadata` arg). This is what makes a site's metadata travel with the site on the node, so the on-box loop can read it.

- **`deploy`**: pass the site's `mode` (from `--mode`, resolved arg > default; the config-based mode source is being removed by the config-shrink task) and its `ensName` into `placeInMfs` as `metadata`. Re-running `deploy` for the same `id` overwrites content + the metadata it is TOLD about (idempotent update — this IS how metadata is changed; there is no separate `update` verb).
- **`pin`**: both entry points (`pin <cid>` and `pin --from-ipns`) already call `placeInMfs`; pass their `mode` (already a `--mode` arg on pin) and the `ensName` state into `metadata`. Same wrapper write.

### Three ensName verb-flags + omit = do nothing (omitted != delete)

`ensName` in metadata has three meanings (per the seam/warming tasks): a non-empty string (warm `<ensName>.limo`), the empty string `""` (OPT OUT — never warm, even for a `.eth` id), and ABSENT (infer from a `.eth` id). Three unambiguous verb-flags reach each state, and omitting them all leaves ensName UNCHANGED (never a silent delete on re-deploy):

- `--set-ens-name <name>` -> set ensName = `<name>` (warm `<name>.limo`).
- `--opt-out-ens-name` -> set ensName = `""` (OPT OUT — never warm, even for a `.eth` id).
- `--unset-ens-name` -> REMOVE the ensName key (back to ABSENT -> `.eth`-inference applies).
- **all three flags OMITTED** -> PRESERVE the existing metadata's ensName unchanged (do NOT delete, do NOT reset). This requires a READ-MODIFY-WRITE: on deploy/pin of an existing site, read the current `/sites/<id>/metadata.json` first, carry its `ensName` forward when no ens flag is given, and only overwrite `ensName` when one of the three flags is present. (A NEW site with no prior metadata simply starts from empty.)

The three flags are mutually exclusive (giving more than one is a usage error). (`mode` is required for the op, so it does not need the preserve-on-omit rule; the load-bearing preserve semantics is for `ensName`.)

Wire these flags through the thin CLI for deploy + pin, env-isolated as usual.

This task does NOT resolve warming from metadata (that is the on-box/warm task); it only PERSISTS the metadata at write time.

## Acceptance criteria

- [ ] `deploy` writes `{ ensName?, mode }` into `/sites/<id>/metadata.json` via `placeInMfs`; `mode` from `--mode` (arg > default).
- [ ] `pin` (both `pin <cid>` and `pin --from-ipns`) writes the same metadata via `placeInMfs`, from its `--mode` + the ens flags.
- [ ] The three verb-flags reach all three states + leave-alone: `--set-ens-name <name>` sets it; `--opt-out-ens-name` persists `""`; `--unset-ens-name` REMOVES the key (back to inference); OMITTING all three PRESERVES the existing ensName (read-modify-write — a re-deploy without an ens flag never deletes it). The three flags are mutually exclusive (more than one = usage error).
- [ ] Tests assert, at the mock Kubo seam (deploy + both pin paths): `--set-ens-name` sets; `--opt-out-ens-name` -> `""`; `--unset-ens-name` -> key absent; OMIT-preserves (re-deploy of a site with an existing ensName and no ens flag keeps it; a new site starts empty); and the mutual-exclusion error.
- [ ] Test-first; env/config isolated; no live daemon.

## Blocked by

- Blocked by `mfs-site-wrapper-layout-and-metadata-seam` (needs `placeInMfs(metadata)` + the wrapper).

## Prompt

> Goal: have `deploy` and `pin` write real per-site metadata (`ensName`, `mode`) into the MFS wrapper `metadata.json`. Read the spec `sites-metadata-in-mfs` (story 4: deploy writes metadata; re-deploy is the update), the done tasks `deploy-multi-target` + `pin-external-cid`(+ `-ipns-mode`, `-from-ipns`) and `cli-command-wrapper`, and the sibling `mfs-site-wrapper-layout-and-metadata-seam` (`placeInMfs` now takes `metadata`).
>
> Pass each operation's `mode` (deploy: `--mode` arg > default, since the config mode-source is going away; pin: its existing `--mode`) and the ensName state into `placeInMfs`'s `metadata`. Three mutually-exclusive verb-flags reach ensName's three states, and omitting them all leaves it alone (omitted != delete): `--set-ens-name <name>` sets; `--opt-out-ens-name` persists `""` (never warm, even a `.eth` id); `--unset-ens-name` REMOVES the key (back to `.eth` inference); OMITTING all three PRESERVES the existing ensName — needs a READ-MODIFY-WRITE (read the current `/sites/<id>/metadata.json` via `filesRead`, carry ensName forward when no ens flag is given). Cover BOTH pin entry points. Do NOT resolve warming here (the on-box/warm task) — only persist. Test-first at the mock seam: set / opt-out(`""`) / unset(key absent) / omit-preserves / mutual-exclusion error. Env isolated, no live daemon. Done means a deployed/pinned site carries `{ensName?, mode}` in MFS, changeable via the three explicit flags and never silently wiped.
