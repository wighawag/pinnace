# The cloud-init agent pin structurally trails the release, and drifted in 0.8.0

2026-07-26, spotted right after publishing `pinnace@0.8.0`.

`DEFAULT_PINNACE_VERSION` (`src/provision/cloud-init.ts`) is the `pinnace` version a provisioned box installs for its on-box timers. It is a hand-edited literal, but the version actually published is computed by changesets AT RELEASE TIME, from the pending bumps. The two are only consistent if a human predicts the next version and edits the literal to match BEFORE merging the Version PR.

That prediction was made for `0.7.0` and MISSED for `0.8.0`: the release shipped with the pin still reading `0.7.0`, so any box provisioned from `0.8.0` would have installed the pre-correction agent (no `authorize`, no metadata write-path guards, a `republish` that ignores a site's stored `mode`). Fixed forward by pinning `0.8.1` in the release that publishes `0.8.1`.

## Why this will recur

Nothing enforces the relationship. The verify gate cannot check it, because at gate time `package.json` still holds the OLD version (changesets bumps it in the Version PR, after the gate has run on main). So the invariant "the pin equals the version being published" is unobservable at exactly the moment it would be checkable.

## Options

1. **Derive it instead of pinning it.** Read the version from `package.json` at build time (or import it) rather than duplicating the literal. The box then installs exactly the CLI's own version. Removes the class of bug entirely, but couples cloud-init output to the package version, which changes the "PINNED, never floating" reproducibility story (it stays pinned per build, just not hand-chosen).
2. **Enforce it in CI.** A release-time check that `DEFAULT_PINNACE_VERSION` equals the version about to be published, failing the Version PR otherwise. Keeps the literal, closes the drift.
3. **Leave it, and put the bump on the release checklist.** Cheapest, and exactly what just failed.

Option 1 or 2 is the real fix. Not tasked yet: option 1 touches the provisioning reproducibility contract and deserves a decision, not a drive-by.

**Resolved 2026-07-27 by the task `derive-version-from-package`, via option 1 (derive).** The package now has ONE version source of truth (`packages/pinnace/src/version.ts`, `PINNACE_VERSION`, read from the package's own `package.json`), and both consumers read it: `pinnace version` prints it (it used to print the package NAME), and the cloud-init agent pin defaults to it. The hand-edited `DEFAULT_PINNACE_VERSION` literal is gone, so the prediction that failed for `0.8.0` cannot be made or missed again: a box installs, by construction, the agent version of the CLI that emitted its cloud-init. The reproducibility contract is unchanged in substance (the pin is still an EXACT version, never floating `latest`, and a given build always emits the same pin); what changed is that the version is chosen by the build rather than by a human. `ProvisionInput.pinnaceVersion` (`--pinnace-version`) still overrides per box. The provision tests inject a fixed fake pin (`9.9.9`) so no snapshot bakes the real version, and the default is asserted by comparison against `PINNACE_VERSION`, so a changesets bump cannot redden the suite (demonstrated by running the suite green with `package.json` temporarily at `99.1.2`). Build decisions: `work/notes/observations/derive-version-from-package-decisions.md`.
