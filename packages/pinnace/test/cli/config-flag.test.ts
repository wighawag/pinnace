import {describe, it, expect} from 'vitest';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {run, type ClientDeps, type RunContext} from '../../src/cli/run.js';
import type {PinnaceConfigFile} from '../../src/config/config-resolution.js';

/**
 * These tests cover the GLOBAL `--config <path>` flag: it may appear BEFORE the
 * command, is stripped from the per-verb argv, and threads the chosen path into
 * config loading through the injectable {@link RunContext.loadConfigFile} seam.
 *
 * Semantics under test:
 *  - `--config <path>` selects WHICH file is the file layer (the loader is
 *    called WITH that path),
 *  - with no `--config`, the loader is called with NO path (the `./pinnace.json`
 *    default), and its ABSENCE stays a benign empty config,
 *  - an EXPLICITLY-named path that is missing / unreadable / invalid JSON FAILS
 *    LOUD (error names the path, exit 1), never a silent empty config.
 *
 * They stay hermetic: the loader is injected (or a temp file is used), so the
 * operator's real `./pinnace.json` and real `process.env` are never touched.
 */

/** A minimal deploy-capable stub core; only what these tests dispatch to. */
function recordingDeps(): {deps: ClientDeps; calls: Record<string, unknown[]>} {
	const calls: Record<string, unknown[]> = {deploy: []};
	const deps: Partial<ClientDeps> = {
		deploy: async (input) => {
			calls.deploy.push(input);
			return {
				cid: 'bafyStub',
				mode: input.mode,
				ok: [],
				failed: [],
				success: true,
			};
		},
	};
	return {deps: deps as ClientDeps, calls};
}

/** A representative in-memory pinnace.json the loader can return. */
const fileConfig: PinnaceConfigFile = {
	hosts: [{name: 'a', endpoint: 'https://a.example', role: 'publisher'}],
};

/** A loader that RECORDS the path it was called with (undefined ⇒ default). */
function recordingLoader(config: PinnaceConfigFile): {
	load: (path?: string) => PinnaceConfigFile;
	paths: Array<string | undefined>;
} {
	const paths: Array<string | undefined> = [];
	return {
		load: (path?: string) => {
			paths.push(path);
			return config;
		},
		paths,
	};
}

function sinks(): {context: RunContext; out: string[]; err: string[]} {
	const out: string[] = [];
	const err: string[] = [];
	const context: RunContext = {
		env: {PINNACE_HOST_A_TOKEN: 'env-token-a'},
		out: (line) => out.push(line),
		err: (line) => err.push(line),
	};
	return {context, out, err};
}

describe('global --config <path> flag — threads the chosen file through the loader seam', () => {
	it('accepts --config BEFORE the command, strips it, and loads config from that path', async () => {
		const {deps, calls} = recordingDeps();
		const {load, paths} = recordingLoader(fileConfig);
		const {context} = sinks();
		const code = await run(
			['--config', 'runbook/pinnace.json', 'deploy', './dist', 'mysite'],
			{...context, deps, loadConfigFile: load},
		);
		expect(code).toBe(0);
		// The loader was pointed at the explicit path.
		expect(paths).toContain('runbook/pinnace.json');
		// The flag was stripped: deploy still parsed its own positionals cleanly.
		expect(calls.deploy.length).toBe(1);
		const input = calls.deploy[0] as {sourceDir?: string; id: string};
		expect(input.sourceDir).toBe('./dist');
		expect(input.id).toBe('mysite');
	});

	it('with NO --config, calls the loader with NO path (the ./pinnace.json default)', async () => {
		const {deps, calls} = recordingDeps();
		const {load, paths} = recordingLoader(fileConfig);
		const {context} = sinks();
		const code = await run(['deploy', './dist', 'mysite'], {
			...context,
			deps,
			loadConfigFile: load,
		});
		expect(code).toBe(0);
		expect(paths).toEqual([undefined]);
		expect(calls.deploy.length).toBe(1);
	});

	it('an explicitly-named --config path that is MISSING fails LOUD (names the path, exit 1)', async () => {
		const {deps, calls} = recordingDeps();
		const {context, err} = sinks();
		// No loader injected ⇒ the real defaultLoadConfigFile reads the path; a
		// non-existent file under a temp dir must fail loud, not empty-config.
		const missing = join(tmpdir(), 'pinnace-does-not-exist-xyz.json');
		const code = await run(
			['--config', missing, 'deploy', './dist', 'mysite'],
			{...context, deps},
		);
		expect(code).toBe(1);
		expect(calls.deploy.length).toBe(0);
		expect(err.join('\n')).toContain(missing);
	});

	it('an explicitly-named --config path with INVALID JSON fails LOUD (names the path, exit 1)', async () => {
		const {deps, calls} = recordingDeps();
		const {context, err} = sinks();
		const dir = mkdtempSync(join(tmpdir(), 'pinnace-cfg-'));
		const bad = join(dir, 'pinnace.json');
		writeFileSync(bad, '{ not valid json', 'utf8');
		try {
			const code = await run(['--config', bad, 'deploy', './dist', 'mysite'], {
				...context,
				deps,
			});
			expect(code).toBe(1);
			expect(calls.deploy.length).toBe(0);
			expect(err.join('\n')).toContain(bad);
		} finally {
			rmSync(dir, {recursive: true, force: true});
		}
	});

	it('an explicitly-named --config path that EXISTS + parses is used as the file layer', async () => {
		const {deps, calls} = recordingDeps();
		const {context} = sinks();
		const dir = mkdtempSync(join(tmpdir(), 'pinnace-cfg-'));
		const good = join(dir, 'pinnace.json');
		writeFileSync(good, JSON.stringify(fileConfig), 'utf8');
		try {
			const code = await run(['--config', good, 'deploy', './dist', 'mysite'], {
				...context,
				deps,
			});
			expect(code).toBe(0);
			expect(calls.deploy.length).toBe(1);
			// The host from the temp file drove the deploy target resolution.
			const input = calls.deploy[0] as {
				targets: Array<{baseUrl: string}>;
			};
			expect(input.targets.map((t) => t.baseUrl)).toEqual([
				'https://a.example',
			]);
		} finally {
			rmSync(dir, {recursive: true, force: true});
		}
	});

	it('with NO --config and NO ./pinnace.json present, the default stays a benign empty config', async () => {
		// The real default loader tolerates absence: reading a non-existent
		// ./pinnace.json yields {} rather than throwing. An empty config is a
		// benign, DOWNSTREAM validation error (exit 1) — NOT the loud, path-named
		// config-load failure and NOT a crash.
		const {deps, calls} = recordingDeps();
		const {context, err} = sinks();
		const code = await run(['deploy', './dist', 'mysite'], {
			...context,
			deps,
			loadConfigFile: () => ({}),
		});
		expect(code).toBe(1);
		// No deploy happened, and the error is a benign downstream validation
		// message, not a loud config-path failure (no path is named).
		expect(calls.deploy.length).toBe(0);
		expect(err.join('\n')).not.toMatch(/failed to (read|parse|load) config/i);
	});
});
