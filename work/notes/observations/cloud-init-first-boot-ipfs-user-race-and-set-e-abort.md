---
title: cloud-init first-boot bug — ipfs user missing / set -e abort leaves box half-provisioned (cloud-init still reports done)
date: 2026-07-24
status: open
reviewOf: cloud-init-generation
---

## What was observed (on a real Debian 13 Hetzner box)

Provisioned a real publisher box with the emitted cloud-init. `cloud-init status
--long` reported `status: done`, `errors: []` — but the box was HALF-PROVISIONED:
`/var/log/cloud-init-output.log` contained:

```
/usr/local/sbin/pinnace-setup.sh: line 10: pinnace: command not found
install: invalid user 'ipfs'
```

The `install: invalid user 'ipfs'` is `runcmd` step `install -d -o ipfs -g ipfs
/var/www/ipfs-dash` failing because the `ipfs` system user did not exist at that
point. Re-running `/usr/local/sbin/ipfs-setup.sh` MANUALLY afterwards completed
cleanly (created the user uid 987, downloaded Kubo to /usr/local/bin/ipfs,
initialised the node, applied all config) — so the failure was a FIRST-BOOT
ordering/abort, not a permanent one.

## Root cause (two compounding bugs)

The emitted `runcmd` order is:
1. `/usr/local/sbin/ipfs-setup.sh`  (creates the `ipfs` user via `useradd`
   INSIDE a `set -euo pipefail` script, mid-way through)
2. `systemctl enable --now ipfs.service`
3. `/usr/local/sbin/pinnace-setup.sh`  (`set -euo pipefail`; runs
   `npm install -g pinnace` -> `pinnace: command not found` -> NON-ZERO EXIT)
4. `install -d -o ipfs -g ipfs /var/www/ipfs-dash`  ("invalid user 'ipfs'")

Bug A — **`pinnace-setup.sh` is a boot-abort, not harmless noise.** It is
`set -e` and `npm install -g pinnace` fails hard (the package is unpublished —
version 0.0.0), so the script exits non-zero. Combined with `set -e`, an early
failure in the run leaves later `runcmd` steps in an inconsistent/unreached
state. (This is the same unpublished-package issue already tracked, but its
INTERACTION with `set -e` in the boot sequence makes it a correctness bug, not
just a missing on-box binary.)

Bug B — **the `ipfs` user is created too late / not guaranteed before use.** It
is created mid-`ipfs-setup.sh` (a `set -e` block that can abort before reaching
`useradd`), and a LATER step (`install -o ipfs /var/www/ipfs-dash`) depends on
it. If anything perturbs step 1's completion, step 4 hits "invalid user". The
user should be created by cloud-init's `users:` module (which runs BEFORE
`runcmd`), so no `runcmd` step can ever see a missing `ipfs` user.

Bug C (the trap) — **cloud-init reports `done` / `errors: []` despite a failed
`runcmd`.** A half-provisioned box that claims success is the worst outcome: the
operator only discovers it via a downstream "fetch failed" and has to dig into
`cloud-init-output.log`. Provisioning should FAIL LOUD (or at least surface the
failed step in `cloud-init status`).

## Impact

Kubo/Caddy did eventually work after a manual `ipfs-setup.sh` re-run, but an
unattended provision is NOT reliable: a cold boot can leave the box without the
`ipfs` user (and thus a broken dashboard dir / ownership) while reporting done.

## Suggested disposition

Fix in `cloud-init-generation` (coordinate with
`cloud-init-pinnace-install-channel`, which already owns the install block):
- Create the `ipfs` (and any service) user via cloud-init's `users:` module,
  BEFORE `runcmd`, so no step sees a missing user. (Bug B)
- Do NOT let the `pinnace` install failure abort the boot: make
  `pinnace-setup.sh` tolerate a not-yet-installable `pinnace` (`|| true` / a
  guard), OR fix the install channel so it succeeds (the sibling task). The Kubo
  daemon + firewall + Caddy must come up regardless of the pinnace-agent install.
  (Bug A)
- Consider ordering the dashboard-dir `install` to depend on the user existing,
  and/or surfacing a failed provisioning step instead of a silent `done`. (Bug C)
- Add/adjust the generator's snapshot assertions so the user-first ordering and
  the non-fatal pinnace install are locked in.

## Workaround for a box already in this state

`bash /usr/local/sbin/ipfs-setup.sh` (creates the user + finishes Kubo config),
then `systemctl enable --now ipfs.service` and
`install -d -o ipfs -g ipfs /var/www/ipfs-dash`.
