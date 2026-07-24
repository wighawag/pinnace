---
title: provision should read hosts from pinnace.json; name the bearer token's two roles
date: 2026-07-24
---

## Two related signals (surfaced while wiring the live-failover runbook)

Both come from the same friction: setting up a real deployment, you specify each
host TWICE, and the bearer token silently plays two different roles that nothing
in the model names.

### 1. `provision` re-takes host values that a `pinnace.json` host entry already carries

`deploy` / `status` / `derive` read hosts from `pinnace.json` (endpoint, token,
role, publisherEndpoint) via the config resolver. But `provision` is purely
arg-driven and does NOT read the file — its JSDoc says "provisioning inputs are
per-box and not stored in pinnace.json." So an operator declares a host once in
`pinnace.json` (for deploy/status) and AGAIN on the `provision` command line
(`--api-domain`, `--bearer-token`, `--role`, `--publisher-endpoint`). Those
overlap heavily with the host entry's `endpoint` / `token` / `role` /
`publisherEndpoint`.

Proposal: let `provision --host hetzner <hostName>` OPTIONALLY resolve a named
host from `pinnace.json` + env (same resolver as deploy), so the shared values
(role, token, the api domain derived from/aligned with `endpoint`,
publisherEndpoint) come from the file, and only the genuinely provision-ONLY
inputs stay as flags: `--acme-email` and anything host-provider-specific. Keep
the current all-flags form working (provision with no config file must still
work). This removes the "specify each host twice" seam.

Caveat: some provision inputs have NO home in the current `HostConfig`
(`acmeEmail`, dashboard domain). Either add optional provision fields to the host
schema or keep those as flags. Decide during design.

### 2. The bearer token has TWO ROLES the model does not name

The SAME token string is used in two different environments for two different
reasons, and nothing documents the split:

- **Server-side ("the credential the box DEMANDS").** At provision,
  `--bearer-token` is baked into the emitted cloud-init as `RPC_BEARER_TOKEN`,
  wired into Kubo `API.Authorizations` (`AuthSecret: "bearer:${RPC_BEARER_TOKEN}"`).
  This lives ON THE BOX; it says "callers must present this."
- **Client-side ("the credential the caller PRESENTS").** At runtime,
  `PINNACE_HOST_<NAME>_TOKEN` (env) / the host entry's `token` is what
  deploy/status/the live test send as `Authorization: Bearer <token>`. This
  lives on the OPERATOR's machine.

They are the same value but conceptually distinct (server credential vs client
credential), present in different places at different times. The config model
treats it as one opaque `token`, so a user reasonably wonders "is the token I put
in .env the same one that goes on the box?" (it is). Naming/documenting the dual
role — and, if provision reads the config (signal 1), making the "same token,
two roles" flow explicit and single-sourced — removes that confusion.

## Also relevant: value LIFECYCLES (a documentation gap)

The runbook naturally sorted every value into three lifecycles the docs don't
spell out:
- **Provision-time-only, non-secret** (goes INTO the box once, inert after boot):
  `api-domain`, `acme-email`, `role`, `publisher-endpoint`.
- **Client runtime secret** (stays on the operator's laptop): `PINNACE_MASTER`,
  the two `PINNACE_HOST_*_TOKEN`s (also provisioned into the box in their
  server-side role).
- **Non-secret structure** (`pinnace.json`, commit-safe): host endpoints, roles,
  publisherEndpoint, site name/keyId/mode/sourceDir.

A short "config & secrets" doc/section stating this split would prevent the
"which value goes where / is it secret / is it needed at runtime" confusion.
`ACME_EMAIL` in particular is provision-only + non-secret, so it should NOT be a
runtime `.env.local` resident.

## Why an IDEA, not a silent edit

Making `provision` read `pinnace.json` changes a shipped command's input model
(and its JSDoc contract that says provision inputs are NOT stored in the file),
and possibly extends the `HostConfig` schema. That is a design change to flow
through the spec/tasking lifecycle, not a runbook-time edit. Promote to a task
(and a short config-&-secrets doc) when ready. Coordinates with
`unify-ipns-key-name-convention` and `site-name-and-keyid-default-to-one-id`
(same config surface).
