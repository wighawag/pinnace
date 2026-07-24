---
title: Config cleanup — token env-only (never in config), and a single site `id` (remove name + keyId)
slug: config-token-env-only-and-single-site-id
spec: pinnace
blockedBy: []
covers: [9, 10, 19]
---

## What to build

Two decided config-model corrections (owner decisions, 2026-07-24), both in the `config-resolution` layer + its consumers. They remove real footguns found while wiring the live-failover runbook.

### 1. `token` is ENV-ONLY — NEVER a config-file field (exactly like the master secret)

Today `HostConfig.token: string` is a REQUIRED field, so a token (or a `""` placeholder) sits in `pinnace.json`, and the resolver does `env ?? file.token`. Wrong on two counts: a bearer token is a SECRET and must never live in the config file AT ALL (not even `""`); and a missing token silently resolves to `""` and produces a confusing 401 from the box instead of a clear config error.

The bearer token is the SAME CLASS as the master secret, which pinnace already treats as ENV-ONLY BY CONSTRUCTION (`resolveMasterSecret` has no file path; a `master` field in `pinnace.json` is provably ignored). Give the token the identical treatment:

- REMOVE `token` from `HostConfig` / the `pinnace.json` schema ENTIRELY. There is no token field to read from the file — structurally impossible to leak a token via config, exactly as with the master. A stray `token` in a file fixture MUST be IGNORED (assert this, mirroring the master-decoy test).
- Resolve the token ONLY from `CLI > env(PINNACE_HOST_<NAME>_TOKEN)`. If unresolved, FAIL LOUD with a precise message naming the exact env var, e.g. `host 'publisher' has no token; set PINNACE_HOST_PUBLISHER_TOKEN`. No silent `""`, no downstream 401.
- Whether the loud failure fires eagerly for every host at resolve time, or lazily only for hosts an operation actually uses, is a design choice — decide during build and record it (a host no operation touches arguably should not block). State the rule in the message + a Decisions note.

### 2. A single site `id` — REMOVE both `name` and `keyId`

A site is identified by ONE value: `id`. Remove BOTH `name` and `keyId` from `SiteConfig` and replace them with a single `id`. That `id` is used as BOTH:
- the MFS entry (`/sites/<id>`), and
- the KDF input fed to the frozen derivation.

This is NOT "keyId optional, defaulting to name" — it is the removal of the two-concept surface. A user picks ONE `id`; there is no separate `name`, no separate `keyId`, no defaulting dance.

- `SiteConfig` becomes `{ id, mode, sourceDir, ensName?, externalKey? }`. `ensName?` STAYS — it is the OPTIONAL eth.limo-warming hint (see the ENS idea note): NOT part of identity and NOT a derivation input, but when set the site is ALSO warmed via `https://<ensName>.limo`. Only `name` and `keyId` are removed and merged into `id`. (`token` is gone per part 1 and was never a site field.)
- The frozen derivation scheme is UNCHANGED (ADR-0001, golden vectors): `deriveIpnsKey` still takes a string KDF input internally (its parameter may keep the internal name `keyId`), but the CONFIG/USER surface passes `id` into it. Only the surface changes, not the KDF.
- Update every SITE-`name` consumer to `id`: the config schema, the CLI `deploy <dir> <id>` positional + the `--key-id` flag (collapses into the single `id`, drop `--key-id`), the `derive` verb (derives from `id`), the site lookup in run.ts (`cfg.sites.find(s => s.id === …)`), deploy's MFS placement (`/sites/<id>`), status, warm, and site-management list/remove/add. NOTE: distinguish the config-surface site `name` (which becomes `id`) from the operational `name` fields on internal RESULT/CONTEXT types (`SiteOutcome.name`, `DeploySiteResult.name`, …) — rename those to `id` too for coherence, but they are the value flowing through, not the config surface.

## Acceptance criteria

- [ ] `token` is REMOVED from `HostConfig` / the `pinnace.json` schema entirely (env-only by construction, like the master). A `token` field placed in a `pinnace.json` fixture is IGNORED and never surfaces from the resolver (a test asserts this, mirroring the master-decoy test).
- [ ] The token resolves ONLY from `CLI > env(PINNACE_HOST_<NAME>_TOKEN)`. A host with no resolvable token causes a LOUD, specific error naming the missing env var — never a silent empty token / downstream 401.
- [ ] The eager-vs-lazy rule for the token failure is decided and recorded (a Decisions note / JSDoc), with tests for the loud-failure path AND env-only resolution.
- [ ] `SiteConfig` uses a single `id`; BOTH `name` and `keyId` are removed from the site config surface. A site is declared with one `id` used as both the MFS entry (`/sites/<id>`) and the KDF input.
- [ ] The CLI reflects the single id: `deploy <dir> <id>`, `derive --id <id>` (or positional), site lookups key on `id`; the separate `--key-id` flag is removed.
- [ ] The frozen derivation scheme + golden vectors are UNCHANGED (ADR-0001 untouched): the same `id` string, fed as the KDF input, yields the pinned golden id (a test asserts an `id`-declared site derives the golden-vector id).
- [ ] Every site-`name` consumer (deploy MFS placement, status, warm, site-management, CLI) is updated to `id`; the config-surface change is complete (no lingering required `name`/`keyId` on `SiteConfig`).
- [ ] `ensName?` is RETAINED on `SiteConfig` as the optional eth.limo-warming hint (not removed, not part of `id`, never an input to derivation).
- [ ] CONTEXT.md is updated: the `keyId`/`name` split is replaced by a single site `id` (the one value that is both the MFS entry and the KDF input); `ensName` is documented as the optional eth.limo-warming hint; the schema docs match.
- [ ] Tests isolate env (explicit env record, no real `process.env` / real `pinnace.json` read) and cover both changes.

## Blocked by

- None — `config-resolution` is in `tasks/done/`; this refines it. Coordinate with `unify-ipns-key-name-convention` (the key-name surface — the single `id` IS the resolution of that convention question) and the ENS-demotion idea (same site-identity surface). If `unify-ipns-key-name-convention` has not landed, this task SUBSUMES it (one `id` means deploy's publish lookup and key-import's key name are the same `id` by construction) — note that in the done record and cancel/supersede the sibling task if appropriate.

## Prompt

> Goal: two decided config-model corrections in `config-resolution` + its consumers. Read CONTEXT.md (`config resolution`, `keyId`, `master key`), ADR-0001 (frozen KDF — do NOT change it), and the done task `config-resolution`.
>
> (1) TOKEN env-only: REMOVE `token` from `HostConfig` / the `pinnace.json` schema ENTIRELY — the token is env-only BY CONSTRUCTION, exactly like the master (`resolveMasterSecret` has no file path). No token field to read from the file; a `token` in a file fixture is IGNORED (mirror the master-decoy test). Resolve ONLY from `CLI > env(PINNACE_HOST_<NAME>_TOKEN)`; if unresolved, FAIL LOUD naming the exact missing env var (no silent `""`, no 401). Decide eager-vs-lazy failure and record it.
>
> (2) SINGLE `id`: REMOVE both `name` and `keyId` from `SiteConfig`; replace with ONE `id` used as BOTH the MFS entry (`/sites/<id>`) and the KDF input. This is a removal of the two-concept surface, NOT keyId-defaults-to-name. `SiteConfig` -> `{ id, mode, sourceDir, ensName?, externalKey? }` — KEEP `ensName?` (the optional eth.limo-warming hint; not identity, not a derivation input). The frozen KDF is UNCHANGED — `id` is fed as the derivation input; assert an `id`-declared site derives the pinned golden-vector id. Update every site-`name` consumer (CLI `deploy <dir> <id>` + `derive`, drop `--key-id`; deploy MFS placement; status; warm; site-management; and the operational result/context `name` fields) to `id`.
>
> Update CONTEXT.md (single site `id`, replacing the `keyId`/`name` split). Test-first, env isolated. Record in-scope decisions durably and link from the done record. Done means: the token cannot appear in `pinnace.json` at all (env-only like the master; missing token = loud named error), and a site is one `id` (no `name`, no `keyId`) that is both the MFS entry and the KDF input, with `ensName?` retained as the optional eth.limo-warming hint and the frozen derivation unchanged.
