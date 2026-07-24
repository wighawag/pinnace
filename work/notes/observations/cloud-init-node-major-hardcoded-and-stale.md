---
title: Emitted cloud-init hardcodes NodeSource setup_20.x (stale, no knob)
date: 2026-07-24
status: open
reviewOf: cloud-init-generation
---

## What was observed

The emitted `pinnace-setup.sh` installs Node via a bare literal:

```
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
```

Location: `packages/pinnace/src/provision/cloud-init.ts` (the `pinnace-setup.sh`
`write_files` block).

Issues:
- **Stale default.** Node 20 is the OLDEST maintained LTS (EOL ~April 2026).
  Provisioning a fresh box onto a nearly-EOL runtime is a poor default; the
  current active LTS is Node 22. It is also incoherent with the repo's own Node
  24 toolchain.
- **Hardcoded, no knob.** Unlike `DEFAULT_KUBO_VERSION` (a named value), the Node
  major is a literal `20` with no `DEFAULT_NODE_MAJOR`, no comment, and no
  rationale, so it cannot be overridden without hand-editing the emitted YAML.
- **Fresh-Debian risk.** NodeSource `setup_<major>.x` can briefly lag a
  brand-new Debian release ("distribution not supported"); a current major
  reduces that risk on a just-released image (e.g. Debian 13 Trixie).

The `cloud-init-generation` review already flagged "Node 20 (nodesource)" as an
unspecified user-visible default worth a human nod
(`review-nits-cloud-init-generation-2026-07-24.md`).

## Disposition

Folded into `work/tasks/backlog/cloud-init-pinnace-install-channel.md` (same
install block): pin a current LTS as a named `DEFAULT_NODE_MAJOR` value and
assert it in the snapshot. Discharge this note once that task lands or the Node
20 default is ratified as intended.
