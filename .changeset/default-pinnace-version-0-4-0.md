---
'pinnace': patch
---

Bump the emitted cloud-init's default on-box pinnace version (`DEFAULT_PINNACE_VERSION`) to `0.4.0`, the release that adds the rendered `index.html` status dashboard (`pinnace node status` writes a human-readable per-site page to the dashboard vhost, auto-reloading via meta-refresh).
