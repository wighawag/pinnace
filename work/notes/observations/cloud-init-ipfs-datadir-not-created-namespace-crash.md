---
title: cloud-init — /var/lib/ipfs never created (users: module doesn't mkdir home), Kubo crash-loops 226/NAMESPACE
date: 2026-07-25
status: open
reviewOf: cloud-init-pinnace-install-channel
---

## What was observed (fresh Debian 13 box, pinnace@0.3.0 cloud-init)

Kubo crash-looped with `status=226/NAMESPACE`:

```
ipfs.service: Failed to set up mount namespacing: /var/lib/ipfs: No such file or directory
ipfs.service: Failed at step NAMESPACE spawning /usr/local/bin/ipfs
Error: no IPFS repo found in /var/lib/ipfs/.ipfs. please run: 'ipfs init'
```

`/var/lib/ipfs` did not exist at all. The systemd unit's `ReadWritePaths=/var/lib/ipfs`
(hardening) then fails namespace setup before Kubo even runs, so the daemon
crash-loops and every API call returns 502 through Caddy.

## Root cause — a REGRESSION from the boot-safety `users:` change

The `cloud-init-pinnace-install-channel` task moved `ipfs` user creation from
mid-`ipfs-setup.sh` (`useradd --create-home --home-dir /var/lib/ipfs`, which
CREATED the dir) to cloud-init's `users:` module. But the `users:` module with
`home: /var/lib/ipfs` does NOT create the home DIRECTORY (cloud-init does not
mkdir a system user's home by default). So:

1. `users:` creates the `ipfs` user but NOT `/var/lib/ipfs`.
2. In `ipfs-setup.sh`, the `useradd --create-home` (the old dir-creator) is now
   SKIPPED because `if ! id ipfs` is false (the user already exists).
3. The later `install -d -o ipfs -g ipfs /var/lib/ipfs` + `ipfs init` should still
   create it — but on the observed box `/var/lib/ipfs` was absent, meaning
   `ipfs-setup.sh` ABORTED before line ~416 (`set -euo pipefail`; likely the Kubo
   download / `ipfs --version` step), and unlike `pinnace-setup.sh` it has no
   `|| true` guard, so its failure silently left the box without the datadir.

So the boot-safety fix traded the "user missing" race for a "datadir missing"
one: `useradd --create-home` used to guarantee `/var/lib/ipfs`; the `users:`
module does not, and nothing else reliably creates it before the systemd unit
starts.

## Fix (generator, in cloud-init.ts)

- Guarantee `/var/lib/ipfs` exists + is owned by `ipfs` BEFORE the `ipfs.service`
  can start, independent of whether `ipfs-setup.sh` completes: either add
  `create_home: true` semantics (cloud-init won't reliably do it for a system
  user, so prefer a `runcmd`/bootcmd `install -d -o ipfs -g ipfs /var/lib/ipfs`
  ordered before `systemctl enable --now ipfs.service`), OR move that mkdir to
  the very top of `ipfs-setup.sh` before any `set -e`-abortable step.
- Make `ipfs-setup.sh` robust: mkdir the datadir FIRST; do not let a transient
  Kubo-download failure leave the box without an initialised repo. Consider the
  same non-fatal-with-retry treatment, or at least ordering so the datadir + a
  guard exist before the service is enabled.
- Consider: the systemd unit `ReadWritePaths=/var/lib/ipfs` requires the path to
  EXIST at unit start; pair the unit with a guaranteed-present datadir (or a
  `RequiresMountsFor`/`ExecStartPre=install -d`).
- Add a test/invariant asserting the emitted cloud-init creates `/var/lib/ipfs`
  (owned by ipfs) before enabling `ipfs.service`.

## Workaround for a box in this state

```
install -d -o ipfs -g ipfs /var/lib/ipfs
bash /usr/local/sbin/ipfs-setup.sh     # creates repo + applies config
systemctl restart ipfs
```
