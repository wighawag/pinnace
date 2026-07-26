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
