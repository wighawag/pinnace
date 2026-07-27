---
title: Reject unknown CLI flags — a flag you type must never mean nothing (incl. its NAME)
slug: reject-unknown-cli-flags
spec: sites-metadata-in-mfs
promptGuidance.testFirst: true
blockedBy: []
covers: [2]
---

## What to build

`parseArgs` accepts ANY `--token` and stores it in `flags`. Nothing validates the flag NAME, so a flag no verb reads is silently ignored. This bit a real operator on a real box, immediately after the `--mode` -> `--set-mode` rename:

```
pinnace pin --from-ipns k51... --as ronan.eth --mode ipns
```

`--mode` parsed fine, nobody read it, mode fell back to the `ipfs` default, the site was pinned as `ipfs` and NO IPNS record was published. Worse, the stored `metadata.json` then said `mode: ipfs`, so the on-box `republish` would skip signing the name (reporting `ipfs-mode`) and the live name would lapse within `RECORD_LIFETIME` (72h). It was caught only because a human noticed a missing `ipns://` line in the output; a CI or cron run would have failed SILENTLY.

The repo already states the principle, and the README says it out loud:

> A flag you type must never mean nothing.

Today that is enforced only for a flag with a MISSING VALUE (`refuseBareFlags`). Extend it to the flag's NAME.

- **Per-verb allowlist.** Each verb declares the flags it accepts; anything else is a LOUD error naming the offending flag, e.g. `pinnace pin: unknown flag '--mode'`, listing the flags that verb does accept. Enumerate EVERY verb's real flag set from the code (deploy, pin, status, site, authorize, derive, provision, install-ci, node, version) — do not guess, and do not miss one, because a missed flag becomes a false refusal of a VALID command, which is worse than the bug being fixed.
- **Keep the dynamic per-host flags working:** `--host-endpoint.<name>` and `--host-token.<name>` are PREFIX-shaped and must stay accepted on every node-touching verb. The allowlist has to permit a prefix pattern, not just exact names.
- **The global flags** (`--config`, `--endpoint`) are stripped before the verb parser sees them; make sure the new check runs AFTER that stripping so they are never mis-reported as unknown.
- **A rename hint.** Keep a small static map of flags this project has RENAMED and suggest the replacement, because that is exactly when this bug bites: `--mode` -> "did you mean `--set-mode`?". Include any other renames in the current release train. A generic nearest-match suggestion is optional and secondary; the static map is the part that matters.
- **Do NOT redesign `parseArgs`.** Add validation around it. The parser stays a small local parse/format layer (a full arg-parsing dependency remains over-weight for this CLI).

This also catches plain typos: `--set-mod ipns` would today pin as `ipfs` in silence.

## Acceptance criteria

- [ ] An unknown flag on any verb is a LOUD error naming it, listing that verb's accepted flags, and exiting non-zero WITHOUT performing the operation (tested per verb, at minimum: deploy, pin, status, site, authorize, derive, provision, install-ci).
- [ ] `pinnace pin --from-ipns <src> --as x --mode ipns` REFUSES and suggests `--set-mode` (the exact regression that shipped) — tested.
- [ ] Every currently-valid flag on every verb is still accepted; a full command line per verb, using all of its real flags, still parses and runs (tested — this is the guard against over-refusing).
- [ ] `--host-endpoint.<name>` and `--host-token.<name>` still work on every node-touching verb (tested).
- [ ] The global `--config` / `--endpoint`, in EITHER position, are never reported as unknown (tested both positions).
- [ ] The existing bare-flag refusal (`refuseBareFlags`) still behaves as before; the two guards compose rather than replacing one another.
- [ ] `parseArgs` itself is not redesigned and no arg-parsing dependency is added.
- [ ] Test-first; env/config isolated; no live daemon. A changeset is included, noting that an unknown flag is now a refusal (a behaviour change for anyone whose scripts pass a stale flag) and that `--mode` gets an explicit rename hint.

## Blocked by

- None. `src/cli/run.ts` only.

## Prompt

> Goal: make an unknown flag NAME a loud refusal, closing the last hole in "a flag you type must never mean nothing". Read `src/cli/run.ts` (`parseArgs`, `refuseBareFlags`, `takeConfigFlag`, `takeEndpointFlag`, and every verb's parser) and the README line stating the principle.
>
> A real operator just ran `pin ... --mode ipns` after the rename: it parsed, nobody read it, the site was pinned as `ipfs`, no IPNS record was published, and the stored metadata would have made `republish` skip the name until it lapsed. Only a missing `ipns://` line in the output revealed it.
>
> Add a per-verb flag allowlist with a loud unknown-flag error, keep the `--host-endpoint.<name>` / `--host-token.<name>` prefix flags working, run the check after the global flags are stripped, and add a static rename hint so `--mode` points at `--set-mode`. Be exhaustive when enumerating each verb's flags: wrongly refusing a valid command is worse than the bug you are fixing.
