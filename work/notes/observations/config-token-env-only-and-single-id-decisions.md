---
title: Decisions — token env-only (lazy failure) + single site `id` (subsumes unify-ipns-key-name-convention)
date: 2026-07-24
status: open
---

Durable record of the in-scope decisions made while building
`config-token-env-only-and-single-site-id` (linked from its done record). All
three are also captured at their code site (config-resolution.ts module JSDoc /
the changeset) — this note is the discoverable home.

## Decisions

1. **Token failure is LAZY, not eager.** `resolveConfig` does NOT demand a token
   for every configured host up front. Instead `resolveHostToken({hostName, env,
   cli})` resolves ONE host's token (precedence `CLI > env`, no file layer) at the
   moment an operation (deploy/status) actually builds that host's client, and
   throws `MissingHostTokenError` naming the exact env var if unresolved. Rationale:
   a host no operation touches must not block unrelated work; the loud failure
   still fires the instant a used host lacks a token. Alternative considered:
   eager validation of every host at resolve time — rejected because it would fail
   a run over an unused host. TOUCHES: `deploy` and `status` in `cli/run.ts` (both
   now catch `MissingHostTokenError` and exit 1 with the named var); any future
   verb that builds a host client must call `resolveHostToken` the same way.

2. **Empty-string token counts as unresolved.** `resolveHostToken` treats both
   `undefined` and `""` as missing (loud error), so a `PINNACE_HOST_X_TOKEN=` in
   the env cannot become a silent empty bearer / 401. TOUCHES: the token env
   contract only.

3. **The keystore key name IS the single site `id`.** With one `id` used as both
   the MFS entry and the KDF input, deploy's publish lookup (`k.Name === id`) and
   key-import's import name (`keyName = id`) agree BY CONSTRUCTION — there is no
   longer a `name` vs `keyId` split for them to disagree on. This SUBSUMES the
   staged task `unify-ipns-key-name-convention` (whose whole job was reconciling
   that split); recommend cancelling/superseding it. TOUCHES:
   `deploy` publish, `key-import`, `record-sequence` promote — all key off `id`.

## Concept coherence

`id` replaces the `name`+`keyId` pair as the site-identity term (CONTEXT.md
updated). `ensName` is DEMOTED to an optional eth.limo-warming hint (kept, not
identity). The frozen KDF (ADR-0001) is unchanged: its internal parameter is
still named `keyId`, but the config/user surface only ever passes `id` into it —
the golden-vector id for `id: 'mysite'` is asserted unchanged. The `warm`
eth.limo heuristic still keys off the MFS entry (now `id.endsWith('.eth')`);
switching it to the explicit `ensName` field is the separate ENS-demotion idea's
job, out of scope here.

Supersedes the open observations `site-name-and-keyid-default-to-one-id.md`
(resolved as one `id`, NOT keyId-defaults-to-name) for the identity surface.
