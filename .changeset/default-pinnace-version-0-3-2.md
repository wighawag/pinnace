---
'pinnace': patch
---

Bump the emitted cloud-init's default on-box pinnace version (`DEFAULT_PINNACE_VERSION`) to `0.3.2`, the release that adds `Environment=HOME=/var/lib/ipfs` to the Kubo unit (fixing the nopfs denylists / ProtectHome crash) and drops the unsettable `Provide.Interval` config line.
