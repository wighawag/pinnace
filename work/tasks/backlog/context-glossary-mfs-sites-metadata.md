---
title: Re-pin the CONTEXT.md glossary for MFS wrapper sites + metadata (not config)
slug: context-glossary-mfs-sites-metadata
spec: sites-metadata-in-mfs
blockedBy: [config-drop-sites-and-make-optional, onbox-loop-reads-metadata-ensname-warming]
covers: [3, 5, 6]
---

## What to build

Update the `CONTEXT.md` domain glossary so it describes the reshaped model (sites + per-site metadata live in MFS as a wrapper dir; config is infra-only + optional), so the next author cannot re-fork the terms against the old config-first framing. This is a docs-only task, done LAST so it reflects what actually landed.

Entries to re-pin (against the code as it now stands after the sibling tasks):
- **`id`** — still the single site identifier, but its MFS home is now the WRAPPER `/sites/<id>/` (with `content` + `metadata.json`), not `/sites/<id>` = the content CID. Keep the frozen-KDF wording (ADR-0001 unchanged).
- **`ensName`** — now an OPTIONAL per-site field stored in MFS `metadata.json` (written at deploy/pin time), read by the on-box `warm` loop, with the three-way resolution (explicit non-empty warms `<ensName>.limo` > `""` opts out > `.eth`-id inference warms the id > nothing). No longer a `pinnace.json` field.
- **`mode`** — per-site, now stored in MFS `metadata.json`, not a `pinnace.json` site entry. NOTE (the `--mode` flag NO LONGER EXISTS — `config-drop-sites-and-make-optional` renamed it): the source order is now `--set-mode ipfs|ipns` > the mode STORED in the site's `metadata.json` > the `ipfs` default. Omitting the flag PRESERVES the stored mode (so a re-deploy of a published site keeps signing its name instead of silently demoting to `ipfs`); there is deliberately no `--unset-mode`, because mode has no empty state (absent simply means `ipfs`). Pin the term against the CODE as it now stands, and do not re-pin the removed `--mode`.
- **`gateway warming`** / **`pin`** — update any `/sites/<name>` = content wording to the wrapper (`/sites/<name>/content`).
- Add a short **`metadata`** note (the per-site MFS `metadata.json`: `{ensName?, mode}`, written by the client on deploy/pin, read by the on-box loop) and note that `pinnace.json` is infra-only (hosts) + optional.

Do NOT touch ADRs' frozen decisions; this is glossary/framing only.

## Acceptance criteria

- [ ] `CONTEXT.md` `id`, `ensName`, `mode`, `gateway warming`, `pin` entries reflect the wrapper layout + MFS-metadata model; a `metadata` note + the infra-only/optional-config framing are added.
- [ ] No glossary entry still describes sites/ensName/mode as living in `pinnace.json`, and no entry describes `/sites/<id>` as the content CID directly.
- [ ] The wording matches what the sibling tasks actually landed (verified against the code), not the spec's intent.

## Blocked by

- Blocked by `config-drop-sites-and-make-optional` and `onbox-loop-reads-metadata-ensname-warming` (so the glossary documents the final landed behaviour: config infra-only, ensName from MFS metadata driving warming).

## Prompt

> Goal: re-pin the `CONTEXT.md` glossary to the reshaped model so terms are not re-forked against the old config-first framing. Docs-only, done LAST. Read the spec `sites-metadata-in-mfs` and the landed sibling tasks (wrapper layout, deploy/pin write metadata, on-box ensName warming, config shrink), and CHECK the code as it actually stands.
>
> Update `id` (MFS home is now the wrapper `/sites/<id>/{content,metadata.json}`), `ensName` (optional MFS `metadata.json` field driving the three-way eth.limo warming, not a config field), `mode` (MFS metadata, not config), and `gateway warming`/`pin` (`/sites/<name>/content`, not `/sites/<name>` = content). Add a `metadata` note and state `pinnace.json` is infra-only + optional. Match what LANDED, not the spec's intent; leave ADR-frozen decisions alone. Done means the glossary describes the MFS-first model coherently.
