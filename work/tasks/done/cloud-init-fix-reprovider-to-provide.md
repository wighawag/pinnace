---
title: Fix cloud-init — emit Provide.* (not deprecated Reprovider.*) so Kubo 0.38 boots
slug: cloud-init-fix-reprovider-to-provide
spec: pinnace
blockedBy: []
covers: [1, 2]
---

## What to build

Fix a confirmed, high-severity provisioning bug found on a real Debian 13 Hetzner box: the emitted cloud-init writes the DEPRECATED `Reprovider.Strategy` / `Reprovider.Interval` Kubo config keys, but the pinned Kubo (`DEFAULT_KUBO_VERSION = 'v0.38.1'`) HARD-FAILS at startup (FATAL, `kubo/daemon.go:518`) when those keys are present. Result: the Kubo daemon crash-loops forever, so the node never comes up (Caddy returns 502, deploy fails with `fetch failed`). See `work/notes/observations/cloud-init-deprecated-reprovider-fatal-on-kubo-0-38.md`.

Kubo 0.38 renamed `Reprovider.*` -> `Provide.*`. The generator must emit the new keys and never the deprecated block.

Changes (in `packages/pinnace/src/provision/cloud-init.ts`):
- Replace the emitted `cfg Reprovider.Interval "12h"` / `cfg Reprovider.Strategy "all"` with `cfg Provide.Interval "12h"` / `cfg Provide.Strategy "all"`, and emit NO `Reprovider` block, for the shipped default Kubo (0.38.1). (If someone later wants pre-0.38 support, gate on `kuboVersion`; not required now since the default is 0.38.1.)
- Update the discoverability prose in the module doc comment and the ADR-0002 wording that currently says `Reprovider.Interval` to `Provide.Interval`, so the docs track the rename.
- Update the snapshot fixtures + add an invariant assertion: the emitted YAML MUST contain `Provide.Strategy` / `Provide.Interval` and MUST NOT contain any `Reprovider` key (so this regression is caught in CI).

This is provisioning correctness: without it, story 1/2 provisioning produces a dead node.

## Acceptance criteria

- [ ] The emitted cloud-init sets `Provide.Strategy` and `Provide.Interval` (the Kubo 0.38 keys) and emits NO `Reprovider.*` key at all.
- [ ] A snapshot/invariant test asserts `Provide.*` is present AND that no `Reprovider` key appears in the emitted YAML (regression guard).
- [ ] The module-doc + ADR-0002 discoverability wording is updated from `Reprovider.Interval` to `Provide.Interval`.
- [ ] The change is consistent with the pinned `DEFAULT_KUBO_VERSION` (0.38.1): the emitted config is one the pinned Kubo accepts (does not FATAL on deprecated keys).
- [ ] Tests write only to their own temp fixtures / snapshots.

## Blocked by

- None — `cloud-init-generation` is in `tasks/done/`; this is a correctness fix to it. Related to `cloud-init-pinnace-install-channel` and the first-boot-user observation (same file), but independent — this one is the daemon-won't-boot bug and should land first (it is what makes a provisioned node actually run).

## Prompt

> Goal: fix the emitted cloud-init so the pinned Kubo (v0.38.1) actually BOOTS. Read the done task `cloud-init-generation`, ADR-0002, and the observation `work/notes/observations/cloud-init-deprecated-reprovider-fatal-on-kubo-0-38.md` (it has the FATAL log + root cause).
>
> Kubo 0.38 renamed `Reprovider.*` -> `Provide.*` and FATALs at startup if the deprecated keys are present. The generator (`packages/pinnace/src/provision/cloud-init.ts`) currently emits `cfg Reprovider.Interval "12h"` + `cfg Reprovider.Strategy "all"` while pinning `DEFAULT_KUBO_VERSION = 'v0.38.1'` — an unbootable combination. Emit `Provide.Interval` / `Provide.Strategy` instead, emit no `Reprovider` block, and update the module-doc + ADR-0002 prose that mentions `Reprovider.Interval`. Update the snapshot and add an invariant test: emitted YAML MUST have `Provide.*` and MUST NOT have any `Reprovider` key. Test-first (repo policy on). Done means a provisioned node with the pinned Kubo starts cleanly (no deprecated-config FATAL), locked by the snapshot/invariant.
