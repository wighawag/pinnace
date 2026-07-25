---
title: cloud-init — HOME unset crashes Kubo (nopfs denylists under ProtectHome), and Provide.Interval is unsettable on 0.38.1
date: 2026-07-25
status: open
reviewOf: cloud-init-generation
---

## What was observed (fresh Debian 13 box, live)

After getting past the datadir/226-NAMESPACE issue, the Kubo daemon still
crash-looped, this time with:

```
ERROR core: constructing the node: ... failed to build *nopfs.Blocker:
error walking /home/ipfs/.config/ipfs/denylists:
lstat /home/ipfs/.config/ipfs/denylists: permission denied
Error: constructing the node (see log for full detail): ... permission denied
status=1/FAILURE
```

And separately, `ipfs config Provide.Interval "12h"` (and `ipfs config --json
Provide.Interval '"12h"'`) BOTH error:

```
Error: failed to set config value: Provide.Interval not found (maybe use --json?)
```

## Root causes (two independent bugs)

1. **HOME unset in the systemd unit.** Kubo's nopfs plugin resolves
   `$HOME/.config/ipfs/denylists`. The `ipfs.service` unit set `IPFS_PATH` but
   NOT `HOME`, so it fell back under `/home/ipfs` — which `ProtectHome=true`
   (hardening) HIDES, so the walk hits "permission denied" and the daemon dies
   at startup. Setting `Environment=HOME=/var/lib/ipfs` (the ipfs user's home,
   inside `ReadWritePaths`) fixes it: the denylists path is then readable/creatable.
   `Provide.Strategy all` sets fine; the crash was purely HOME/ProtectHome.

2. **`Provide.Interval` is not a settable config path on Kubo 0.38.1.** `ipfs
   config Provide.Interval …` errors "not found (maybe use --json?)" even WITH
   `--json` — so the earlier "add --json" fix was wrong; the key simply cannot be
   set this way on this build. Under `set -e` it aborted `ipfs-setup.sh`. It is
   OPTIONAL with a built-in default, so the generator must NOT emit it at all
   (only `Provide.Strategy` is set).

## Fix (shipped in the generator)

- Add `Environment=HOME=/var/lib/ipfs` to the `ipfs.service` unit.
- Remove the `cfg Provide.Interval` line entirely (keep only `Provide.Strategy`).
- (Already added earlier this session: `ExecStartPre=+install -d /var/lib/ipfs`
  for the datadir, and `Provide.*` instead of the deprecated `Reprovider.*`.)
- Tests assert HOME is set, no `cfg … Provide.Interval` command is emitted, and
  the datadir ExecStartPre is present.

## Meta

This is the FOURTH distinct cold-boot bug in the cloud-init generator found only
by running a real box (Reprovider FATAL, first-boot user race, missing datadir /
226-NAMESPACE, and now HOME/denylists + unsettable Provide.Interval). The
generator's tests validate the emitted YAML TEXT but nothing validates that a
real Debian box actually BOOTS Kubo. A boot-level integration/smoke test (or a
documented manual boot checklist) would have caught all four. Worth a follow-up:
some form of provisioning boot verification, since snapshot-of-text is
structurally blind to "does systemd accept this unit / does Kubo accept this
config".

## Workaround for a box in this state

```
systemctl stop ipfs; pkill -u ipfs ipfs; sleep 2
grep -q 'Environment=HOME=' /etc/systemd/system/ipfs.service || \
  sed -i '/Environment=IPFS_PATH=/a Environment=HOME=/var/lib/ipfs' /etc/systemd/system/ipfs.service
install -d -o ipfs -g ipfs /var/lib/ipfs/.config/ipfs/denylists
systemctl daemon-reload && systemctl start ipfs
```
