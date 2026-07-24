---
title: Unify the IPNS key-name convention across key-import, deploy publish, and the CLI
slug: unify-ipns-key-name-convention
spec: pinnace
blockedBy: []
covers: [9, 11]
---

## What to build

Close a real latent cross-task mismatch surfaced by the Gate-2 review of `deploy-multi-target` and `key-import-publisher`: the two seams disagree about what STRING names an IPNS key in a Kubo node's keystore, and if the CLI binds them with different strings, `deploy` will SILENTLY skip publishing.

Concretely (observed while building):
- `deploy` resolves the publish key by exact match `keys.Keys.find(k => k.Name === name)`, where `name` in its test is the site's ENS name (`mysite.eth`).
- `key-import-publisher` imports the key under a caller-supplied `keyName`, whose test uses the bare `mysite`.
- The domain model (CONTEXT.md `keyId` vs `ENS name`, spec user story 9) DELIBERATELY decouples the frozen internal `keyId` from the mutable ENS name. So neither "the ENS name" nor "the bare site name" is obviously the right keystore key name, and the two tasks each picked one independently.

Pick ONE keystore-key-name convention and make BOTH seams (and the CLI that will wire them) use it. The natural candidate is the site's stable identifier that does NOT drift with the ENS name (i.e. keyed off `keyId` or the site `name`, never the mutable ENS name), consistent with the frozen-derivation ADR (0001) and story 9's decoupling. Whatever is chosen, deploy's `key/list` lookup and key-import's import name MUST agree, and a test must prove that a key imported by `key-import` is FOUND by `deploy`'s publish lookup (no silent skip).

## Acceptance criteria

- [ ] A single documented convention for the keystore key name is defined and used by BOTH the key-import path and the deploy publish lookup (they no longer pick independently).
- [ ] The convention keys off a stable identifier (site `name`/`keyId`), NOT the mutable ENS name, consistent with ADR-0001 + spec story 9 (keyId/ENS decoupling).
- [ ] A test proves round-trip agreement: a key imported under the convention is FOUND by deploy's `key/list` publish lookup, so `ipns`-mode deploy actually publishes (no silent `published:false` skip due to a name mismatch).
- [ ] The convention is recorded (a `## Decisions` note or an ADR if it meets the bar) and linked from the done record.
- [ ] Tests run against the mock Kubo API (no live daemon / shared location).

## Blocked by

- None — `deploy-multi-target` and `key-import-publisher` are already in `tasks/done/`; this reconciles the two.

## Prompt

> Goal: unify the IPNS keystore key-name convention so `deploy`'s publish lookup and `key-import`'s import name AGREE, closing a silent-skip-publish risk found in Gate-2 review. Read CONTEXT.md (`keyId`, `ENS name`, `publisher`), ADR-0001 (frozen derivation, keyId is internal and untied from the ENS name), and spec user stories 9 + 11.
>
> The mismatch (from `work/notes/observations/review-nits-deploy-multi-target-2026-07-24.md`): `deploy` finds the publish key via `k.Name === name` with `name` = ENS name in its test; `key-import` imports under a caller-supplied name that its test sets to the bare site name. If the CLI later passes different strings, `key/list` finds no match and deploy lands+pins but SILENTLY does not publish (`published:false`).
>
> Decide the single convention (prefer a stable id off `name`/`keyId`, never the mutable ENS name, per ADR-0001 + story 9), apply it to both seams, and add a round-trip test proving an imported key is found by deploy's lookup. Record the decision durably and link it from the done record. Test at the mock Kubo RPC seam. Done means the two seams provably agree and `ipns`-mode deploy cannot silently skip publishing due to a name mismatch.
