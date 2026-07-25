---
title: Decide + implement the on-box pinnace install channel (unpublished package today)
slug: cloud-init-pinnace-install-channel
spec: pinnace
blockedBy: []
covers: [1, 2]
---

## Update 2026-07-25 (premise reconciled): `pinnace` IS now published

`pinnace@0.1.0` is published to npm (public, OIDC provenance). The original
"unpublished package" premise is resolved: the box CAN `npm install -g pinnace`.
What remains is making that install PINNED + REPRODUCIBLE and hardening the boot,
not deciding whether a channel exists. Build to the reconciled scope below.

## What to build

Make the on-box `pinnace` install pinned, reproducible, and boot-safe.

1. **Pin the version.** The emitted `pinnace-setup.sh` runs a bare
   `npm install -g pinnace` (floating `latest`). PIN it to a specific version
   exposed as a named `DEFAULT_PINNACE_VERSION` value (mirror `DEFAULT_KUBO_VERSION`),
   defaulting to the current published version, overridable via a `provision`
   input. So a box boot is reproducible: `npm install -g pinnace@<pinned>`.
   (Keep it a NAMED knob, not a literal, so the release bump is one obvious edit.)
2. **Current Node LTS, as a named knob.** Replace the hardcoded `setup_20.x`
   NodeSource line (Node 20 is the oldest LTS, EOL ~2026-04, incoherent with the
   repo's Node 24) with a current LTS (Node 22) exposed as `DEFAULT_NODE_MAJOR`
   (mirror `DEFAULT_KUBO_VERSION`). See
   `work/notes/observations/cloud-init-node-major-hardcoded-and-stale.md`.
3. **The install must NOT abort the boot** (see the first-boot bug below): even if
   the `pinnace` install fails transiently, Kubo + firewall + Caddy must come up,
   and the `ipfs` service user must exist before any step uses it.

The generator's snapshot/invariant tests must assert the pinned pinnace version,
the chosen Node major, and the boot-safe ordering. This is provisioning
correctness: story 1/2 must stand up a WORKING node with the on-box timers able
to run the installed binary.

## Acceptance criteria

- [ ] The emitted cloud-init installs a PINNED `pinnace` version (`npm install -g pinnace@<pinned>`), the pin exposed as a named `DEFAULT_PINNACE_VERSION` (defaulting to the current published version) and overridable via a `provision` input — not a bare floating `npm install -g pinnace`.
- [ ] The installed version is PINNED (no floating `latest`), so a box boot is reproducible.
- [ ] Snapshot/invariant tests assert the emitted install line references the pinned/known source.
- [ ] The choice (publish vs alternate channel, and the pinning scheme) is recorded (a `## Decisions` note or an ADR if it meets the bar) and linked from the done record.
- [ ] Tests write only to their own temp fixtures.

## Related first-boot bug (must be fixed together or coordinated)

A real Debian 13 provision (2026-07-24) showed this install block is not merely a no-op: because `pinnace-setup.sh` is `set -euo pipefail` and `npm install -g pinnace` fails hard (unpublished package), it ABORTS the boot sequence, and on a cold boot the box was left half-provisioned (the `ipfs` user missing for a later `install -o ipfs` step) while `cloud-init status` still reported `done`. See `work/notes/observations/cloud-init-first-boot-ipfs-user-race-and-set-e-abort.md`. So this task MUST ensure the pinnace-agent install cannot abort the boot (guard it / `|| true` until the channel is resolved), and Kubo + firewall + Caddy come up regardless. The `ipfs`-user-ordering half (create the user via cloud-init `users:` before `runcmd`) is captured in the same observation; fix it here or coordinate with a sibling `cloud-init-generation` fix.

## Blocked by

- None — `cloud-init-generation` is in `tasks/done/`; this fixes its install channel.

## Prompt

> Goal: make the on-box `pinnace` install in the emitted cloud-init actually resolvable + reproducible. Read CONTEXT.md (`host provider seam`, `core vs cli`), ADR-0002 (the on-box agent boundary — the box runs the SAME `pinnace` binary), and the done task `cloud-init-generation`.
>
> RECONCILED PREMISE (2026-07-25): `pinnace@0.1.0` IS now published to npm. So this is no longer "decide if a channel exists" — it is: PIN the version, use a current Node LTS, and make the install boot-safe. Read CONTEXT.md (`host provider seam`, `core vs cli`), ADR-0002, the done task `cloud-init-generation`, and the two observations `cloud-init-node-major-hardcoded-and-stale.md` + `cloud-init-first-boot-ipfs-user-race-and-set-e-abort.md`.
>
> The emitted `pinnace-setup.sh` runs a bare `npm install -g pinnace` (floating latest) and `setup_20.x` (stale Node). (1) Pin pinnace to a named `DEFAULT_PINNACE_VERSION` (default the current published version, overridable via a provision input): `npm install -g pinnace@<pinned>`. (2) Replace `setup_20.x` with a current LTS (Node 22) as a named `DEFAULT_NODE_MAJOR`. (3) Make the install boot-safe: it must not abort the boot (the `ipfs` user, Kubo, firewall, Caddy must all come up even if the pinnace install has a transient failure), and the `ipfs` service user must be created before any step uses it (prefer cloud-init `users:`, which runs before `runcmd`). Update the generator + snapshot/invariant tests to assert the pinned pinnace version, the Node major, and the boot-safe ordering. Record the decisions durably and link them from the done record. Done means a provisioned box installs the pinned `pinnace` agent on a current Node LTS and boots cleanly even if the install hiccups, proven by the generator's tests.
