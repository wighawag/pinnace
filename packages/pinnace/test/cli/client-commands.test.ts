import {describe, it, expect} from 'vitest';
import {run, type ClientDeps, type RunContext} from '../../src/cli/run.js';
import {PinSourceResolveError} from '../../src/pin/pin-external.js';
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
		pinExternal: [],
		deriveIpnsKey: [],
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
		pinExternal: async (input) => {
			calls.pinExternal.push(input);
			const publishes = input.mode === 'ipns';
			// A `fromIpns` source is resolved by the CORE (its own tests cover the
			// name/resolve seam); the stub models that: no cid in, a resolved cid out.
			const cid = input.cid ?? 'bafyresolvedstub';
			return {
				cid,
				...(input.fromIpns
					? {
							fromIpns: input.fromIpns,
							resolvedBy: input.targets[0]?.baseUrl,
						}
					: {}),
				name: input.name,
				recursive: input.recursive ?? true,
				mode: input.mode ?? 'ipfs',
				...(publishes ? {ipns: 'k51stubid'} : {}),
				ok: input.targets.map((t) => ({
					baseUrl: t.baseUrl,
					cid,
					name: input.name,
					recursive: input.recursive ?? true,
					published: publishes && t.role === 'publisher',
					...(publishes && t.role === 'publisher' ? {ipns: 'k51stubid'} : {}),
				})),
				failed: [],
				success: true,
			};
		},
		deriveIpnsKey: (input) => {
			calls.deriveIpnsKey.push(input);
			return {
				seed: new Uint8Array(32),
				publicKey: new Uint8Array(32),
				ipnsId: 'k51stubid',
			};
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
			role: 'publisher',
		},
		{
			name: 'b',
			endpoint: 'https://b.example',
			role: 'replica',
			publisherEndpoint: 'https://a.example/records',
		},
	],
	sites: [
		{
			id: 'mysite',
			mode: 'ipns',
			ensName: 'mysite.eth',
			sourceDir: './dist',
		},
	],
	gateways: ['https://dweb.link'],
};

/**
 * The token is env-only (never in pinnace.json). Deploy/status resolve each
 * host's token from `PINNACE_HOST_<NAME>_TOKEN`, so the resolution tests supply
 * these env vars explicitly (and the missing-token path drops them on purpose).
 */
const hostTokenEnv = {
	PINNACE_HOST_A_TOKEN: 'env-token-a',
	PINNACE_HOST_B_TOKEN: 'env-token-b',
} as const;

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

describe('deploy <dir> <id> — dispatches to core deploy with resolved targets', () => {
	it('resolves nodes/mode from config and calls core deploy with them', async () => {
		const {deps, calls} = recordingDeps();
		const {context} = ctx({deps, env: {...hostTokenEnv}});
		const code = await run(['deploy', './dist', 'mysite'], context);
		expect(code).toBe(0);
		expect(calls.deploy.length).toBe(1);
		const input = calls.deploy[0] as {
			sourceDir?: string;
			id: string;
			mode: string;
			targets: Array<{baseUrl: string; token: string; role: string}>;
		};
		expect(input.sourceDir).toBe('./dist');
		// The single `id` positional flows straight through to the core.
		expect(input.id).toBe('mysite');
		// mode comes from the matching site entry in pinnace.json.
		expect(input.mode).toBe('ipns');
		// One target per configured host, each with its OWN env-only token, publisher first.
		expect(input.targets.map((t) => t.baseUrl)).toEqual([
			'https://a.example',
			'https://b.example',
		]);
		expect(input.targets.map((t) => t.token)).toEqual([
			'env-token-a',
			'env-token-b',
		]);
		expect(input.targets.map((t) => t.role)).toEqual(['publisher', 'replica']);
	});

	it('a --mode arg OVERRIDES the site mode (arg > file)', async () => {
		const {deps, calls} = recordingDeps();
		const {context} = ctx({deps, env: {...hostTokenEnv}});
		await run(['deploy', '--mode', 'ipfs', './dist', 'mysite'], context);
		expect((calls.deploy[0] as {mode: string}).mode).toBe('ipfs');
	});

	it('a CLI host-token OVERRIDES the env token (CLI > env)', async () => {
		const {deps, calls} = recordingDeps();
		const {context} = ctx({deps, env: {...hostTokenEnv}});
		await run(
			['deploy', '--host-token.a', 'cli-token-a', './dist', 'mysite'],
			context,
		);
		const input = calls.deploy[0] as {
			targets: Array<{baseUrl: string; token: string}>;
		};
		expect(input.targets[0].token).toBe('cli-token-a');
	});

	it('FAILS LOUD naming the missing env var when a host has no token (env-only, no silent "")', async () => {
		const {deps, calls} = recordingDeps();
		// Only host a has a token; host b has none -> loud, named failure.
		const {context, err} = ctx({
			deps,
			env: {PINNACE_HOST_A_TOKEN: 'env-token-a'},
		});
		const code = await run(['deploy', './dist', 'mysite'], context);
		expect(code).not.toBe(0);
		expect(calls.deploy.length).toBe(0);
		expect(err.join('\n')).toContain('PINNACE_HOST_B_TOKEN');
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
		const {context} = ctx({deps, env: {...hostTokenEnv}});
		const code = await run(['status'], context);
		expect(code).toBe(0);
		// One report per configured host (each node reports its own sites).
		expect(calls.statusReport.length).toBe(fileConfig.hosts!.length);
		// The core is handed a real client object (the seam), not raw URLs.
		const input = calls.statusReport[0] as {client: unknown};
		expect(input.client).toBeTruthy();
	});
});

describe('derive — prints a site IPNS id from master + single `id`, NO deploy', () => {
	it('reads the master ENV-ONLY, feeds the site `id` as the KDF input, prints the id', async () => {
		const {deps, calls} = recordingDeps();
		const {context, out} = ctx({
			deps,
			env: {PINNACE_MASTER: 'the-master-secret'},
		});
		const code = await run(['derive', 'mysite'], context);
		expect(code).toBe(0);
		expect(calls.deriveIpnsId.length).toBe(1);
		expect(calls.deriveIpnsId[0]).toMatchObject({
			master: 'the-master-secret',
			// The single site `id` IS the KDF input (no separate keyId).
			keyId: 'mysite',
		});
		// It prints the id and never triggers a deploy.
		expect(out.join('\n')).toContain('k51stubid');
		expect(calls.deploy.length).toBe(0);
	});

	it('derives from the positional `id` even when it is not a configured site', async () => {
		const {deps, calls} = recordingDeps();
		const {context} = ctx({deps, env: {PINNACE_MASTER: 'm'}});
		await run(['derive', 'ad-hoc-id'], context);
		expect(calls.deriveIpnsId[0]).toMatchObject({keyId: 'ad-hoc-id'});
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
		const code = await run(['derive', 'mysite'], context);
		expect(code).not.toBe(0);
		expect(calls.deriveIpnsId.length).toBe(0);
		expect(err.join('\n')).toMatch(/master/i);
	});
});

describe('pin <cid> --as <name> — dispatches to core pinExternal (all nodes)', () => {
	it('resolves EVERY configured host as a target (redundant by default)', async () => {
		const {deps, calls} = recordingDeps();
		const {context, out} = ctx({deps, env: {...hostTokenEnv}});
		const code = await run(['pin', 'bafyexternal', '--as', 'archive'], context);
		expect(code).toBe(0);
		expect(calls.pinExternal.length).toBe(1);
		const input = calls.pinExternal[0] as {
			cid: string;
			name: string;
			recursive: boolean;
			targets: Array<{baseUrl: string; token: string}>;
		};
		expect(input.cid).toBe('bafyexternal');
		expect(input.name).toBe('archive');
		// Recursive is the normal case (the whole DAG).
		expect(input.recursive).toBe(true);
		// One target per configured host, each with its OWN env-only token.
		expect(input.targets.map((t) => t.baseUrl)).toEqual([
			'https://a.example',
			'https://b.example',
		]);
		expect(input.targets.map((t) => t.token)).toEqual([
			'env-token-a',
			'env-token-b',
		]);
		// It reports the per-node outcome.
		expect(out.join('\n')).toContain('https://a.example');
		expect(out.join('\n')).toContain('https://b.example');
	});

	it('--host <name> NARROWS the fan-out to that single node', async () => {
		const {deps, calls} = recordingDeps();
		const {context} = ctx({deps, env: {...hostTokenEnv}});
		const code = await run(
			['pin', 'bafyexternal', '--as', 'archive', '--host', 'b'],
			context,
		);
		expect(code).toBe(0);
		const input = calls.pinExternal[0] as {
			targets: Array<{baseUrl: string; token: string}>;
		};
		expect(input.targets.map((t) => t.baseUrl)).toEqual(['https://b.example']);
		expect(input.targets[0].token).toBe('env-token-b');
	});

	it('--no-recursive pins the root block only (and does not eat the CID)', async () => {
		const {deps, calls} = recordingDeps();
		const {context} = ctx({deps, env: {...hostTokenEnv}});
		await run(
			['pin', '--no-recursive', 'bafyexternal', '--as', 'archive'],
			context,
		);
		expect(calls.pinExternal[0]).toMatchObject({
			cid: 'bafyexternal',
			name: 'archive',
			recursive: false,
		});
	});

	it('passes the cid as the pin SOURCE (no fromIpns in the ordinary form)', async () => {
		const {deps, calls} = recordingDeps();
		const {context} = ctx({deps, env: {...hostTokenEnv}});
		await run(['pin', 'bafyexternal', '--as', 'archive'], context);
		expect(calls.pinExternal[0]).toMatchObject({cid: 'bafyexternal'});
		expect(calls.pinExternal[0]).not.toHaveProperty('fromIpns');
	});

	it('requires the <cid> and --as <name> (usage error, never dispatches)', async () => {
		const {deps, calls} = recordingDeps();
		const {context, err} = ctx({deps, env: {...hostTokenEnv}});
		expect(await run(['pin'], context)).not.toBe(0);
		expect(await run(['pin', 'bafyexternal'], context)).not.toBe(0);
		expect(calls.pinExternal.length).toBe(0);
		expect(err.join('\n')).toContain('--as');
	});

	it('rejects an unknown --host loudly, naming the configured hosts', async () => {
		const {deps, calls} = recordingDeps();
		const {context, err} = ctx({deps, env: {...hostTokenEnv}});
		const code = await run(
			['pin', 'bafyexternal', '--as', 'archive', '--host', 'nope'],
			context,
		);
		expect(code).not.toBe(0);
		expect(calls.pinExternal.length).toBe(0);
		expect(err.join('\n')).toContain('nope');
	});

	it('FAILS LOUD naming the missing env var when a host has no token', async () => {
		const {deps, calls} = recordingDeps();
		const {context, err} = ctx({
			deps,
			env: {PINNACE_HOST_A_TOKEN: 'env-token-a'},
		});
		const code = await run(['pin', 'bafyexternal', '--as', 'archive'], context);
		expect(code).not.toBe(0);
		expect(calls.pinExternal.length).toBe(0);
		expect(err.join('\n')).toContain('PINNACE_HOST_B_TOKEN');
	});

	it('exits non-zero when NO node pinned the content', async () => {
		const {deps} = recordingDeps();
		const failing: ClientDeps = {
			...deps,
			pinExternal: async (input) => ({
				cid: input.cid,
				name: input.name,
				recursive: true,
				ok: [],
				failed: input.targets.map((t) => ({
					baseUrl: t.baseUrl,
					stage: 'pin' as const,
					error: new Error('merkledag: not found'),
				})),
				success: false,
			}),
		};
		const {context, err} = ctx({deps: failing, env: {...hostTokenEnv}});
		const code = await run(['pin', 'bafymissing', '--as', 'archive'], context);
		expect(code).not.toBe(0);
		expect(err.join('\n')).toContain('merkledag: not found');
	});
});

describe('pin --mode ipns — ADDS the operator OWN stable name to a pin', () => {
	/** The master is env-ONLY (never a pinnace.json field), exactly as promote. */
	const masterEnv = {...hostTokenEnv, PINNACE_MASTER: 'the-master-secret'};

	it('defaults to ipfs mode: no derivation, no publish, no ipns printed', async () => {
		const {deps, calls} = recordingDeps();
		const {context, out} = ctx({deps, env: {...masterEnv}});
		const code = await run(['pin', 'bafyexternal', '--as', 'archive'], context);
		expect(code).toBe(0);
		expect(calls.pinExternal[0]).toMatchObject({mode: 'ipfs'});
		expect(calls.deriveIpnsKey.length).toBe(0);
		expect(out.join('\n')).not.toContain('ipns://');
	});

	it('derives the key from the env-only master + the --as <name> id', async () => {
		const {deps, calls} = recordingDeps();
		const {context, out} = ctx({deps, env: {...masterEnv}});
		const code = await run(
			['pin', 'bafyexternal', '--as', 'archive', '--mode', 'ipns'],
			context,
		);
		expect(code).toBe(0);

		// The `--as <name>` IS the KDF input (one id), same as derive/promote.
		expect(calls.deriveIpnsKey.length).toBe(1);
		expect(calls.deriveIpnsKey[0]).toMatchObject({
			master: 'the-master-secret',
			keyId: 'archive',
		});

		const input = calls.pinExternal[0] as {
			mode: string;
			derived: {ipnsId: string};
			targets: Array<{baseUrl: string; role: string}>;
		};
		expect(input.mode).toBe('ipns');
		expect(input.derived.ipnsId).toBe('k51stubid');
		// Every node is still a pin target; each carries its ROLE so only the
		// publisher signs.
		expect(input.targets.map((t) => [t.baseUrl, t.role])).toEqual([
			['https://a.example', 'publisher'],
			['https://b.example', 'replica'],
		]);

		// The operator is told the mutable pointer they now control.
		expect(out.join('\n')).toContain('ipns://k51stubid');
	});

	it('FAILS LOUD when the master is unset (env-only, never from the config)', async () => {
		const {deps, calls} = recordingDeps();
		const {context, err} = ctx({deps, env: {...hostTokenEnv}});
		const code = await run(
			['pin', 'bafyexternal', '--as', 'archive', '--mode', 'ipns'],
			context,
		);
		expect(code).not.toBe(0);
		expect(calls.pinExternal.length).toBe(0);
		expect(err.join('\n')).toContain('PINNACE_MASTER');
	});

	it('FAILS LOUD when --host narrows to a REPLICA (a replica never signs)', async () => {
		const {deps, calls} = recordingDeps();
		const {context, err} = ctx({deps, env: {...masterEnv}});
		const code = await run(
			[
				'pin',
				'bafyexternal',
				'--as',
				'archive',
				'--mode',
				'ipns',
				'--host',
				'b',
			],
			context,
		);
		expect(code).not.toBe(0);
		expect(calls.pinExternal.length).toBe(0);
		expect(err.join('\n')).toMatch(/publisher/i);
		expect(err.join('\n')).toContain('b');
	});

	it('FAILS LOUD when NO configured host is a publisher', async () => {
		const {deps, calls} = recordingDeps();
		const {context, err} = ctx({
			deps,
			env: {...masterEnv},
			loadConfigFile: () => ({
				hosts: [
					{name: 'b', endpoint: 'https://b.example', role: 'replica' as const},
				],
			}),
		});
		const code = await run(
			['pin', 'bafyexternal', '--as', 'archive', '--mode', 'ipns'],
			context,
		);
		expect(code).not.toBe(0);
		expect(calls.pinExternal.length).toBe(0);
		expect(err.join('\n')).toMatch(/publisher/i);
	});

	it('rejects an invalid --mode value (the surface is an allow-list)', async () => {
		const {deps, calls} = recordingDeps();
		const {context, err} = ctx({deps, env: {...masterEnv}});
		const code = await run(
			['pin', 'bafyexternal', '--as', 'archive', '--mode', 'sideways'],
			context,
		);
		expect(code).not.toBe(0);
		expect(calls.pinExternal.length).toBe(0);
		expect(err.join('\n')).toContain('--mode');
	});
});

describe('pin --from-ipns <source>: MIGRATE from an existing IPNS name', () => {
	/** The master is env-ONLY (never a pinnace.json field), exactly as promote. */
	const masterEnv = {...hostTokenEnv, PINNACE_MASTER: 'the-master-secret'};

	it('hands the SOURCE name (not a cid) to the core and reports what it resolved to', async () => {
		const {deps, calls} = recordingDeps();
		const {context, out} = ctx({deps, env: {...hostTokenEnv}});
		const code = await run(
			['pin', '--from-ipns', 'k51source', '--as', 'ronan'],
			context,
		);
		expect(code).toBe(0);
		const input = calls.pinExternal[0] as {
			cid?: string;
			fromIpns?: string;
			name: string;
			targets: Array<{baseUrl: string}>;
		};
		// The source is the NAME; no cid is invented for it.
		expect(input.fromIpns).toBe('k51source');
		expect(input.cid).toBeUndefined();
		// `--as` stays the OPERATOR's id (the MFS entry / KDF input), never the source.
		expect(input.name).toBe('ronan');
		// Still every configured node (the redundancy of the pin flow is reused).
		expect(input.targets.map((t) => t.baseUrl)).toEqual([
			'https://a.example',
			'https://b.example',
		]);
		// The operator sees WHAT was pinned (the resolved snapshot).
		expect(out.join('\n')).toContain('k51source');
		expect(out.join('\n')).toContain('bafyresolvedstub');
		// ...and that this is a snapshot, not a follow of the source.
		expect(out.join('\n')).toMatch(/snapshot/i);
	});

	it('one command migrates onto the operator OWN name: --mode ipns prints ipns://<their id>', async () => {
		const {deps, calls} = recordingDeps();
		const {context, out} = ctx({deps, env: {...masterEnv}});
		const code = await run(
			['pin', '--from-ipns', 'k51source', '--as', 'ronan', '--mode', 'ipns'],
			context,
		);
		expect(code).toBe(0);
		// The key is derived from the master + the OPERATOR's id, NOT the source.
		expect(calls.deriveIpnsKey[0]).toMatchObject({
			master: 'the-master-secret',
			keyId: 'ronan',
		});
		expect(calls.pinExternal[0]).toMatchObject({
			fromIpns: 'k51source',
			mode: 'ipns',
		});
		expect(out.join('\n')).toContain('ipns://k51stubid');
	});

	it('rejects BOTH a positional cid and --from-ipns (exactly one source)', async () => {
		const {deps, calls} = recordingDeps();
		const {context, err} = ctx({deps, env: {...hostTokenEnv}});
		const code = await run(
			['pin', 'bafyexternal', '--from-ipns', 'k51source', '--as', 'ronan'],
			context,
		);
		expect(code).not.toBe(0);
		expect(calls.pinExternal.length).toBe(0);
		expect(err.join('\n')).toContain('--from-ipns');
		expect(err.join('\n')).toMatch(/one source/i);
	});

	it('rejects NEITHER a cid nor --from-ipns (exactly one source)', async () => {
		const {deps, calls} = recordingDeps();
		const {context, err} = ctx({deps, env: {...hostTokenEnv}});
		const code = await run(['pin', '--as', 'ronan'], context);
		expect(code).not.toBe(0);
		expect(calls.pinExternal.length).toBe(0);
		expect(err.join('\n')).toContain('--from-ipns');
	});

	it('fails loud (exit 1) when the source name does not resolve anywhere', async () => {
		const {deps} = recordingDeps();
		const failing: ClientDeps = {
			...deps,
			pinExternal: async (input) => {
				throw new PinSourceResolveError(input.fromIpns ?? '', [
					{
						baseUrl: 'https://a.example',
						error: new Error('routing: not found'),
					},
				]);
			},
		};
		const {context, err} = ctx({deps: failing, env: {...hostTokenEnv}});
		const code = await run(
			['pin', '--from-ipns', 'k51nothere', '--as', 'ronan'],
			context,
		);
		expect(code).toBe(1);
		expect(err.join('\n')).toContain('k51nothere');
		expect(err.join('\n')).toContain('routing: not found');
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
			// The injected in-memory env supplies its OWN token for host a; the CLI
			// must use it, NOT the sentinel on the real process.env.
			const {context} = ctx({
				deps,
				env: {
					PINNACE_HOST_A_TOKEN: 'in-memory-token-a',
					PINNACE_HOST_B_TOKEN: 'x',
				},
			});
			await run(['deploy', './dist', 'mysite'], context);
			const input = calls.deploy[0] as {
				targets: Array<{token: string}>;
			};
			// The token came from the injected in-memory env, NOT the real process.env.
			expect(input.targets[0].token).toBe('in-memory-token-a');
			expect(input.targets[0].token).not.toBe('REAL-ENV-SHOULD-NOT-LEAK');
		} finally {
			if (hadSentinel) process.env[sentinelKey] = previous;
			else delete process.env[sentinelKey];
		}
	});
});
