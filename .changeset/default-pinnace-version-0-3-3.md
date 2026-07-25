---
'pinnace': patch
---

Bump the emitted cloud-init's default on-box pinnace version (`DEFAULT_PINNACE_VERSION`) to `0.3.3`, the release that fixes the root-cause `$HOME`-not-defined abort in `ipfs-setup.sh` and creates the datadir in `runcmd` before the unit starts.
