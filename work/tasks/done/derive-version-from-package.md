---
title: One version source of truth — `pinnace version` reports it, cloud-init derives its pin from it
slug: derive-version-from-package
spec: sites-metadata-in-mfs
promptGuidance.testFirst: true
blockedBy: []
covers: [2]
---

## What to build

The package has NO version-resolution mechanism, which causes two visible defects:

1. **`pinnace version` does not print a version.** It prints `pinnace`. The handler is `rc.out(name())`, and `name()` returns the package-name constant `PINNACE` — scaffolding that was never finished. A user asking a CLI its version gets its name.
2. **The cloud-init agent pin is a hand-typed literal that drifts.** `DEFAULT_PINNACE_VERSION` in `src/provision/cloud-init.ts` is the `pinnace` version a provisioned box installs. The version actually published is computed by changesets AT RELEASE TIME, so the literal is only correct if a human predicts the next version and edits it before merging the Version PR. That prediction was missed once already: `0.8.0` shipped pinning `0.7.0`, so a box provisioned from it installed the pre-correction agent. See `work/notes/observations/cloud-init-version-pin-trails-the-release.md`.

Fix both with ONE source of truth: the package's own `version` from `package.json`.

- **Resolve the version once**, in one small module, read from the package's `package.json`. It MUST work in all three ways the package runs: from `dist` after a global `npm install -g pinnace` (the box's on-box timers), from `dist` locally, and in the test/dev path. Note `src/<x>.ts` and `dist/<x>.js` sit at the SAME depth relative to `package.json`, so a relative resolution is stable across both, but VERIFY that rather than assuming, and prefer whichever mechanism keeps `tsc` output and the published tarball correct.
- **`pinnace version` prints the real version.** Decide and state whether it prints bare (`0.10.0`) or `pinnace 0.10.0`; bare is friendlier for scripts (`$(pinnace version)`), so prefer bare unless something already depends on the current output.
- **`DEFAULT_PINNACE_VERSION` derives from that same source**, so a provisioned box installs the SAME version as the CLI that generated its cloud-init. The pin stays PINNED (never floating `latest`) and reproducible: a given CLI build always emits the same pin. `ProvisionInput.pinnaceVersion` stays as the per-box override.
- Delete the hand-edited literal and the release ritual around it.

### THE TRAP — do not bake the version into a snapshot

`test/provision/__snapshots__/cloud-init.test.ts.snap` currently contains `PINNACE_VERSION="0.10.0"`, and a test asserts that literal. Once the value is DERIVED, changesets bumping `package.json` in the Version PR would make that snapshot and assertion FAIL on main, reddening the next task's gate. That would replace a once-per-release manual edit with a once-per-release build break, which is worse.

So the provision tests MUST become version-stable:

- Every snapshot-producing provision test injects an EXPLICIT `pinnaceVersion` (a fixed fake like `9.9.9`), so the snapshot never contains the real package version.
- The DEFAULT is asserted separately, by comparing the emitted value against the version read from the SAME source of truth (never a hardcoded literal), so the test keeps passing across every future bump.
- Same treatment for any other test that asserts the version.

## Acceptance criteria

- [ ] `pinnace version` prints the package's real version (tested against the package's own `package.json`, not a literal).
- [ ] The version is resolved in ONE module and both consumers (`version` verb, cloud-init pin) use it; no second mechanism, no duplicated literal anywhere in `src/`.
- [ ] `DEFAULT_PINNACE_VERSION` as a hand-edited literal is GONE; the emitted cloud-init pins the CLI's own version.
- [ ] `ProvisionInput.pinnaceVersion` still overrides per box (tested).
- [ ] The emitted cloud-init still pins an EXACT version (never `latest`) and is reproducible for a given build (tested).
- [ ] NO test or snapshot contains the real package version: snapshot tests inject an explicit fake version, and the default is asserted by comparison against the shared source (tested). Bumping `package.json` must not break the suite — demonstrate this, e.g. by asserting the emitted default equals the resolved version rather than a string.
- [ ] Version resolution works from `dist` (the shape a global `npm install -g pinnace` runs on the box), not only in the dev/test path. State how this was verified.
- [ ] The observation `cloud-init-version-pin-trails-the-release.md` is resolved.
- [ ] Test-first. A changeset is included, noting `pinnace version` now reports a version (a change for anyone parsing its old output).

## Blocked by

- None.

## Prompt

> Goal: give the package ONE version source of truth, so `pinnace version` stops printing the package NAME and the cloud-init agent pin stops being a hand-predicted literal. Read `src/index.ts` (`PINNACE`, `name()`), the `version` arm of `src/cli/run.ts`, `src/provision/cloud-init.ts` (`DEFAULT_PINNACE_VERSION`, `ProvisionInput.pinnaceVersion`), the provision tests + snapshot, and `work/notes/observations/cloud-init-version-pin-trails-the-release.md`.
>
> The pin must equal the version of the CLI that emitted the cloud-init, automatically, so a box always installs the agent matching its generator. `0.8.0` shipped pinning `0.7.0` because a human forgot.
>
> The trap to avoid: the current snapshot BAKES the version, so deriving it would make every changesets bump red the suite on main. Make the provision tests inject an explicit fake version, and assert the default by comparing against the shared source rather than a literal. Verify resolution works from `dist`, since that is what runs on the box.
