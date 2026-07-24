import {describe, it, expect} from 'vitest';
import {run, type ClientDeps, type RunContext} from '../../src/cli/run.js';
import type {PinnaceConfigFile} from '../../src/config/config-resolution.js';

/**
 * These tests prove the CLIENT-facing verbs (provision, deploy, install-ci,
 * status, derive) are THIN wrappers: each parses/validates args, resolves
 * config with precedence arg > env > file, calls the CORRECT core function
 * with the correctly-resolved arguments, and formats the result. They stub the
 * core (the injectable {@link ClientDeps} seam) and assert the DISPATCH — they
 * do NOT re-test the core's internals (that lives in each core module's own
 * test).
 *
 * They ISOLATE env/config: every test builds an in-memory `env` record and an
 * in-memory `pinnace.json` object and passes them through the {@link RunContext},
 * so the operator's REAL environment (`process.env`) and REAL config file are
 * NEVER read or mutated. The assertions below explicitly check that.
 */

/** A recording set of stub core deps; every call is captured for assertions. */
function recordingDeps(): {deps: ClientDeps; calls: Record<string, unknown[]>} {
	const calls: Record<string, unknown[]> = {
		provision: [],
		deploy: [],
		emitCi: [],
		statusReport: [],
		deriveIpnsId: [],
	};
	const deps: Partial<ClientDeps> = {
		provision: (input) => {
			calls.provision.push(input);
			return {
				host: 'hetzner',
				cloudInit: {path: 'cloud-init.yaml', contents: '#cloud-config\n'},
			};
		},
		deploy: async (input) => {
			calls.deploy.push(input);
			return {
				cid: 'bafyStub',
				mode: input.mode,
				ok: [{baseUrl: 'https://a', cid: 'bafyStub', published: false}],
				failed: [],
				success: true,
			};
		},
		emitCi: (input) => {
			calls.emitCi.push(input);
			return {
				system: 'github',
				workflow: {path: '.github/workflows/pinnace-deploy.yml', contents: ''},
				secrets: [],
				vars: [],
			};
		},
		statusReport: async (input) => {
			calls.statusReport.push(input);
			return {peerId: 'peer-stub', sites: []};
		},
		deriveIpnsId: (input) => {
			calls.deriveIpnsId.push(input);
			return 'k51stubid';
		},
	};
	return {deps: deps as ClientDeps, calls};
}

/** A representative in-memory pinnace.json for the resolution tests. */
const fileConfig: PinnaceConfigFile = {
	hosts: [
		{
			name: 'a',
			endpoint: 'https://a.example',
			token: 'file-token-a',
			role: 'publisher',
		},
		{
			name: 'b',
			endpoint: 'https://b.example',
			token: 'file-token-b',
			role: 'replica',
			publisherEndpoint: 'https://a.example/records',
		},
	],
	sites: [
		{
			name: 'mysite.eth',
			mode: 'ipns',
			keyId: 'kid-1',
			ensName: 'mysite.eth',
			sourceDir: './dist',
		},
	],
	gateways: ['https://dweb.link'],
};

/** Build a RunContext with in-memory env + config (real env/file untouched). */
function ctx(overrides: Partial<RunContext> = {}): {
	context: RunContext;
	out: string[];
	err: string[];
} {
	const out: string[] = [];
	const err: string[] = [];
	const context: RunContext = {
		env: {},
		loadConfigFile: () => fileConfig,
		out: (line) => out.push(line),
		err: (line) => err.push(line),
		...overrides,
	};
	return {context, out, err};
}

describe('pinnace client CLI — command surface', () => {
	it('exposes the v1 client verbs (provision, deploy, install-ci, status, derive)', async () => {
		// A bare invocation with no command is a benign help/no-op (exit 0),
		// while an unknown command is loud (non-zero) — proving the surface is
		// an explicit allow-list, not a silent catch-all.
		const {deps} = recordingDeps();
		const {context} = ctx({deps});
		expect(await run(['nonsense-command'], context)).not.toBe(0);
	});
});

describe('provision — dispatches to core provision with resolved args', () => {
	it('parses args and calls core provision, printing the cloud-init', async () => {
		const {deps, calls} = recordingDeps();
		const {context, out} = ctx({deps});
		const code = await run(
			[
				'provision',
				'--host',
				'hetzner',
				'--api-domain',
				'ipfs.example.com',
				'--acme-email',
				'ops@example.com',
				'--bearer-token',
				'tok-123',
				'--role',
				'publisher',
			],
			context,
		);
		expect(code).toBe(0);
		expect(calls.provision.length).toBe(1);
		expect(calls.provision[0]).toMatchObject({
			host: 'hetzner',
			apiDomain: 'ipfs.example.com',
			acmeEmail: 'ops@example.com',
			bearerToken: 'tok-123',
			role: 'publisher',
		});
		// It formats the core result (the cloud-init contents) to stdout.
		expect(out.join('\n')).toContain('#cloud-config');
	});
});

describe('deploy <dir> <site> — dispatches to core deploy with resolved targets', () => {
	it('resolves nodes/mode from config and calls core deploy with them', async () => {
		const {deps, calls} = recordingDeps();
		const {context} = ctx({deps});
		const code = await run(['deploy', './dist', 'mysite.eth'], context);
		expect(code).toBe(0);
		expect(calls.deploy.length).toBe(1);
		const input = calls.deploy[0] as {
			sourceDir?: string;
			name: string;
			mode: string;
			targets: Array<{baseUrl: string; token: string; role: string}>;
		};
		expect(input.sourceDir).toBe('./dist');
		expect(input.name).toBe('mysite.eth');
		// mode comes from the matching site entry in pinnace.json.
		expect(input.mode).toBe('ipns');
		// One target per configured host, each with its OWN token, publisher first.
		expect(input.targets.map((t) => t.baseUrl)).toEqual([
			'https://a.example',
			'https://b.example',
		]);
		expect(input.targets.map((t) => t.token)).toEqual([
			'file-token-a',
			'file-token-b',
		]);
		expect(input.targets.map((t) => t.role)).toEqual(['publisher', 'replica']);
	});

	it('a --mode arg OVERRIDES the site mode (arg > file)', async () => {
		const {deps, calls} = recordingDeps();
		const {context} = ctx({deps});
		await run(['deploy', '--mode', 'ipfs', './dist', 'mysite.eth'], context);
		expect((calls.deploy[0] as {mode: string}).mode).toBe('ipfs');
	});

	it('an env host token OVERRIDES the file token (env > file)', async () => {
		const {deps, calls} = recordingDeps();
		const {context} = ctx({
			deps,
			env: {PINNACE_HOST_A_TOKEN: 'env-token-a'},
		});
		await run(['deploy', './dist', 'mysite.eth'], context);
		const input = calls.deploy[0] as {
			targets: Array<{baseUrl: string; token: string}>;
		};
		expect(input.targets[0].token).toBe('env-token-a');
	});
});

describe('install-ci — dispatches to core emitCi with resolved args', () => {
	it('parses args and calls core emitCi, reporting the workflow + secrets/vars', async () => {
		const {deps, calls} = recordingDeps();
		const {context} = ctx({deps});
		const code = await run(
			[
				'install-ci',
				'--system',
				'github',
				'--build-command',
				'npm run build',
				'--output-dir',
				'dist',
			],
			context,
		);
		expect(code).toBe(0);
		expect(calls.emitCi.length).toBe(1);
		expect(calls.emitCi[0]).toMatchObject({
			system: 'github',
			buildCommand: 'npm run build',
			outputDir: 'dist',
		});
	});
});

describe('status — dispatches to core statusReport per site', () => {
	it('builds a Kubo client from the resolved host and calls core statusReport', async () => {
		const {deps, calls} = recordingDeps();
		const {context} = ctx({deps});
		const code = await run(['status'], context);
		expect(code).toBe(0);
		// One report per configured host (each node reports its own sites).
		expect(calls.statusReport.length).toBe(fileConfig.hosts!.length);
		// The core is handed a real client object (the seam), not raw URLs.
		const input = calls.statusReport[0] as {client: unknown};
		expect(input.client).toBeTruthy();
	});
});

describe('derive — prints a site IPNS id from master + keyId, NO deploy', () => {
	it('reads the master ENV-ONLY, resolves keyId, and prints the id (no core deploy)', async () => {
		const {deps, calls} = recordingDeps();
		const {context, out} = ctx({
			deps,
			env: {PINNACE_MASTER: 'the-master-secret'},
		});
		const code = await run(['derive', 'mysite.eth'], context);
		expect(code).toBe(0);
		expect(calls.deriveIpnsId.length).toBe(1);
		expect(calls.deriveIpnsId[0]).toMatchObject({
			master: 'the-master-secret',
			// keyId comes from the site entry, NOT the ENS name.
			keyId: 'kid-1',
		});
		// It prints the id and never triggers a deploy.
		expect(out.join('\n')).toContain('k51stubid');
		expect(calls.deploy.length).toBe(0);
	});

	it('FAILS loudly when the master is absent (env-only; never from the file)', async () => {
		const {deps, calls} = recordingDeps();
		// No PINNACE_MASTER in env; a decoy master in the file must NOT be used.
		const decoyFile = {
			...fileConfig,
			master: 'DECOY-FROM-FILE',
		} as PinnaceConfigFile;
		const {context, err} = ctx({
			deps,
			env: {},
			loadConfigFile: () => decoyFile,
		});
		const code = await run(['derive', 'mysite.eth'], context);
		expect(code).not.toBe(0);
		expect(calls.deriveIpnsId.length).toBe(0);
		expect(err.join('\n')).toMatch(/master/i);
	});
});

describe('env/config isolation — the operator real environment is untouched', () => {
	it('never reads process.env or a real pinnace.json (all via the injected context)', async () => {
		const {deps, calls} = recordingDeps();
		// Set a sentinel on the REAL process.env; the CLI must NOT read it,
		// because it resolves through the injected in-memory env instead.
		const sentinelKey = 'PINNACE_HOST_A_TOKEN';
		const hadSentinel = Object.prototype.hasOwnProperty.call(
			process.env,
			sentinelKey,
		);
		const previous = process.env[sentinelKey];
		process.env[sentinelKey] = 'REAL-ENV-SHOULD-NOT-LEAK';
		try {
			const {context} = ctx({deps, env: {}});
			await run(['deploy', './dist', 'mysite.eth'], context);
			const input = calls.deploy[0] as {
				targets: Array<{token: string}>;
			};
			// The token came from the in-memory FILE, NOT the real process.env.
			expect(input.targets[0].token).toBe('file-token-a');
			expect(input.targets[0].token).not.toBe('REAL-ENV-SHOULD-NOT-LEAK');
		} finally {
			if (hadSentinel) process.env[sentinelKey] = previous;
			else delete process.env[sentinelKey];
		}
	});
});
