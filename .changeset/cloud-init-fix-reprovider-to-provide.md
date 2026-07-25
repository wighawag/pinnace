---
'pinnace': minor
---

Fix the emitted cloud-init to configure Kubo's `Provide.Strategy` / `Provide.Interval` instead of the deprecated `Reprovider.*` keys, which the pinned Kubo (v0.38.1) FATALs on at startup. Previously a provisioned node crash-looped and never came up; now the emitted config boots cleanly, guarded by a snapshot invariant that forbids any `Reprovider` key.
