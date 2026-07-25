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

### Two ensName verb-flags + omit = do nothing (omitted != delete)

The metadata `ensName` FIELD has three internal states the on-box warm rule acts on: a non-empty string (warm `<ensName>.limo`), the empty string `""` (OPT OUT — never warm, even a `.eth` id), and ABSENT (infer from a `.eth` id). But the CLI needs only TWO flags to reach every MEANINGFUL outcome, because setting a name reproduces the inferred state for a `.eth` site (an explicit `ensName = "ronan.eth"` behaves identically to inferring it):

- `--set-ens-name <name>` -> set ensName = `<name>` (warm `<name>.limo`). To "restore the inferred name" for a `.eth`-named site, just set it to the id — same effect as inference.
- `--unset-ens-name` -> OPT OUT: set ensName = `""` (never warm, even a `.eth` id).
- **both flags OMITTED** -> PRESERVE the existing metadata's ensName unchanged (do NOT delete, do NOT reset). This requires a READ-MODIFY-WRITE: on deploy/pin of an existing site, read the current `/sites/<id>/metadata.json` first, carry its `ensName` forward when no ens flag is given, and only overwrite `ensName` when a flag is present. (A NEW site with no prior metadata starts from ABSENT ensName -> the warm rule infers from a `.eth` id.)

The two flags are mutually exclusive (giving both is a usage error). (`mode` is required for the op, so it does not need the preserve-on-omit rule; the load-bearing preserve semantics is for `ensName`.)

NOTE the split: the FIELD stays three-valued (name / `""` / absent) so the on-box warm rule (sibling task) still has its full three-way resolution — a site never given an ensName has ABSENT metadata and correctly infers. Only the CLI SURFACE collapses to two flags; `--unset-ens-name` writes `""`, a never-set site stays absent.

Wire these flags through the thin CLI for deploy + pin, env-isolated as usual.

This task does NOT resolve warming from metadata (that is the on-box/warm task); it only PERSISTS the metadata at write time.

## Acceptance criteria

- [ ] `deploy` writes `{ ensName?, mode }` into `/sites/<id>/metadata.json` via `placeInMfs`; `mode` from `--mode` (arg > default).
- [ ] `pin` (both `pin <cid>` and `pin --from-ipns`) writes the same metadata via `placeInMfs`, from its `--mode` + the ens flags.
- [ ] Two mutually-exclusive verb-flags + leave-alone: `--set-ens-name <name>` sets it (and is how a `.eth` site restores the inferred name — set it to the id); `--unset-ens-name` persists `""` (opt out, never warm); OMITTING both PRESERVES the existing ensName (read-modify-write — a re-deploy without an ens flag never changes it); giving both flags is a usage error.
- [ ] A NEW site with no ens flag writes ABSENT ensName (no key) so the on-box warm rule infers from a `.eth` id; the FIELD stays three-valued (name / `""` / absent) even though the CLI has two flags.
- [ ] Tests assert, at the mock Kubo seam (deploy + both pin paths): `--set-ens-name` sets; `--unset-ens-name` -> `""`; OMIT-preserves (re-deploy of a site with an existing ensName and no ens flag keeps it); a new site with no ens flag has absent ensName; and the both-flags mutual-exclusion error.
- [ ] Test-first; env/config isolated; no live daemon.

## Blocked by

- Blocked by `mfs-site-wrapper-layout-and-metadata-seam` (needs `placeInMfs(metadata)` + the wrapper).

## Prompt

> Goal: have `deploy` and `pin` write real per-site metadata (`ensName`, `mode`) into the MFS wrapper `metadata.json`. Read the spec `sites-metadata-in-mfs` (story 4: deploy writes metadata; re-deploy is the update), the done tasks `deploy-multi-target` + `pin-external-cid`(+ `-ipns-mode`, `-from-ipns`) and `cli-command-wrapper`, and the sibling `mfs-site-wrapper-layout-and-metadata-seam` (`placeInMfs` now takes `metadata`).
>
> Pass each operation's `mode` (deploy: `--mode` arg > default, since the config mode-source is going away; pin: its existing `--mode`) and the ensName state into `placeInMfs`'s `metadata`. Two mutually-exclusive verb-flags + omit=leave-alone (omitted != delete): `--set-ens-name <name>` sets (and is how a `.eth` site restores the inferred name — set it to the id); `--unset-ens-name` opts out (persists `""`, never warm); OMITTING both PRESERVES the existing ensName — needs a READ-MODIFY-WRITE (read `/sites/<id>/metadata.json` via `filesRead`, carry ensName forward when no ens flag). A NEW site with no ens flag writes ABSENT ensName so the on-box rule infers from a `.eth` id — the FIELD stays three-valued (name/`""`/absent) though the CLI has two flags. Cover BOTH pin entry points. Do NOT resolve warming here (the on-box/warm task) — only persist. Test-first at the mock seam: set / unset(`""`) / omit-preserves / new-site-absent / both-flags-error. Env isolated, no live daemon. Done means a deployed/pinned site carries `{ensName?, mode}` in MFS, changeable via the three explicit flags and never silently wiped.
