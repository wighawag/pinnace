---
title: Update the READMEs for the MFS-metadata model (config has no sites, is optional, ensName flags)
slug: readmes-mfs-metadata-and-optional-config
spec: sites-metadata-in-mfs
blockedBy: [config-drop-sites-and-make-optional, onbox-loop-reads-metadata-ensname-warming, context-glossary-mfs-sites-metadata]
covers: [1, 2, 4, 6]
---

## What to build

Update the package README (`packages/pinnace/README.md`, the one npm displays) and the root `README.md` to describe the reshaped model. These currently document the OLD config-first model (a `sites` array in `pinnace.json`, `mode`/`ensName` as config fields), which is now wrong and user-facing. Docs-only, done LAST so it matches what landed.

Changes to make (verify each against the code as it now stands, not the spec's intent):
- **`pinnace.json` no longer has `sites`.** Update the sample config to the infra-only shape (`hosts` only: publisher/replica endpoints, roles, publisherEndpoint). Remove the `sites: [...]` from every example.
- **Config is OPTIONAL.** Document that a CLI publisher endpoint (+ env token) lets you operate against a single node with NO config file, and show that form; the config file is a convenience for multi-node/durable setups.
- **Per-site `mode` + `ensName` live in MFS metadata**, set at deploy/pin time (`--set-mode`, the ens-name flags), not in config. NOTE (the `--mode` flag NO LONGER EXISTS — `config-drop-sites-and-make-optional` renamed it): document mode as `--set-mode ipfs|ipns` > the mode STORED in `metadata.json` > the `ipfs` default, with OMIT = preserve the stored mode (a re-deploy of a published site keeps signing its name; a first deploy is `ipfs`), and no `--unset-mode` (mode has no empty state). A bare `--set-mode` with no value is a loud usage error. Verify every flag against the REAL CLI before documenting it. Document the ensName flags + omit behaviour: `--set-ens-name <name>` (warm `<name>.limo`), bare `--set-ens-name` (restore inference — warm the `.eth` id; errors if the id is not `.eth`), `--unset-ens-name` (opt out — never warm, even a `.eth` id), and OMIT = leave ensName alone (a first deploy leaves it absent so a `.eth` id auto-warms eth.limo by inference; a re-deploy preserves the existing ensName). Note the `.eth`-id auto-inference (a site id ending `.eth` warms eth.limo automatically unless opted out).
- **A site in MFS is a wrapper** `/sites/<id>/{content, metadata.json}` (mention where it matters, e.g. the mental model / how status/warm discover sites).
- Update the command reference / examples: `deploy` and `pin` take the ens flags; the end-to-end walkthrough uses the infra-only config (or no config). Keep every documented command accurate against the real CLI.

Do NOT re-document unrelated sections; keep the edits scoped to what the reshape changed. Ensure the package README stays self-contained (no broken `../../` links for the npm view).

## Acceptance criteria

- [ ] Both READMEs show `pinnace.json` as infra-only (no `sites` array) and document that the config file is optional (a CLI publisher endpoint + env token suffices), with an example.
- [ ] Per-site `mode`/`ensName` are documented as MFS metadata set at deploy/pin time, including the three ensName states + omit-preserves + the `.eth` auto-inference.
- [ ] The MFS wrapper layout (`/sites/<id>/{content,metadata.json}`) is mentioned where the mental model / discovery is described.
- [ ] Every documented command/flag matches the real CLI (verified), and no example still uses the removed `sites` config or config-based `mode`/`ensName`.
- [ ] A changeset is present (READMEs ship with the package, so this is a package doc change).

## Blocked by

- Blocked by `config-drop-sites-and-make-optional`, `onbox-loop-reads-metadata-ensname-warming`, and `context-glossary-mfs-sites-metadata` (so the READMEs document the final landed behaviour + stay consistent with the glossary).

## Prompt

> Goal: update the root + package READMEs to the reshaped MFS-metadata model (the package README is what npm shows and currently documents the wrong, config-first model). Read the spec `sites-metadata-in-mfs`, the landed sibling tasks, and the current READMEs; verify against the ACTUAL CLI.
>
> Make `pinnace.json` infra-only in every example (drop the `sites` array), document that config is optional (CLI publisher endpoint + env token, no file), and document per-site `mode`/`ensName` as MFS metadata set at deploy/pin: the ens-name flags (`--set-ens-name <name>`, bare `--set-ens-name` to restore inference, `--unset-ens-name` opt-out) plus OMIT (leave alone: first deploy absent so a .eth id infers; re-deploy preserves) and the `.eth`-id auto-inference. Mention the `/sites/<id>/{content,metadata.json}` wrapper in the mental model. Keep every documented command accurate and the package README self-contained (no broken relative links). Add a changeset (READMEs ship with the package). Done means the npm/README docs describe the current model, not the old sites-in-config one.
