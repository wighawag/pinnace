---
'pinnace': patch
---

Fix the true root cause of the fresh-box crash-loop: `ipfs-setup.sh` calls `ipfs --version` as ROOT right after installing Kubo, but cloud-init's `runcmd` provides no `HOME`, and the ipfs binary refuses to run without one (`Error: $HOME is not defined`). Under `set -euo pipefail` that aborted the script at its FIRST ipfs call — before the `ipfs` user, the datadir, and `ipfs init` — so a genuinely fresh box never initialised Kubo and crash-looped (502 through Caddy). The script now exports a default `HOME` up front (`export HOME="${HOME:-/root}"`); the per-user `sudo -u ipfs` calls still override it with the ipfs user's home. A test asserts the export is emitted.
