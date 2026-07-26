---
'pinnace': patch
---

Bump the cloud-init pinned agent version (`DEFAULT_PINNACE_VERSION`) to `0.7.0`, so a freshly provisioned box installs the release that carries the MFS site-metadata reshape rather than the previous `0.6.0`. A box boot stays reproducible (the version is pinned, never floating `latest`), and it remains overridable per box via `ProvisionInput.pinnaceVersion`.
