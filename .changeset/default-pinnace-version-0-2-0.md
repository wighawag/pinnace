---
'pinnace': patch
---

Bump the emitted cloud-init's default on-box pinnace version (`DEFAULT_PINNACE_VERSION`) to `0.2.0`, so a freshly provisioned box installs the release that includes the wired-up on-box `node` agent (republish/mirror/warm/status assembling context from `/etc/pinnace-node.env`) rather than the earlier 0.1.0 where those verbs were stubs.
