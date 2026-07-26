---
'pinnace': patch
---

Pin the cloud-init agent version (`DEFAULT_PINNACE_VERSION`) to `0.8.1`, the version this release publishes, so a freshly provisioned box installs the agent that matches the CLI releasing it. The `0.8.0` release shipped with the pin still on `0.7.0`, so a box provisioned from it would have installed the pre-correction agent (no `authorize`, no metadata write-path guards, and a `republish` that ignores a site's stored `mode`).
