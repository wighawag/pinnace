---
title: cloud-init's warm comments still state the old "any .eth MFS name is warmed" rule
date: 2026-07-27
status: open
---

Spotted while working `ethlimo-warming-status-visible-and-honest`: `packages/pinnace/src/provision/cloud-init.ts` says "Any MFS entry whose name ends in .eth is ALSO warmed via eth.limo" in the generated `/etc/pinnace-node.env` (near `WARM_GATEWAYS`) and again in the `gateways` option JSDoc. That is the pre-metadata rule; since the `sites-metadata-in-mfs` work the lever is the site's `metadata.ensName` three-way rule (`resolveEnsNameToWarm`), where a `.eth` id is only the INFERENCE fallback and an `ensName: ""` opts out entirely.

Harmless (comment only, no behaviour), but it is baked into every provisioned box's env file, so an operator reading it would think a `""` opt-out cannot exist.
