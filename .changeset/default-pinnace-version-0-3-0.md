---
'pinnace': patch
---

Bump the emitted cloud-init's default on-box pinnace version (`DEFAULT_PINNACE_VERSION`) to `0.3.0`, so a freshly provisioned box installs the release that auto-loads `.env`/`.env.local` at CLI startup (via `ldenv` `loadEnv`).
