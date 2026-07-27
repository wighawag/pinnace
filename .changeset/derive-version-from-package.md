---
'pinnace': minor
---

Give the package ONE version source of truth, and make the cloud-init agent pin derive from it.

`pinnace version` now prints the package's real version, BARE (`0.10.0`), so `$(pinnace version)` is directly usable in a script. It used to print the package NAME (`pinnace`), unfinished scaffolding, so anyone parsing the old output sees a change (both READMEs and the emitted `pinnace-setup.sh` use it only as a post-install smoke test, which is unaffected).

The cloud-init agent pin (`PINNACE_VERSION` in `/etc/pinnace-node.env`, i.e. what a box runs `npm install -g pinnace@<...>` on) is no longer a hand-typed literal: it defaults to the version of the CLI that GENERATED the cloud-init. A box therefore installs the agent matching its generator by construction. The old literal had to be predicted and edited before merging each Version PR, and drifted when that was missed: `0.10.0` shipped correctly, but `0.8.0` shipped pinning `0.7.0`, so a box provisioned from it installed the pre-correction agent. The pin's contract is unchanged in substance: still an EXACT version (never floating `latest`), and a given build always emits the same pin; `--pinnace-version` / `ProvisionInput.pinnaceVersion` still overrides per box.

Both consumers read one module, `PINNACE_VERSION` (exported from the package root), which resolves the version from the package's own `package.json` at runtime, relative to its own module URL, which is correct in the dev/test path and in the built `dist` a global `npm install -g pinnace` runs on a box (proven by building and running the real `dist` bin in the tests, and by installing a packed tarball into a throwaway global prefix). A missing or version-less `package.json` fails loudly rather than reporting a placeholder version.

## Decisions

Full rationale (alternatives considered, what each touches): `work/notes/observations/derive-version-from-package-decisions.md`; the observation it closes is `work/notes/observations/cloud-init-version-pin-trails-the-release.md`.

- **`version` prints BARE, not `pinnace <version>`.** The old output was the package name, so there was no contract to preserve; bare avoids forcing every consumer to cut a field. Touches: the two READMEs' smoke test and the emitted `pinnace-setup.sh` (neither breaks).
- **DERIVE the pin (option 1 of the observation) rather than enforce the literal in CI (option 2).** Removes the failure class instead of policing it, at the cost that the agent version is chosen by the build rather than per release by a human. `DEFAULT_KUBO_VERSION` stays a literal on purpose: Kubo is an external dependency a human chooses; the agent is our own code. Touches: `--pinnace-version` (now the only way to pin a different agent) and the release ritual (the "bump the pin" step is gone).
- **Provision tests inject a fixed FAKE pin (`9.9.9`); the default is asserted by comparison against `PINNACE_VERSION`, never a literal.** Otherwise every changesets bump would redden the snapshot on main, trading a once-per-release manual edit for a once-per-release build break. Verified by running the suite green with `package.json` temporarily set to `99.1.2`.
