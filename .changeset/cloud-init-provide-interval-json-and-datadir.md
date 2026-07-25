---
'pinnace': patch
---

Fix two boot-blocking bugs in the emitted cloud-init found on a fresh Debian 13 box:

1. `Provide.Interval` was set without `--json`, so `ipfs config Provide.Interval "12h"` errored ("not found, maybe use --json") and, under `set -e`, aborted the whole `ipfs-setup.sh` script, leaving the box half-provisioned (Kubo never initialised). Now emitted as `cfg --json Provide.Interval '"12h"'`.

2. If `ipfs-setup.sh` aborted before creating `/var/lib/ipfs`, the hardened `ipfs.service` (with `ReadWritePaths=/var/lib/ipfs`) failed namespace setup at startup (`226/NAMESPACE`) and crash-looped. Added `ExecStartPre=+/usr/bin/install -d -o ipfs -g ipfs /var/lib/ipfs` so the datadir is guaranteed (as root, idempotent) before the sandboxed daemon starts. Snapshot/invariant tests guard both.
