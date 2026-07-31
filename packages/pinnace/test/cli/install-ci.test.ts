import {describe, it, expect, vi, afterEach} from 'vitest';
import {mkdtempSync, readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {run, type RunContext} from '../../src/cli/run.js';
import {emitCi, emittedDeployArgv} from '../../src/ci/ci-emit.js';
import {MockKuboApi} from '../../src/rpc/mock-kubo.js';

/**
 * THE ACCEPTANCE TEST THE EMITTER NEVER HAD.
 *
 * `install-ci`'s output used to be checked only against its own snapshot, so it
 * passed CI for months while emitting a workflow whose deploy step named env
 * vars (`IPFS_API`, `IPFS_TOKEN`, `SITE_NAME`) that NOTHING in the CLI read:
 * every generated pipeline would have failed on its first run. See
 * `work/notes/findings/install-ci-emits-a-workflow-the-cli-cannot-execute.md`.
 *
 * The fix is to close the loop HERE: take the argv the emitted step actually
 * runs ({@link emittedDeployArgv}, the single source the YAML renders from) and
 * feed it to the REAL `run()` dispatch against recording mock Kubo nodes, with
 * ONLY the secrets the emitted report asks for present in the environment. If
 * the emitter ever again names a flag or variable the CLI does not honour, this
 * fails. A golden string cannot.
 */

/** Route one global `fetch` across several per-node mocks by origin. */
function router(mocks: MockKuboApi[]): typeof fetch {
	return (async (input: string | URL, init?: RequestInit) => {
		const url = new URL(typeof input === 'string' ? input : input.toString());
		const mock = mocks.find((m) => new URL(m.baseUrl).origin === url.origin);
		if (!mock) throw new Error(`no mock node for ${url.origin}`);
		return mock.fetchImpl(input, init as never);
	}) as unknown as typeof fetch;
}

/** A node that answers everything a deploy asks of it. */
function mockNode(baseUrl: string): MockKuboApi {
	const mock = new MockKuboApi(baseUrl);
	mock.on('dag/import', {json: {Root: {Cid: {'/': 'bafyroot'}}}});
	mock.on('key/list', {json: {Keys: []}});
	return mock;
}

/** A directory with a file in it, so the CAR builder has something to build. */
function siteDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'pinnace-ci-site-'));
	writeFileSync(join(dir, 'index.html'), '<h1>hi</h1>');
	return dir;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('install-ci: the emitted pipeline actually deploys', () => {
	it('runs its own emitted argv through the real CLI, on every node it named', async () => {
		const publisher = mockNode('https://publisher.test');
		const replica = mockNode('https://replica.test');
		vi.stubGlobal('fetch', router([publisher, replica]));

		const input = {
			system: 'github' as const,
			site: 'mandalas.eth',
			outputDir: siteDir(),
			mode: 'ipfs' as const,
			endpoint: publisher.baseUrl,
			replicaEndpoints: [replica.baseUrl],
		};
		const emitted = emitCi(input);

		// The ONLY environment the pipeline gets is what its report asks for:
		// one bearer token per node, named by the report itself.
		const env: Record<string, string> = {};
		for (const secret of emitted.secrets.filter((s) => !s.optional)) {
			env[secret.name] = `token-for-${secret.name}`;
		}
		expect(Object.keys(env)).toEqual([
			'PINNACE_HOST_PUBLISHER_TOKEN',
			'PINNACE_HOST_REPLICA_1_TOKEN',
		]);

		const out: string[] = [];
		const err: string[] = [];
		const context: RunContext = {
			env,
			// No pinnace.json anywhere: the pipeline describes its nodes as args.
			loadConfigFile: () => ({}),
			out: (line) => out.push(line),
			err: (line) => err.push(line),
		};

		const code = await run(emittedDeployArgv(input), context);
		expect(err).toEqual([]);
		expect(code).toBe(0);

		// Both nodes were deployed to (a replica that never receives the CAR would
		// keep serving the previous build: `mirror` replicates records, not content).
		for (const node of [publisher, replica]) {
			expect(node.requestsFor('dag/import').length).toBe(1);
			expect(node.requestsFor('files/write').length).toBeGreaterThan(0);
		}
		// Each node was addressed with ITS OWN token, exactly as the report named.
		expect(publisher.lastRequest!.headers.authorization).toBe(
			'Bearer token-for-PINNACE_HOST_PUBLISHER_TOKEN',
		);
		expect(replica.lastRequest!.headers.authorization).toBe(
			'Bearer token-for-PINNACE_HOST_REPLICA_1_TOKEN',
		);

		// `--json` gives the composite action ONE object to read `.cid` from.
		expect(out).toHaveLength(1);
		const report = JSON.parse(out[0]) as {
			cid: string;
			mode: string;
			success: boolean;
			ok: Array<{endpoint: string}>;
		};
		expect(report.success).toBe(true);
		expect(report.mode).toBe('ipfs');
		expect(report.cid).toMatch(/^baf/);
		expect(report.ok.map((n) => n.endpoint).sort()).toEqual([
			'https://publisher.test',
			'https://replica.test',
		]);
	});

	it('an ipfs-mode pipeline needs no master at all', async () => {
		const publisher = mockNode('https://publisher.test');
		vi.stubGlobal('fetch', router([publisher]));
		const input = {
			system: 'github' as const,
			site: 'mandalas.eth',
			outputDir: siteDir(),
			mode: 'ipfs' as const,
			endpoint: publisher.baseUrl,
		};
		const err: string[] = [];
		const code = await run(emittedDeployArgv(input), {
			env: {PINNACE_HOST_PUBLISHER_TOKEN: 'tok'},
			loadConfigFile: () => ({}),
			out: () => {},
			err: (line) => err.push(line),
		});
		expect(code).toBe(0);
		expect(err).toEqual([]);
		// Nothing was signed: no key touched, no record published.
		expect(publisher.requestsFor('name/publish')).toEqual([]);
		expect(publisher.requestsFor('key/import')).toEqual([]);
	});

	it('fails loudly when a named node has no token secret set', async () => {
		const publisher = mockNode('https://publisher.test');
		vi.stubGlobal('fetch', router([publisher]));
		const input = {
			system: 'github' as const,
			site: 'mandalas.eth',
			outputDir: siteDir(),
			mode: 'ipfs' as const,
			endpoint: publisher.baseUrl,
		};
		const err: string[] = [];
		const code = await run(emittedDeployArgv(input), {
			env: {},
			loadConfigFile: () => ({}),
			out: () => {},
			err: (line) => err.push(line),
		});
		expect(code).toBe(1);
		// It names the exact variable the emitted report told you to set.
		expect(err.join('\n')).toContain('PINNACE_HOST_PUBLISHER_TOKEN');
		expect(publisher.requests).toEqual([]);
	});
});

describe('install-ci: the CLI surface', () => {
	function ctx(env: Record<string, string> = {}): {
		context: RunContext;
		out: string[];
		err: string[];
	} {
		const out: string[] = [];
		const err: string[] = [];
		return {
			context: {
				env,
				loadConfigFile: () => ({}),
				out: (line) => out.push(line),
				err: (line) => err.push(line),
			},
			out,
			err,
		};
	}

	it('reads the nodes from the GLOBAL --endpoint / --replica-endpoint flags', async () => {
		const {context, out} = ctx();
		const code = await run(
			[
				'install-ci',
				'--system',
				'github',
				'--site',
				'mysite.eth',
				'--output-dir',
				'dist',
				'--endpoint',
				'https://a.test',
				'--replica-endpoint',
				'https://b.test',
				'--replica-endpoint',
				'https://c.test',
			],
			context,
		);
		expect(code).toBe(0);
		const printed = out.join('\n');
		expect(printed).toContain('endpoint: https://a.test');
		expect(printed).toContain('https://b.test');
		expect(printed).toContain('https://c.test');
		expect(printed).toContain('PINNACE_HOST_REPLICA_2_TOKEN');
	});

	it('refuses replicas with no publisher, before emitting anything', async () => {
		const {context, out, err} = ctx();
		const code = await run(
			[
				'install-ci',
				'--system',
				'github',
				'--site',
				'mysite.eth',
				'--output-dir',
				'dist',
				'--replica-endpoint',
				'https://b.test',
			],
			context,
		);
		expect(code).toBe(1);
		expect(err.join('\n')).toMatch(/--replica-endpoint needs --endpoint/);
		expect(out).toEqual([]);
	});

	it('refuses the same replica twice (a typo, not redundancy)', async () => {
		const {context, err} = ctx();
		const code = await run(
			[
				'install-ci',
				'--system',
				'github',
				'--site',
				'x',
				'--output-dir',
				'dist',
				'--endpoint',
				'https://a.test',
				'--replica-endpoint',
				'https://b.test',
				'--replica-endpoint',
				'https://b.test',
			],
			context,
		);
		expect(code).toBe(1);
		expect(err.join('\n')).toMatch(/given more than once/);
	});

	it('requires the site id and the output dir, and says how to call it', async () => {
		const {context, err} = ctx();
		const code = await run(['install-ci', '--system', 'github'], context);
		expect(code).toBe(1);
		expect(err.join('\n')).toContain('site');
		expect(err.join('\n')).toContain('output-dir');
		expect(err.join('\n')).toContain('usage: pinnace install-ci');
	});

	it('refuses an unknown --emit / --package-manager / --set-mode value', async () => {
		for (const [flag, value, pattern] of [
			['--emit', 'everything', /--emit must be one of/],
			['--package-manager', 'bun', /--package-manager must be one of/],
			['--set-mode', 'ipfsish', /--set-mode must be/],
		] as const) {
			const {context, err} = ctx();
			const code = await run(
				[
					'install-ci',
					'--system',
					'github',
					'--site',
					'x',
					'--output-dir',
					'dist',
					flag,
					value,
				],
				context,
			);
			expect(code).toBe(1);
			expect(err.join('\n')).toMatch(pattern);
		}
	});

	it('refuses --build-command with --emit steps (the fragment owns no build)', async () => {
		const {context, err} = ctx();
		const code = await run(
			[
				'install-ci',
				'--system',
				'github',
				'--site',
				'x',
				'--output-dir',
				'dist',
				'--emit',
				'steps',
				'--build-command',
				'npm run build',
			],
			context,
		);
		expect(code).toBe(1);
		expect(err.join('\n')).toMatch(/--build-command means nothing/);
	});
});

describe('install-ci --write: installs, but never clobbers', () => {
	function inDir<T>(dir: string, fn: () => T): T {
		const cwd = process.cwd();
		process.chdir(dir);
		try {
			return fn();
		} finally {
			process.chdir(cwd);
		}
	}

	const args = [
		'install-ci',
		'--system',
		'github',
		'--site',
		'mysite.eth',
		'--output-dir',
		'dist',
		'--endpoint',
		'https://a.test',
	];

	it('writes the workflow where GitHub expects it', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'pinnace-ci-write-'));
		const out: string[] = [];
		const code = await inDir(dir, () =>
			run([...args, '--write'], {
				env: {},
				loadConfigFile: () => ({}),
				out: (line) => out.push(line),
				err: () => {},
			}),
		);
		expect(await code).toBe(0);
		const written = readFileSync(
			join(dir, '.github/workflows/pinnace-deploy.yml'),
			'utf8',
		);
		expect(written).toContain('uses: wighawag/pinnace/actions/deploy@');
		expect(out.join('\n')).toContain(
			'wrote .github/workflows/pinnace-deploy.yml',
		);
	});

	it('refuses to overwrite an existing workflow without --force', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'pinnace-ci-write-'));
		mkdirSync(join(dir, '.github/workflows'), {recursive: true});
		writeFileSync(join(dir, '.github/workflows/pinnace-deploy.yml'), 'mine\n');
		const err: string[] = [];
		const code = await inDir(dir, () =>
			run([...args, '--write'], {
				env: {},
				loadConfigFile: () => ({}),
				out: () => {},
				err: (line) => err.push(line),
			}),
		);
		expect(await code).toBe(1);
		expect(err.join('\n')).toMatch(/already exists.*--force/s);
		expect(
			readFileSync(join(dir, '.github/workflows/pinnace-deploy.yml'), 'utf8'),
		).toBe('mine\n');

		const forced = await inDir(dir, () =>
			run([...args, '--write', '--force'], {
				env: {},
				loadConfigFile: () => ({}),
				out: () => {},
				err: () => {},
			}),
		);
		expect(await forced).toBe(0);
		expect(
			readFileSync(join(dir, '.github/workflows/pinnace-deploy.yml'), 'utf8'),
		).toContain('name: Deploy to IPFS');
	});

	it('refuses to write a paste-in fragment (it is not a workflow)', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'pinnace-ci-write-'));
		const err: string[] = [];
		const code = await inDir(dir, () =>
			run([...args, '--emit', 'steps', '--write'], {
				env: {},
				loadConfigFile: () => ({}),
				out: () => {},
				err: (line) => err.push(line),
			}),
		);
		expect(await code).toBe(1);
		expect(err.join('\n')).toMatch(/fragment to paste/);
	});
});
