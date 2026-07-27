import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {main} from '../../src/cli/startup.js';
import {run, type ClientDeps, type RunContext} from '../../src/cli/run.js';
import {resolveMasterSecret} from '../../src/config/config-resolution.js';
import {PINNACE_VERSION} from '../../src/version.js';

/**
 * These tests cover the CLI STARTUP shim ({@link main}): it loads the cwd's
 * `.env` / `.env.local` into `process.env` via `ldenv`'s `loadEnv()` BEFORE the
 * pure {@link run} dispatch, so a global `npm install -g pinnace` gets the
 * env-only secrets model (CONTEXT.md `master key` / `token`) with no `pnpm
 * ldenv` dev wrapper.
 *
 * The invariants under test:
 *  - `.env.local` (and `.env`) vars from the cwd reach the resolver (they land
 *    in `process.env`, which is what config resolution + `resolveMasterSecret`
 *    read),
 *  - PRECEDENCE is preserved: an explicitly EXPORTED `process.env` value WINS
 *    over the `.env.local` value; a var only in `.env.local` is used when NOT
 *    exported (dotenv slots BELOW exported env, ABOVE `pinnace.json`),
 *  - the master + host tokens stay env-only: `.env.local` is only a FILE SOURCE
 *    for those env vars,
 *  - the pure `run(argv, {env})` path stays hermetic: the `loadEnv()` side
 *    effect lives in the shim, never in `run()`.
 *
 * They stay hermetic in the OTHER direction too: cwd is isolated to a temp
 * fixture dir (so no real project `.env` / no home location is read), and every
 * `process.env` key the fixture touches is captured + restored in `afterEach`,
 * so a test never leaks env into the process or reads the operator's real one.
 */

/** Keys the fixtures set; captured before + restored after so nothing leaks. */
const TOUCHED_ENV_KEYS = [
	'PINNACE_MASTER',
	'PINNACE_HOST_A_TOKEN',
	'STARTUP_ONLY_LOCAL',
	'STARTUP_ONLY_ENV',
	'STARTUP_EXPORTED',
] as const;

let savedEnv: Record<string, string | undefined>;
let savedCwd: string;
let fixtureDir: string;

beforeEach(() => {
	savedEnv = {};
	for (const key of TOUCHED_ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
	savedCwd = process.cwd();
	fixtureDir = mkdtempSync(join(tmpdir(), 'pinnace-startup-'));
});

afterEach(() => {
	process.chdir(savedCwd);
	rmSync(fixtureDir, {recursive: true, force: true});
	for (const key of TOUCHED_ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
});

describe('CLI startup shim — loads cwd .env/.env.local into process.env before run()', () => {
	it('loads a .env.local secret from the cwd so it reaches the master resolver', async () => {
		writeFileSync(
			join(fixtureDir, '.env.local'),
			'PINNACE_MASTER=master-from-local\nSTARTUP_ONLY_LOCAL=only-local\n',
			'utf8',
		);
		process.chdir(fixtureDir);

		// The shim runs the real ldenv loadEnv (no injected loadDotEnv), then
		// dispatches version (a benign, network-free command).
		await main(['version']);

		// The .env.local var landed in process.env — the layer the resolver reads.
		expect(process.env['STARTUP_ONLY_LOCAL']).toBe('only-local');
		// And it reaches the env-only master resolver via process.env.
		expect(resolveMasterSecret({env: process.env})).toBe('master-from-local');
	});

	it('lets an EXPORTED process.env value win over the .env.local value (precedence)', async () => {
		writeFileSync(
			join(fixtureDir, '.env.local'),
			'STARTUP_EXPORTED=from-local-file\n',
			'utf8',
		);
		process.chdir(fixtureDir);

		// Simulate an operator who exported the var explicitly before running.
		process.env['STARTUP_EXPORTED'] = 'exported-wins';
		await main(['version']);

		// ldenv does NOT override an already-set process.env value.
		expect(process.env['STARTUP_EXPORTED']).toBe('exported-wins');
	});

	it('uses the .env.local value when the var is NOT exported', async () => {
		writeFileSync(
			join(fixtureDir, '.env.local'),
			'STARTUP_EXPORTED=from-local-file\n',
			'utf8',
		);
		process.chdir(fixtureDir);

		// Not exported ⇒ the file value is used.
		await main(['version']);
		expect(process.env['STARTUP_EXPORTED']).toBe('from-local-file');
	});

	it('layers .env below .env.local: .env-only vars load, .env.local overrides shared ones', async () => {
		writeFileSync(
			join(fixtureDir, '.env'),
			'STARTUP_ONLY_ENV=only-env\nSTARTUP_EXPORTED=from-plain-env\n',
			'utf8',
		);
		writeFileSync(
			join(fixtureDir, '.env.local'),
			'STARTUP_EXPORTED=from-local-file\n',
			'utf8',
		);
		process.chdir(fixtureDir);

		await main(['version']);
		// A var only in .env is loaded.
		expect(process.env['STARTUP_ONLY_ENV']).toBe('only-env');
		// .env.local overrides the same var in .env.
		expect(process.env['STARTUP_EXPORTED']).toBe('from-local-file');
	});

	it('is a no-op when the cwd has no .env / .env.local (does not throw, touches nothing)', async () => {
		// Empty fixture dir: no dotenv files present.
		process.chdir(fixtureDir);
		const code = await main(['version']);
		expect(code).toBe(0);
		// None of the fixture keys got set out of thin air.
		expect(process.env['STARTUP_ONLY_LOCAL']).toBeUndefined();
		expect(process.env['STARTUP_ONLY_ENV']).toBeUndefined();
	});

	it('runs loadEnv BEFORE run(): the shim loads dotenv, then dispatches', async () => {
		// Assert ORDER with an injected loadDotEnv seam: it must have been called
		// before run() dispatches (here, before the version command prints).
		const events: string[] = [];
		const originalLog = console.log;
		console.log = (...args: unknown[]) => {
			events.push(`run:${String(args[0])}`);
		};
		try {
			await main(['version'], {
				loadDotEnv: () => events.push('loadEnv'),
			});
		} finally {
			console.log = originalLog;
		}
		expect(events[0]).toBe('loadEnv');
		// `version` prints the resolved version; compared against the shared source
		// of truth so a package bump never reddens this ordering test.
		expect(events).toContain(`run:${PINNACE_VERSION}`);
	});

	it('keeps run() hermetic: an injected env is used verbatim, no real .env read', async () => {
		// This drives run() DIRECTLY (not the shim) inside an isolated cwd that
		// DOES have a .env.local — proving run() never reads it: only the
		// injected env reaches the resolver.
		writeFileSync(
			join(fixtureDir, '.env.local'),
			'PINNACE_MASTER=should-not-be-read\n',
			'utf8',
		);
		process.chdir(fixtureDir);

		const calls: unknown[] = [];
		const deps: Partial<ClientDeps> = {
			deriveIpnsId: (input) => {
				calls.push(input);
				return 'k51stub';
			},
		};
		const out: string[] = [];
		const context: RunContext = {
			env: {PINNACE_MASTER: 'injected-master'},
			deps: deps as ClientDeps,
			out: (line) => out.push(line),
			err: () => {},
			loadConfigFile: () => ({}),
		};

		const code = await run(['derive', 'mysite'], context);
		expect(code).toBe(0);
		// The INJECTED master reached the core, NOT the .env.local value.
		expect(calls).toEqual([{master: 'injected-master', keyId: 'mysite'}]);
		// And the real .env.local master never leaked into the injected env path.
		expect(process.env['PINNACE_MASTER']).toBeUndefined();
	});
});
