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

## Blocked by

- None — `cloud-init-generation` is in `tasks/done/`; this fixes its install channel.

## Prompt

> Goal: make the on-box `pinnace` install in the emitted cloud-init actually resolvable + reproducible. Read CONTEXT.md (`host provider seam`, `core vs cli`), ADR-0002 (the on-box agent boundary — the box runs the SAME `pinnace` binary), and the done task `cloud-init-generation`.
>
> The gap (from `work/notes/observations/review-nits-cloud-init-generation-2026-07-24.md`): the emitted `pinnace-setup.sh` runs `npm install -g pinnace`, but the package is `0.0.0` and unpublished, so a fresh box fails to install the agent. Decide the install channel (publish + pin a version, or an explicit tarball/git/artifact channel) and pin it (never floating `latest`). Update the generator + its snapshot tests to assert the pinned/known install form. Record the decision durably and link it from the done record. Done means a provisioned box can actually install the pinned `pinnace` agent, proven by the generator's snapshot tests.
