---
title: Emitted cloud-init sets Kubo API Access-Control-Allow-Origin to wildcard [*]
date: 2026-07-24
status: open
reviewOf: cloud-init-generation
---

## What was observed

While building `cloud-init-generation`, the Gate-2 review noted that the emitted
cloud-init sets, at the KUBO daemon layer:

```
ipfs config --json API.HTTPHeaders.Access-Control-Allow-Origin '["*"]'
```

i.e. the Kubo RPC API advertises a wildcard CORS origin, while the Caddy reverse
proxy in front of it scopes CORS to `API_CORS_ORIGINS`. Writes to the API are
still bearer-token guarded, so the practical risk is low, but the wildcard at the
Kubo layer is a security-adjacent choice the task never specified, and it is
buried inside `review-nits-cloud-init-generation-2026-07-24.md` where a security
reviewer is unlikely to see it.

Location: `packages/pinnace/src/provision/cloud-init.ts`, the `ipfs-setup.sh`
section (`API.HTTPHeaders.Access-Control-Allow-Origin [*]`).

## Why this is a live signal (not yet verified)

The defence-in-depth question is whether the Kubo-layer wildcard should instead
mirror Caddy's scoped `API_CORS_ORIGINS`, so a misconfigured/bypassed Caddy (or
direct-to-Kubo access if the firewall ever regresses) does not leave the daemon
answering cross-origin to anyone. This has NOT been verified against the threat
model — it is a spotted, unverified signal for a human/security review to judge,
and to either ratify the wildcard (with the bearer-guard rationale recorded) or
tighten it to the scoped origin list.

## Suggested disposition

Ratify (record the wildcard + bearer-guard rationale durably, e.g. in ADR-0002's
consequences or a new ADR) OR tighten the Kubo-layer origin to match Caddy's
scoped list. If a change is wanted, it is a small follow-up task against the
cloud-init generator + its snapshot tests. Discharge this note once that decision
is captured in a self-contained artifact.
