---
title: For a no-ENS site, name and keyId are redundant — default keyId to name (one ID)
date: 2026-07-24
status: open
---

## What was observed

Surfaced while writing the live-failover runbook: the config model asks a user
for THREE per-site strings, two of which collapse for the common case.

`SiteConfig` (packages/pinnace/src/config/config-resolution.ts) has:
- `name`   — the MFS entry: `/sites/<name>` (where content lives; how warm /
  republish / status auto-discover the site).
- `keyId`  — the frozen KDF input: `HKDF(master, "pinnace:ipns:v1:" + keyId)` ->
  the `k51...` id (ADR-0001).
- `ensName` — the OPTIONAL, mutable display name (`ronan.eth`).

`name` and `keyId` genuinely answer different questions (MFS location vs
key-seed). But the ONLY reason CONTEXT.md keeps them separate is the
ENS-decoupling story: keyId is frozen/internal so the mutable ENS name can
change without shifting the IPNS id. When a user does NOT involve ENS (they just
want a stable `ipns://` id), there is no user-facing reason `name` and `keyId`
should be two different strings — yet the config today FORCES both fields even
when they'd be identical.

## Why this is a live signal (unverified)

The natural default: a user picks ONE id (e.g. `ronan.eth`, or `mysite`) that
serves as BOTH the MFS entry name AND the keyId; the two only diverge in the
advanced case where someone deliberately wants the MFS name and the frozen
key-seed to differ. Making `keyId` DEFAULT to `name` (optional override) removes
redundant required config for the common case without losing the decoupling
escape hatch. Not yet verified against every consumer (deploy publish lookup,
node republish, status) — needs a check that defaulting keyId=name does not
collide with the `unify-ipns-key-name-convention` follow-up (which is separately
reconciling what string names the keystore key).

## Suggested disposition

A small config/UX task: make `keyId` optional in `SiteConfig`, defaulting to
`name`; keep it overridable for the ENS-divergence / advanced case; document the
"one ID" default. Coordinate with `unify-ipns-key-name-convention` (same key-name
surface). Discharge this note once that task is minted or the split is ratified
as intended.
