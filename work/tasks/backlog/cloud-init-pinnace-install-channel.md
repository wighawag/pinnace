---
title: Decide + implement the on-box pinnace install channel (unpublished package today)
slug: cloud-init-pinnace-install-channel
spec: pinnace
blockedBy: []
covers: [1, 2]
---

## What to build

Resolve a real boot-time gap surfaced by the Gate-2 review of `cloud-init-generation`: the emitted cloud-init installs the on-box agent via `npm install -g pinnace`, but the `pinnace` package is `version: 0.0.0` and NOT published to npm. So a freshly provisioned box would fail `pinnace-setup.sh` (the install step) until the package is published, which means provisioning is broken end-to-end today even though the generator's snapshot tests pass.

Decide and implement the install channel the emitted cloud-init should use, at least one of:
- publish `pinnace` to npm and PIN a version in the emitted install (`npm install -g pinnace@<version>`) so a box gets a known-good build;
- and/or support an alternate channel (a tarball URL, a git ref, or a built artifact shipped by `provision`) for the pre-publish / private case.

Whatever is chosen, the emitted cloud-init must reference a resolvable install source, the version must be PINNED (not floating `latest`), and the generator's snapshot tests must assert the pinned/known install form. This is provisioning correctness, not a new feature: without it, story 1/2 provisioning cannot actually stand up a working node.

## Acceptance criteria

- [ ] The emitted cloud-init installs `pinnace` from a RESOLVABLE source (published+pinned npm version, or an explicit tarball/git/artifact channel), not a bare `npm install -g pinnace` against an unpublished package.
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
> The gap (from `work/notes/observations/review-nits-cloud-init-generation-2026-07-24.md`): the emitted `pinnace-setup.sh` runs `npm install -g pinnace`, but the package is `0.0.0` and unpublished, so a fresh box fails to install the agent. Decide the install channel (publish + pin a version, or an explicit tarball/git/artifact channel) and pin it (never floating `latest`). In the SAME install block, replace the stale hardcoded `setup_20.x` NodeSource line with a current LTS (Node 22 as of mid-2026) exposed as a named `DEFAULT_NODE_MAJOR` value (mirror `DEFAULT_KUBO_VERSION`) so it is one obvious knob to bump. Update the generator + its snapshot tests to assert the pinned/known install form and the chosen Node major. Record the decision durably and link it from the done record. Done means a provisioned box can actually install the pinned `pinnace` agent on a current Node LTS, proven by the generator's snapshot tests.
