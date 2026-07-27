---
title: build decisions for 'derive-version-from-package' (one version source of truth)
date: 2026-07-27
status: open
reviewOf: derive-version-from-package
---

# One version source of truth: build decisions (2026-07-27)

Decisions recorded while building the task `derive-version-from-package` (the package resolves its version once; `pinnace version` prints it and the cloud-init agent pin derives from it). Captured here per the work contract because each one either sets a USER-VISIBLE default, introduces a new refusal, or touches another flag/command/task.

Where this note is referenced from: the completion report and the changeset link it; the reasoning also lives at the choice sites (the module JSDoc in `packages/pinnace/src/version.ts`, the `PINNACE_VERSION` note in `packages/pinnace/src/provision/cloud-init.ts`, and the `version` arm of `packages/pinnace/src/cli/run.ts`).

## 1. `pinnace version` prints the version BARE (`0.10.0`), not `pinnace 0.10.0`

The verb used to print the package NAME (`pinnace`), which nothing could usefully consume, so there is no output contract to preserve and no reason to keep the name in the line. Bare is chosen so `$(pinnace version)` is directly usable in a script; a `pinnace 0.10.0` form would force every consumer to cut a field. Alternatives considered: `pinnace 0.10.0` (rejected, forces parsing for no gain), and a `--json` shape (rejected outright: `version` accepts NO flags by decision 4 of `reject-unknown-cli-flags-decisions.md`, and one line of output needs no envelope). This IS a user-visible change for anyone who parsed the old output (both READMEs use `pinnace version` as the post-install smoke test, and the emitted cloud-init's `pinnace-setup.sh` ends with it: both only care that it exits 0 and prints something, so neither breaks). Touches: the `version` verb's output, the two READMEs' smoke test, the emitted `pinnace-setup.sh` last line.

## 2. The cloud-init agent pin is DERIVED from the package version, so the version is chosen by the BUILD, not by a human

`DEFAULT_PINNACE_VERSION` (the hand-typed literal) is deleted; the default is now `PINNACE_VERSION`. This is option 1 of `cloud-init-version-pin-trails-the-release.md`, taken deliberately over option 2 (a release-time CI check that the literal equals the version about to be published). Deriving removes the failure class instead of policing it, and needs no new CI surface; the cost is that the pin is no longer a value a human can choose per release, which was the exact lever that failed in `0.8.0`. The "PINNED, never floating `latest`" contract is unchanged in substance: the emitted value is still an EXACT version and a given build always emits the same pin (asserted). What changes is WHICH exact version: whatever the emitting CLI is, rather than whatever a human predicted. Note the deliberate asymmetry with `DEFAULT_KUBO_VERSION`, which stays a literal: Kubo is an EXTERNAL dependency a human chooses; the agent is our own code, so it has a source of truth to derive from. Touches: `ProvisionInput.pinnaceVersion` / `--pinnace-version` (unchanged, still the per-box override and now the ONLY way to pin a different agent), the release ritual (the "bump the pin before merging the Version PR" step is gone), and `work/tasks/backlog/cloud-init-boot-smoke-test.md` if it ever asserts a specific installed agent version.

## 3. One SURFACE for the fact: a `PINNACE_VERSION` constant, not a `version()` accessor

`src/version.ts` exports a single const, even though its neighbour `PINNACE` (the package name) has a paired `name()` accessor. A second surface for one fact is the duplication this task exists to remove, and the accessor would buy nothing (the value cannot change at runtime). Alternative considered: mirroring `name()` with a `version()` for symmetry (rejected as ceremony). `name()` itself is deliberately left alone: it is still what prefixes the CLI's error lines, and re-meaning it was never in scope.

## 4. An unreadable / version-less `package.json` THROWS at import, loudly

`readPackageVersion` refuses rather than falling back to a placeholder like `0.0.0` or `unknown`. A fallback would be a silently wrong answer in exactly the two places that matter (a version report, and the agent version a box installs for years), which the repo's "a check that could not run never reports a definitive negative" convention forbids. The read happens at module load, so a broken install fails at CLI startup with a named path rather than mid-command. The condition means the package's own `package.json` is missing or corrupt, i.e. a broken install; npm always ships `package.json`, and the tarball was verified to contain it next to `dist/` (a global install into a temp prefix prints the version). Touches: every command (the module is imported through `src/index.ts`), which is why the failure is loud and named.

## 5. Resolution is a RUNTIME read relative to `import.meta.url`, not a JSON import

`new URL('../package.json', import.meta.url)` + `readFileSync`. `src/version.ts` and its compiled `dist/version.js` sit at the SAME depth under the package root, so the one relative path is correct in the dev/test path and in the built `dist` a global install runs. A TypeScript JSON import (`resolveJsonModule` is on) was rejected because `package.json` lies OUTSIDE `rootDir: ./src`, so importing it would drag it into the emitted `dist/` tree and shift every output path (a build-shape change for a value read once). Verified from `dist`, not assumed: `test/version.test.ts` builds the package and runs the real `dist/cli/bin.js version`, and a packed tarball installed into a throwaway global prefix prints the version too. Touches: nothing else today, but any future change to `rootDir`/`outDir` or to where this module lives must keep that depth equal (the module JSDoc says so).

## 6. The provision tests inject a FIXED FAKE pin (`9.9.9`); the default is asserted by comparison

Every provision test whose output is asserted or snapshotted now states `pinnaceVersion: '9.9.9'`, so the snapshot never bakes the real package version. Had it stayed baked, each changesets bump in the Version PR would redden the suite on main, trading a once-per-release manual edit for a once-per-release build break, which is strictly worse. The DERIVED default is covered separately by comparing the emitted `PINNACE_VERSION="..."` against the imported `PINNACE_VERSION`, never a literal. Demonstrated by running the whole suite green with `package.json` temporarily set to `99.1.2`. `test/cli/startup-dotenv.test.ts` needed the same treatment (it asserted the `version` verb printed `pinnace`). Touches: any future test that asserts provisioned output; it must inject a pin rather than expect the real one.
