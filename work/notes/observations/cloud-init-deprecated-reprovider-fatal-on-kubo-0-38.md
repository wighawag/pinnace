---
title: cloud-init writes deprecated Reprovider.* config that FATALs the pinned Kubo v0.38.1 (daemon crash-loops)
date: 2026-07-24
status: open
reviewOf: cloud-init-generation
---

## What was observed (real Debian 13 Hetzner box)

After provisioning, the Kubo daemon CRASH-LOOPED (systemd restart counter 113+).
The daemon's own journal / a direct run showed a single FATAL cause:

```
FATAL cmd/ipfs kubo/daemon.go:518
Deprecated configuration detected. Manually migrate 'Reprovider' fields to 'Provide':
  Reprovider.Strategy -> Provide.Strategy
  Reprovider.Interval -> Provide.Interval
Remove 'Reprovider' from your config.
```

(The accompanying `failed to sufficiently increase receive buffer size` QUIC/UDP
line is a harmless warning, NOT the cause.)

## Root cause

Kubo v0.38 renamed `Reprovider.*` -> `Provide.*` and now HARD-FAILS (FATAL, exit)
at startup if the deprecated `Reprovider` keys are present. But the generator
writes exactly those deprecated keys while ALSO pinning that very Kubo version:

- `packages/pinnace/src/provision/cloud-init.ts:353-354`
  ```
  cfg Reprovider.Interval "12h"
  cfg Reprovider.Strategy "all"
  ```
- `packages/pinnace/src/provision/cloud-init.ts:133` `DEFAULT_KUBO_VERSION = 'v0.38.1'`

So the emitted cloud-init produces an internally-inconsistent, UNBOOTABLE node:
the config it applies is rejected by the Kubo it installs. Provisioning is broken
out of the box for everyone on the default version, not a one-off.

Additionally the ADR-0002 / module-doc prose (cloud-init.ts:31 and elsewhere)
still describes discoverability as `Reprovider.Interval`; the wording should
track the rename too.

## Impact

Highest-severity provisioning bug found so far: the daemon never stays up, so
NOTHING works end-to-end (Caddy returns 502; deploy fails with fetch failed).
Worse than the pinnace-install no-op, because that only disables the on-box
timers while this kills Kubo itself.

## Fix

In `cloud-init-generation`:
- Emit `Provide.Strategy` / `Provide.Interval` instead of `Reprovider.Strategy` /
  `Reprovider.Interval`, and do NOT emit any `Reprovider` block, for Kubo >= 0.38.
  (If older Kubo support is ever wanted, gate on `kuboVersion`; but the default
  pin is 0.38.1, so `Provide.*` is correct for the shipped default.)
- Update the discoverability prose in the module doc + ADR-0002 wording to
  `Provide.Interval`.
- Add/adjust the snapshot assertions to require `Provide.*` and FORBID any
  `Reprovider` key, so a regression is caught.
- Consider a provisioning-time guard: a config that the pinned Kubo rejects
  should be caught before shipping (e.g. a note to run `ipfs config` validation),
  since `cloud-init status` reported `done` despite the daemon never starting.

## Workaround for a box already in this state

```
sudo -u ipfs env IPFS_PATH=/var/lib/ipfs/.ipfs ipfs config Provide.Strategy all
sudo -u ipfs env IPFS_PATH=/var/lib/ipfs/.ipfs ipfs config Provide.Interval 12h
sudo -u ipfs env IPFS_PATH=/var/lib/ipfs/.ipfs ipfs config --json Reprovider null
systemctl restart ipfs
```
