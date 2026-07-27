/**
 * The package's ONE version source of truth.
 *
 * {@link PINNACE_VERSION} is read from the package's own `package.json`, the
 * only place the version legitimately lives (changesets computes it there at
 * release time). Every consumer reads it from HERE: the `pinnace version` verb
 * (`src/cli/run.ts`) and the cloud-init agent pin (`src/provision/cloud-init.ts`),
 * so there is no second mechanism and no literal to hand-edit.
 *
 * WHY (not a style preference): the cloud-init pin used to be a hand-typed
 * literal that a human had to predict and bump BEFORE merging the Version PR.
 * That prediction was missed once (`0.8.0` shipped pinning `0.7.0`, so a box
 * provisioned from it installed the previous agent). Deriving the pin makes the
 * box install exactly the version of the CLI that generated its cloud-init, by
 * construction. See
 * work/notes/observations/cloud-init-version-pin-trails-the-release.md. The pin
 * stays PINNED (an exact version, never a floating `latest`) and reproducible:
 * a given build always emits the same pin, because a given build IS one
 * version.
 *
 * HOW it resolves, and why it survives `tsc` + the published tarball: the file
 * is read at runtime, relative to THIS module's own URL. `src/version.ts` and
 * its compiled `dist/version.js` sit at the SAME depth under the package root
 * (`rootDir: ./src` -> `outDir: ./dist`), so `../package.json` is correct in
 * BOTH the dev/test path and the built `dist` a global `npm install -g pinnace`
 * runs on a box (test/version.test.ts proves the dist path by building and
 * running the real bin). A JSON `import` was rejected instead: `package.json`
 * sits OUTSIDE `rootDir`, so importing it would drag `package.json` into the
 * emitted `dist/` tree and shift every output path. `package.json` is always
 * present next to `dist`/`src` in the published tarball (npm always ships it,
 * and the package's `files` list ships `dist` + `src`).
 *
 * A missing / unparseable / version-less `package.json` THROWS, loudly and
 * named: it means a broken install, and the alternative (silently reporting
 * some placeholder version, or pinning a box to it) is exactly the class of
 * quiet-wrong-answer this repo refuses (CONTEXT.md `Conventions`).
 */
import {readFileSync} from 'node:fs';

/** Read + validate the `version` field of the package's own `package.json`. */
function readPackageVersion(): string {
	const url = new URL('../package.json', import.meta.url);
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(url, 'utf8'));
	} catch (cause) {
		throw new Error(
			`failed to read the pinnace version from '${url.pathname}'`,
			{
				cause,
			},
		);
	}
	const version = (parsed as {version?: unknown}).version;
	if (typeof version !== 'string' || version === '') {
		throw new Error(
			`'${url.pathname}' has no 'version' field; the pinnace install is broken`,
		);
	}
	return version;
}

/**
 * The version of THIS pinnace build, as its `package.json` states it.
 *
 * Exposed as a plain constant (mirroring `PINNACE`, the package name) so there
 * is exactly ONE surface for the fact: no parallel accessor function to drift
 * from it.
 */
export const PINNACE_VERSION: string = readPackageVersion();
