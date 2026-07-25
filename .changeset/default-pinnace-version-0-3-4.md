---
'pinnace': patch
---

Bump the emitted cloud-init's default on-box pinnace version (`DEFAULT_PINNACE_VERSION`) to `0.3.4`, the release that exports a default `HOME` in `ipfs-setup.sh` so the script's root-run ipfs calls do not abort a fresh boot.
