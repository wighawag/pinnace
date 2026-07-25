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

### Two ensName verb-flags (one with an OPTIONAL value) + omit = do nothing

The metadata `ensName` FIELD has three states the on-box warm rule acts on: a non-empty string (warm `<ensName>.limo`), the empty string `""` (OPT OUT — never warm, even a `.eth` id), and ABSENT (INFER from a `.eth` id). Two verb-flags reach all three explicitly, with `--set-ens-name` taking an OPTIONAL value:

- `--set-ens-name <name>` (value given) -> set ensName = `<name>` (warm `<name>.limo`).
- `--set-ens-name` (value OMITTED / bare) -> RESTORE INFERENCE: set ensName ABSENT (remove the key) so the warm rule infers from the `.eth` id. This FAILS LOUD if the site `id` does NOT end in `.eth` (there is nothing to infer — a clear usage error, not a silent no-op).
- `--unset-ens-name` -> OPT OUT: set ensName = `""` (never warm, even a `.eth` id).
- **both flags OMITTED** -> PRESERVE the existing metadata's ensName unchanged (do NOT delete/reset). READ-MODIFY-WRITE: read the current `/sites/<id>/metadata.json` first, carry its `ensName` forward when no ens flag is given; only overwrite when a flag is present. (A NEW site with no prior metadata + no ens flag starts ABSENT -> infers from a `.eth` id.)

Details to pin:
- **Optional-value detection:** bare `--set-ens-name` = the flag at end-of-args OR immediately followed by another `--flag` (no value token). Reuse the existing `parseArgs` value/no-value convention (a following token starting with `--` is treated as no value); state it so the two forms are unambiguous.
- **The `.eth` guard applies ONLY to the bare/infer form.** An EXPLICIT `--set-ens-name <name>` does NOT require the id (or the name) to be `.eth` — the ENS name is decoupled from the id; the operator is naming the gateway to warm. Only bare `--set-ens-name` (which relies on inference from the id) needs the `.eth` id.
- The two flags are mutually exclusive (both = usage error). `mode` is required for the op, so it does not need preserve-on-omit; the load-bearing preserve semantics is for `ensName`.

The FIELD stays three-valued so the on-box warm rule (sibling task) keeps its full three-way resolution; the CLI reaches each state via set-with-value / set-bare / unset.

Wire these flags through the thin CLI for deploy + pin, env-isolated as usual.

This task does NOT resolve warming from metadata (that is the on-box/warm task); it only PERSISTS the metadata at write time.

## Acceptance criteria

- [ ] `deploy` writes `{ ensName?, mode }` into `/sites/<id>/metadata.json` via `placeInMfs`; `mode` from `--mode` (arg > default).
- [ ] `pin` (both `pin <cid>` and `pin --from-ipns`) writes the same metadata via `placeInMfs`, from its `--mode` + the ens flags.
- [ ] `--set-ens-name <name>` sets ensName = `<name>` (no `.eth` requirement on an explicit name); `--set-ens-name` bare removes the key (restore inference) and FAILS LOUD when the id does not end in `.eth`; `--unset-ens-name` persists `""` (opt out); OMITTING both PRESERVES the existing ensName (read-modify-write); both flags together = usage error.
- [ ] Optional-value detection matches the existing `parseArgs` convention (bare = end-of-args or followed by a `--flag`); the two `--set-ens-name` forms are unambiguous.
- [ ] A NEW site with no ens flag writes ABSENT ensName so the on-box warm rule infers from a `.eth` id; the FIELD stays three-valued (name / `""` / absent) though the CLI uses set-with-value / set-bare / unset.
- [ ] Tests assert, at the mock Kubo seam (deploy + both pin paths): set-with-value; set-bare on a `.eth` id -> key absent; set-bare on a non-`.eth` id -> loud error; `--unset-ens-name` -> `""`; OMIT-preserves; new-site-absent; both-flags error.
- [ ] Test-first; env/config isolated; no live daemon.

## Blocked by

- Blocked by `mfs-site-wrapper-layout-and-metadata-seam` (needs `placeInMfs(metadata)` + the wrapper).

## Prompt

> Goal: have `deploy` and `pin` write real per-site metadata (`ensName`, `mode`) into the MFS wrapper `metadata.json`. Read the spec `sites-metadata-in-mfs` (story 4: deploy writes metadata; re-deploy is the update), the done tasks `deploy-multi-target` + `pin-external-cid`(+ `-ipns-mode`, `-from-ipns`) and `cli-command-wrapper`, and the sibling `mfs-site-wrapper-layout-and-metadata-seam` (`placeInMfs` now takes `metadata`).
>
> Pass each operation's `mode` (deploy: `--mode` arg > default, since the config mode-source is going away; pin: its existing `--mode`) and the ensName state into `placeInMfs`'s `metadata`. Two verb-flags (`--set-ens-name` takes an OPTIONAL value) + omit=leave-alone (omitted != delete): `--set-ens-name <name>` sets ensName=`<name>`; bare `--set-ens-name` removes the key (restore inference) and FAILS LOUD if the id is not `.eth`; `--unset-ens-name` opts out (`""`, never warm); OMITTING both PRESERVES the existing ensName — READ-MODIFY-WRITE (read `/sites/<id>/metadata.json` via `filesRead`, carry ensName forward when no ens flag). The `.eth` guard applies ONLY to bare-set (an explicit name has no `.eth` requirement — ENS name is decoupled from id). Optional-value detection reuses the existing parseArgs no-value convention. The FIELD stays three-valued so the on-box warm rule keeps its three-way resolution. Cover BOTH pin entry points. Do NOT resolve warming here (on-box task) — only persist. Test-first at the mock seam: set-with-value / set-bare(.eth -> absent) / set-bare(non-.eth -> loud error) / unset(`""`) / omit-preserves / new-site-absent / both-flags-error. Env isolated, no live daemon. Done means a deployed/pinned site carries `{ensName?, mode}` in MFS, changeable via the three explicit flags and never silently wiped.
