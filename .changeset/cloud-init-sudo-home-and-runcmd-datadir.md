---
'pinnace': patch
---

Fix the ROOT cause of the fresh-box Kubo crash-loop: `ipfs-setup.sh` ran `ipfs init` / `ipfs config` via `sudo -u ipfs env IPFS_PATH=…` WITHOUT passing `HOME`. `sudo` does not inherit `HOME`, so `ipfs` aborted with `Error: $HOME is not defined`, which under `set -e` aborted the whole setup script before the datadir/config were created — so a truly fresh box never initialised Kubo and crash-looped. Every `sudo -u ipfs env … ipfs …` call now passes `HOME=/var/lib/ipfs`.

Also: create the datadir in a `runcmd` step BEFORE the `ipfs.service` is enabled (not via `ExecStartPre`). The removed `ExecStartPre=+install -d /var/lib/ipfs` was a catch-22 — the unit's `ReadWritePaths=/var/lib/ipfs` makes systemd fail namespace setup (`226/NAMESPACE`) when the path is missing, before any `ExecStartPre` (even `+`) can run. Snapshot/invariant tests now assert every `sudo -u ipfs` call carries `HOME` and the datadir is created in `runcmd`.
