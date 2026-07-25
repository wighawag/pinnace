---
'pinnace': patch
---

Fix boot-blocking bugs in the emitted cloud-init found on a fresh Debian 13 box:

1. **`Provide.Interval` is not settable on Kubo 0.38.1** (`ipfs config` errors "not found / maybe use --json" even WITH `--json`), so setting it aborted `ipfs-setup.sh` under `set -e`, leaving the box half-provisioned. It is optional with a built-in default, so the generator no longer emits it (only `Provide.Strategy` is set).

2. **The daemon crashed with "denylists: permission denied".** Kubo's nopfs plugin reads `$HOME/.config/ipfs/denylists`; with `HOME` unset in the systemd unit it fell back under `/home/ipfs`, which `ProtectHome=true` hides. Added `Environment=HOME=/var/lib/ipfs` so the lookup stays inside the writable datadir.

3. **`226/NAMESPACE` crash-loop** when `/var/lib/ipfs` was missing at unit start (the hardened unit's `ReadWritePaths=/var/lib/ipfs` fails namespace setup). Added `ExecStartPre=+/usr/bin/install -d -o ipfs -g ipfs /var/lib/ipfs` to guarantee the datadir before the sandboxed daemon starts.

Snapshot/invariant tests guard all three.
