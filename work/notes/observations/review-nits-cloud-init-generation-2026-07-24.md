---
title: review-gate non-blocking nits for 'cloud-init-generation' (Gate 2 approve)
date: 2026-07-24
status: open
reviewOf: cloud-init-generation
---

## Non-blocking review findings

The PR/code review gate (Gate 2) APPROVED 'cloud-init-generation' but raised the
following non-blocking findings (nits). They do not block integration; this
is their durable home for triage — promote-to-task / keep / delete.

- Ratify: emitted cloud-init installs pinnace via npm global (npm install -g pinnace), assuming pinnace is a published npm package. The package is version 0.0.0 and not yet published, so a fresh box boot would fail pinnace-setup.sh until publish. Intended for v1, or should install pin a version / use another channel?
  (src/provision/cloud-init.ts pinnace-setup.sh: npm install -g pinnace; package.json version 0.0.0)
- Ratify user-visible defaults the task did not specify: Kubo v0.38.1 pin, Node 20 (nodesource), DEFAULT_GATEWAYS set, sitesDir /sites, dashboard root /var/www/ipfs-dash. Reasonable, but load-bearing operational values worth a human nod.
  (DEFAULT_KUBO_VERSION/DEFAULT_SITES_DIR/DEFAULT_GATEWAYS in cloud-init.ts)
- Ratify: Kubo API.HTTPHeaders Access-Control-Allow-Origin is set to [*] at the Kubo layer while Caddy scopes CORS to API_CORS_ORIGINS. Writes are still bearer-guarded, so low risk, but the wildcard at the Kubo layer is a security-adjacent choice the task did not specify.
  (ipfs-setup.sh: cfg --json API.HTTPHeaders.Access-Control-Allow-Origin [*])
