---
title: build decisions for 'pin-external-cid-ipns-mode' (pinnace pin --mode ipns)
date: 2026-07-25
status: open
reviewOf: pin-external-cid-ipns-mode
---

# `pinnace pin --mode ipns` build decisions (2026-07-25)

Decisions recorded while building the task `pin-external-cid-ipns-mode` (`--mode ipns` on the `pin` verb). Captured here per the work contract because each one either touches another verb/flag or sets a user-visible surface, so a reviewer/human can ratify or reverse it.

Where this note is referenced from (so it is discoverable without trusting a claim): the `src/pin/pin-external.ts` module JSDoc names it by path, and the completion report links it. The vocabulary half also lives in `CONTEXT.md` (the amended **mode** and **pin** entries) and in the `src/publisher/ipns-publish.ts` module JSDoc.

## 1. `mode` is REUSED, not re-meant: one concept, two carriers (site and pin)

`--mode ipfs|ipns` on `pin` is the SAME concept `deploy` and `pinnace.json` sites already carry (`SiteMode`), with the same meaning in both (`ipns` = the publisher additionally signs `name/publish` under the master-derived key named by the single `id`); the only difference is the carrier (a configured site vs a single pin invocation). `CONTEXT.md`'s `mode` entry was amended to say so explicitly, so a later author cannot fork a second mode vocabulary. Alternative considered: a distinct flag (e.g. `--publish` / `--ipns`) to avoid overloading `mode`, rejected because it would create two names for one decision and would not compose with the config-file `mode` an operator already knows. Touches: `deploy --mode`, `SiteConfig.mode`, the CONTEXT.md `mode` glossary entry.

## 2. `pin --mode` does NOT read a `pinnace.json` site entry's mode (deploy does)

`deploy` resolves a site's mode as `--mode > the matching site entry`, and ERRORS when neither supplies it. `pin` instead DEFAULTS to `ipfs` and never consults `cfg.sites`. Rationale: a pinned external CID is not necessarily a configured site (usually it is not), the task pins the default as "`--mode ipfs` unchanged", and publishing a name is exactly the kind of act that should require the operator to say so on the command line. Consequence to ratify: if an operator DOES add a `sites` entry whose `id` equals the pin name with `mode: ipns`, `pin` still will not publish unless `--mode ipns` is passed (though the on-box `republish` timer WILL sign that MFS entry on the publisher, since it keys off the keystore, not the config). Alternative considered: mirroring deploy's resolution, rejected as a silent user-visible publish. Touches: `deploy`'s mode resolution, `SiteConfig.mode`, the on-box `republish` discovery.

## 3. The shared publish seam: `key/list` + `name/publish` moved to ONE home

The task said reuse deploy's ipns branch, do not fork it. Deploy's publish path was a private function with its own `RECORD_LIFETIME`/`RECORD_TTL` copy, and the on-box `republish` op had a second copy of the same `name/publish` parameter set. Rather than adding a THIRD copy for `pin`, both calls now live in the new `src/publisher/ipns-publish.ts` (`lookupIpnsKeyId`, `publishSiteRecord`, and the single home of the lifetime/ttl constants, which `record-sequence.ts` re-exports so its public API is unchanged). Deploy and the on-box republish op were rewired to it with identical behaviour (their tests are untouched and green). What is deliberately NOT shared is the POLICY around those two calls: deploy SKIPS the publish when the publisher holds no key (key provisioning is not deploy's job), while `pin --mode ipns` IMPORTS the derived key first (the operator just asked for that name). Touches: `src/deploy/deploy.ts`, `src/publisher/record-sequence.ts`, the exported `RECORD_LIFETIME`/`RECORD_TTL`, and any future publish caller.

## 4. `PinTarget` gained an OPTIONAL `role`; a role-less target cannot sign

`PinTarget` previously had no `role` (its JSDoc called one "meaningless ceremony", since nothing was signed). In `ipns` mode the role IS load-bearing, so it is now an optional field: absent in `ipfs` mode (where it means nothing) and required-in-practice for `ipns`. A target whose role the caller left UNSTATED is treated as unable to sign, the safe reading (never hand a signing key to a box whose role nobody stated). The previously-noted question "should `PinTarget` and `DeployTarget` share a base type?" (review nit on `pin-external-cid`) is still open and still NOT done here: a pin has no CAR and no per-target `publish` switch, because `--mode ipfs` is how an operator pins without publishing. Touches: `DeployTarget` (the sibling shape), `HostRole`, the open review nit about a shared node-target base.

## 5. A new LOUD refusal: `PinPublisherRequiredError` (and its CLI twin)

`--mode ipns` with no publisher among the targets is an ERROR, not a pin-without-a-name, and it is raised BEFORE any node is touched so a refusal never leaves a half-done pin. It exists at two layers on purpose: the core throws `PinPublisherRequiredError` (guarding library callers, listing the roles it was offered), and the CLI pre-checks the selected hosts so its message can name the HOSTS the operator typed (`b (replica)`) rather than anonymous roles. This mirrors `KeyImportRoleError`'s stance (refuse a wrong-role key import) one layer up. Alternative considered: only the core check, rejected because the core does not know host names; only the CLI check, rejected because `pinExternal` is a public library export. Touches: `KeyImportRoleError` (same refusal family), `runPin`, any future non-CLI caller of `pinExternal`.

## 6. `PinStage` gained a third value, `publish`

Per-node failures already named their stage (`pin` | `place`); an ipns publish failure is now `publish`, so an operator can tell "the content is pinned but the NAME did not move" from a failed fetch or MFS placement. Consequence: a publisher whose publish fails is counted as a FAILED node even though it holds the pin, so with a healthy replica the overall result can still be `success: true` with the name un-updated (deploy's partial-failure semantics, unchanged). Touches: the `PinStage` union (a public type), the CLI's per-node `FAIL <url> (<stage>)` line.

## 7. The reported id prefers the NODE's answer, falling back to the derived id

`result.ipns` is whatever the publisher says the key resolves to (`key/list`, or the `key/import` response), falling back to the locally derived `ipnsId` when the node's response carries no id. They are the same value by construction (one master + one id = one name, ADR-0001), and the fallback means the operator is never left without the name they can already compute with `pinnace derive <name>`. Touches: `derive`/`promote` (the same golden id), the printed `ipns://<id>`.
