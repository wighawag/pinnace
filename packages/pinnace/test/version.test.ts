import {describe, it, expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {PINNACE_VERSION} from '../src/version.js';
import {run, type RunContext} from '../src/cli/run.js';

/**
 * The package's ONE version source of truth: `src/version.ts` resolves the
 * version from the package's own `package.json`, and every consumer (the
 * `version` verb, the cloud-init agent pin) reads it from there.
 *
 * These tests NEVER assert a version literal: one would have to be
 * hand-edited on every changesets bump, which is exactly the drift this module
 * removes (work/notes/observations/cloud-init-version-pin-trails-the-release.md).
 * They compare against the `version` field read from `package.json` at test
 * time, so a bump keeps them green.
 */

/** The package root: `src/<x>.ts` and `dist/<x>.js` are both one level under it. */
const packageRoot = fileURLToPath(new URL('..', import.meta.url));

/** The version as `package.json` states it, read here (never a literal). */
function packageJsonVersion(): string {
	const raw = readFileSync(join(packageRoot, 'package.json'), 'utf8');
	return (JSON.parse(raw) as {version: string}).version;
}

/** Capture what the CLI writes to stdout/stderr (no real env / config file). */
function captureContext(): {context: RunContext; out: string[]; err: string[]} {
	const out: string[] = [];
	const err: string[] = [];
	const context: RunContext = {
		env: {},
		loadConfigFile: () => ({}),
		out: (line) => out.push(line),
		err: (line) => err.push(line),
	};
	return {context, out, err};
}

describe('PINNACE_VERSION: one source of truth', () => {
	it('resolves the version from the package own package.json', () => {
		expect(PINNACE_VERSION).toBe(packageJsonVersion());
	});

	it('is an EXACT version, never a range or a floating tag', () => {
		expect(PINNACE_VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?$/i);
		expect(PINNACE_VERSION).not.toBe('latest');
	});
});

describe('pinnace version: prints the real version', () => {
	it('prints the resolved version BARE (script-friendly), not the package name', async () => {
		const {context, out} = captureContext();
		expect(await run(['version'], context)).toBe(0);
		expect(out).toEqual([packageJsonVersion()]);
		// The old behaviour printed the package NAME; it must be gone.
		expect(out[0]).not.toBe('pinnace');
	});

	it('answers the same for the `--version` / `-v` aliases', async () => {
		for (const argv of [['--version'], ['-v']]) {
			const {context, out} = captureContext();
			expect(await run(argv, context)).toBe(0);
			expect(out).toEqual([packageJsonVersion()]);
		}
	});
});

describe('version resolution from dist (the shape the box runs)', () => {
	// A global `npm install -g pinnace` runs `dist/cli/bin.js`, and the emitted
	// cloud-init ends its install with `pinnace version`, so resolution MUST
	// work from the BUILT output, not just the dev/test path. The build is run
	// here rather than assumed: a check that could not run must never report a
	// pass (CONTEXT.md `Conventions`), and a stale `dist/` would do exactly that.
	it('the BUILT cli resolves and prints the same version', () => {
		execFileSync(join(packageRoot, 'node_modules/.bin/tsc'), [], {
			cwd: packageRoot,
			stdio: 'pipe',
		});
		const stdout = execFileSync(
			process.execPath,
			[join(packageRoot, 'dist/cli/bin.js'), 'version'],
			{cwd: packageRoot, encoding: 'utf8'},
		);
		expect(stdout.trim()).toBe(packageJsonVersion());
	}, 120_000);
});
