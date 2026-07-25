# `pinnace pin <cid>` build decisions (2026-07-25)

Decisions recorded while building the task `pin-external-cid` (the `pin` verb for an EXTERNAL network CID). Captured here per the work contract because each one either touches another flag/verb or sets a user-visible surface, so a reviewer/human can ratify or reverse it. Linked from the done record; the vocabulary half also lives in `CONTEXT.md` (the new **pin** glossary entry) and in the `src/pin/pin-external.ts` module JSDoc.

## 1. `pin` is a THIRD verb, distinct from `deploy` and `site add` (no re-meaning)

`deploy` builds a **CAR** from LOCAL files and `dag/import`s it (the operator has the bytes); `site add` places an ALREADY-LOCAL `/ipfs/<cid>` into MFS (no fetch, no pin); `pin` takes a CID the node does NOT hold and makes Kubo FETCH + pin it, then does that same MFS placement. Recorded as a CONTEXT.md glossary entry so the trio stays distinct. Alternative considered: folding it into `site add` behind a `--fetch` flag, rejected because `site add`'s contract is explicitly "content the node already holds" (its module DESIGN NOTE) and a fetching variant would silently re-mean it. Touches: `deploy`, `site add`, the CONTEXT.md glossary.

## 2. `--host` on `pin` NARROWS a fan-out (it does not SELECT the single node)

`pin` is redundant by default (all configured nodes, like `deploy`); `--host <name>` narrows to one. That is a DIFFERENT meaning from `site <verb>`/`promote`, where `--host` selects the one node the verb acts on and is REQUIRED when several hosts are configured (the `pickHost` helper). Both readings are "which node(s)", but the default differs (all vs must-choose), so `pin` deliberately does not reuse `pickHost`. Alternative considered: making `--host` required on `pin` too, rejected because redundant pinning is the whole point of the verb. Touches: the shared `--host` flag vocabulary and `pickHost` in `src/cli/run.ts`. A future flag rename (`--only <host>`) would be the reversal.

## 3. No timeout knob and NO default timeout on `pin/add`

Kubo's `pin/add` BLOCKS while it resolves + fetches the DAG, and if nothing on the network serves the content it does not return promptly. We impose no client-side bound: a DEFAULT timeout would abort legitimately slow large-DAG pins (a user-visible failure mode worse than waiting), and an OPT-IN `--timeout` cannot actually abort the in-flight request through the current `FetchLike` seam (it takes no `AbortSignal`), so a `Promise.race` would report a timeout while the pending fetch still held the process open. What we DO give instead: a stage-tagged per-node error (`PinStageError`, stage `pin`) carrying Kubo's own message plus an explicit "is the content still retrievable" hint, so an operator sees WHY a node failed. The task scoped a timeout knob as "out of scope unless trivial"; it is not trivial. Touches: any future `--timeout` flag (it should widen `FetchLike` with an `AbortSignal` first) and the `KuboRpcClient.pinAdd` JSDoc that documents the blocking behaviour.

## 4. `--as <name>` names a site `id` (not a new identity concept)

The `<name>` in `--as <name>` IS the existing site **id** surface: it becomes the MFS entry `/sites/<name>`, so `status`/`warm`/republish discovery treat the pin exactly like a site, and if a same-named keystore key ever exists, `status` will report its IPNS id. So `pin` does not introduce a second naming concept; it reuses `placeInMfs`. Alternative considered: a second positional (`pinnace pin <cid> <name>`), rejected because the task/operator agreed on `--as` and a bare pair of opaque positionals reads ambiguously. Touches: `site add <id> <cid>` (same `/sites/<id>` convention), `site remove <id>`.

## 5. `parseArgs` gained boolean-flag support (for `--no-recursive`)

`--no-recursive` is the CLI's first value-less flag; the shared `parseArgs` was value-taking only, so it would have swallowed the following positional (`pin --no-recursive <cid>` would lose the CID). `parseArgs(argv, booleanFlags?)` now takes an optional list of value-less flag names; the default is empty, so every other verb parses exactly as before. Touches: `src/cli/run.ts` `parseArgs` (shared by all verbs). Any future boolean flag must add its name to that list.

## 6. Per-node failures carry a `stage` (`pin` | `place`)

The fan-out mirrors deploy's `allSettled` partial-failure semantics, but the per-node failure record adds `stage` so an operator can tell "the network could not give me this content" (`pin`) from "the node pinned it but could not file it under that name" (`place`). Small new surface (a `PinStageError` class + the field). Alternative considered: deploy's bare `{baseUrl, error}`, rejected because the retrievability failure is the expected one for this verb and deserves to be unambiguous.
