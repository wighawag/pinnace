---
title: Resolve the eth.limo warming from ensName (explicit > .eth-suffix inference > empty-string opt-out)
slug: ensname-resolution-and-eth-opt-out
spec: pinnace
covers: [15]
---

## What to build

Make the eth.limo (and eth.link) gateway warming key off the `ensName` field with a clear, three-way resolution, fixing a real inconsistency and adding an opt-out.

Current bug/inconsistency: `SiteConfig.ensName` is DOCUMENTED as "the optional eth.limo-warming hint" (config-resolution.ts), but the warming code IGNORES the field and instead keys off the MFS `id` SUFFIX: `if (site.id.endsWith('.eth')) warm https://<id>.limo` (node-commands.ts). So the field does nothing, and the behaviour is tied to the id name rather than the explicit hint. Resolve it to the operator's decided model:

1. **`ensName` explicitly set (non-empty)** -> warm `https://<ensName>.limo` (and eth.link if that is included). This is the authoritative hint; it does NOT have to match the id.
2. **`ensName` NOT set AND the site `id` ends in `.eth`** -> INFER `ensName = id` and warm `https://<id>.limo`. (Convenience: a site simply named `ronan.eth` gets eth.limo warming with no extra config — the common case.)
3. **`ensName` set to the EMPTY string (`""`)** -> explicit OPT-OUT: do NOT warm eth.limo/eth.link even if the `id` ends in `.eth`. (For an operator who names a site `*.eth` but does not want the ENS gateways warmed.)
4. `ensName` unset and the `id` does NOT end in `.eth` -> no eth.limo warming (unchanged).

So the precedence is: explicit non-empty `ensName` (warm it) > explicit `""` (opt out) > `.eth`-suffix inference (warm the id) > nothing.

This is the sanctioned resolution of the ENS-demotion idea (`work/notes/ideas/drop-ens-from-pinnace-model.md`), which already recorded that the `.eth`-suffix heuristic should become the explicit `ensName` field: identity (the `id`) stays decoupled from ENS warming, and `ensName` becomes the real lever it was documented to be. Update the on-box `warm` verb to resolve via this rule (not the bare id suffix), and update the `ensName` field doc + CONTEXT.md to describe the three-way resolution including the `""` opt-out.

Note the empty-string subtlety: `ensName: ""` must be DISTINGUISHABLE from `ensName` UNSET (undefined). Unset => fall through to inference; `""` => opt out. Ensure the config parse preserves that distinction (do not coerce `""` to undefined).

## Acceptance criteria

- [ ] eth.limo warming resolves from `ensName` per the four cases: explicit non-empty warms `<ensName>.limo`; unset + `.eth` id infers and warms `<id>.limo`; `""` opts out (no eth warming even for a `.eth` id); unset + non-`.eth` id does nothing.
- [ ] `ensName: ""` (opt-out) is distinguished from `ensName` unset (infer) — the config layer preserves the empty string, not coerced to undefined.
- [ ] The on-box `warm` verb uses this resolution, NOT the bare `id.endsWith('.eth')` heuristic; the id/identity is no longer what triggers ENS warming (only the resolved ensName is).
- [ ] The `ensName` field doc + CONTEXT.md describe the three-way resolution (explicit > empty-opt-out > .eth inference); the inconsistency (documented-as-hint but ignored) is gone.
- [ ] Test-first: cases for explicit ensName, .eth inference, empty-string opt-out, and non-.eth no-op, at the warm seam (mock/fake gateway layer); no live network.

## Blocked by

- None — `node-agent-commands` (the `warm` verb) and `config-resolution` (`ensName`) are in `tasks/done/`. Discharges the eth-warming half of `work/notes/ideas/drop-ens-from-pinnace-model.md`.

## Prompt

> Goal: make eth.limo warming resolve from the `ensName` field with a three-way rule (explicit non-empty warms `<ensName>.limo`; unset + `.eth` id infers `ensName=id`; `ensName: ""` opts out even for a `.eth` id; unset + non-`.eth` does nothing), fixing that `ensName` is documented as the warming hint but the code actually keys off `id.endsWith('.eth')`. Read `work/notes/ideas/drop-ens-from-pinnace-model.md` (this is its sanctioned resolution), the done tasks `node-agent-commands` (the `warm` verb) + `config-resolution` (`ensName`), and CONTEXT.md. Preserve the `""`-vs-undefined distinction in config parse (opt-out vs infer). Update the warm verb, the `ensName` doc, and CONTEXT.md. Test-first at the warm seam (explicit / inferred / empty-opt-out / non-.eth), no live network. Done means `ensName` is the real, documented lever, a `.eth`-named site gets eth.limo warming automatically, and `ensName: ""` cleanly opts out.
