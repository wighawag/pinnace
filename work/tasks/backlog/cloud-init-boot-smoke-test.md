---
title: Add a boot-level smoke test for the emitted cloud-init (catch cold-boot bugs before release)
slug: cloud-init-boot-smoke-test
spec: pinnace
blockedBy: []
covers: [1, 2]
---

## What to build

Add a test that actually EXECUTES the emitted cloud-init (or its `ipfs-setup.sh` + the systemd unit) in a throwaway Linux environment and asserts Kubo comes up and answers on the local RPC. The generator's current tests validate the emitted YAML as TEXT (snapshots + string invariants) but NOTHING validates that a real box BOOTS. As a direct consequence, SIX distinct cold-boot bugs shipped and were only found by hand on live Hetzner boxes, each needing a patch release (0.3.0 → 0.3.4):

1. deprecated `Reprovider.*` config FATALs Kubo 0.38;
2. first-boot `ipfs` user / `set -e` abort;
3. `/var/lib/ipfs` datadir never created → `226/NAMESPACE`;
4. `HOME` unset in the systemd unit → nopfs denylists `permission denied`;
5. `Provide.Interval` not settable on 0.38.1 → `set -e` abort;
6. **root cause:** `ipfs --version` (root, no `HOME`) → `Error: $HOME is not defined` → `set -e` aborts the whole setup script at its first ipfs call.

Every one of these is the kind of thing a boot-execution test catches instantly and a text-snapshot test is structurally blind to.

Scope (pick the cheapest that gives real signal):
- A container-based test (e.g. a Debian image) that runs the emitted `ipfs-setup.sh` (with a stubbed/downloaded Kubo) under the same env cloud-init provides (crucially: NO `HOME` in the environment, `set -euo pipefail`), and asserts it completes, creates + initialises `/var/lib/ipfs/.ipfs`, and that `ipfs id` answers on `127.0.0.1:5001`. Bearer/Caddy/DNS can be out of scope; the daemon-comes-up check is the valuable part.
- If a full systemd boot is feasible in CI (nested container / VM), assert the `ipfs.service` unit reaches `active (running)` (this also exercises the hardening directives: `ReadWritePaths`, `ProtectHome`, `HOME`, the datadir precondition).
- At minimum: run the emitted `ipfs-setup.sh` in an env with `HOME` unset and assert exit 0 + the repo is initialised — that alone would have caught bugs 2, 3, 5, and 6.

This is gated behind an opt-in / CI marker if it needs Docker (like the existing skip-guarded live IPNS test), so the default `verify` stays hermetic, but it MUST run somewhere before a release that touches the cloud-init generator.

## Acceptance criteria

- [ ] A test executes the emitted cloud-init's setup path (`ipfs-setup.sh` at least) in a real Linux environment that reproduces cloud-init's runcmd env (NO `HOME`, `set -euo pipefail`) and asserts it completes without aborting.
- [ ] The test asserts Kubo actually initialises + the daemon answers `id` on the local RPC (not just that the YAML contains the right strings).
- [ ] The test would FAIL on each of the six historical bugs above (or at least the script-abort ones: missing `HOME`, unsettable `Provide.Interval`, missing datadir).
- [ ] It is opt-in / CI-guarded (needs Docker/VM) so the default `verify` stays hermetic, but is wired to run before a cloud-init-touching release.
- [ ] Uses a stubbed or cached Kubo (no dependence on a live `dist.ipfs.tech` download flaking the test), or tolerates the download explicitly.

## Blocked by

- None — `cloud-init-generation` + the fixes are in `tasks/done/`; this adds the missing boot verification.

## Prompt

> Goal: stop cold-boot cloud-init bugs from shipping by actually BOOTING the emitted config in a test, not just snapshotting its text. Read the done task `cloud-init-generation`, the fix tasks, and the observations under `work/notes/observations/cloud-init-*` (they enumerate the six bugs that a boot test would have caught). Build a container (or VM) test that runs the emitted `ipfs-setup.sh` under cloud-init-like conditions (NO HOME, set -euo pipefail), with a stubbed/cached Kubo, and asserts it completes, initialises `/var/lib/ipfs/.ipfs`, and the daemon answers `id` locally; ideally also assert the systemd unit reaches active (exercising ReadWritePaths/ProtectHome/HOME/datadir). Make it opt-in/CI-guarded (needs Docker) so default `verify` stays hermetic, but run it before any cloud-init-touching release. Done means a real regression in the emitted boot path fails a test instead of a live Hetzner box.
