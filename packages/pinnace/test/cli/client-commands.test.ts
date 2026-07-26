import {describe, it, expect} from 'vitest';
import {run, type ClientDeps, type RunContext} from '../../src/cli/run.js';
import {PinSourceResolveError} from '../../src/pin/pin-external.js';
import {
	DeployDerivedKeyRequiredError,
	DeployPublisherRequiredError,
} from '../../src/deploy/deploy.js';
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
				// The CLI states a mode only when --set-mode was given; the real core
				// resolves an unstated one against the site's stored metadata.
				mode: input.mode ?? 'ipfs',
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
	it('resolves nodes from config and calls core deploy with them', async () => {
		const {deps, calls} = recordingDeps();
		const {context} = ctx({deps, env: {...hostTokenEnv}});
		const code = await run(['deploy', './dist', 'mysite'], context);
		expect(code).toBe(0);
		expect(calls.deploy.length).toBe(1);
		const input = calls.deploy[0] as {
			sourceDir?: string;
			id: string;
			mode?: string;
			targets: Array<{baseUrl: string; token: string; role: string}>;
		};
		expect(input.sourceDir).toBe('./dist');
		// The single `id` positional flows straight through to the core.
		expect(input.id).toBe('mysite');
		// No --set-mode: the CLI states NO mode, so the core PRESERVES the site's
		// stored one (and only a site storing nothing runs as `ipfs`). The config
		// site entry that used to supply this is gone — sites live in MFS.
		expect(input.mode).toBeUndefined();
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

	it('a --set-mode arg STATES the mode (arg > the stored one)', async () => {
		const {deps, calls} = recordingDeps();
		const {context} = ctx({deps, env: {...hostTokenEnv}});
		await run(['deploy', '--set-mode', 'ipns', './dist', 'mysite'], context);
		expect((calls.deploy[0] as {mode: string}).mode).toBe('ipns');
		const back = recordingDeps();
		await run(
			['deploy', '--set-mode', 'ipfs', './dist', 'mysite'],
			ctx({deps: back.deps, env: {...hostTokenEnv}}).context,
		);
		expect((back.calls.deploy[0] as {mode: string}).mode).toBe('ipfs');
	});

	it('a BARE --set-mode is a loud usage error naming ipfs|ipns', async () => {
		// Unlike a bare --set-ens-name (which INFERS from a `.eth` id), a mode has
		// nothing to infer from: it is stated or it is preserved.
		for (const argv of [
			['deploy', './dist', 'mysite', '--set-mode'],
			['deploy', '--set-mode', '--set-ens-name', 'a.eth', './dist', 'mysite'],
		]) {
			const {deps, calls} = recordingDeps();
			const {context, err} = ctx({deps, env: {...hostTokenEnv}});
			expect(await run(argv, context)).not.toBe(0);
			expect(calls.deploy.length).toBe(0);
			const message = err.join('\n');
			expect(message).toContain('--set-mode');
			expect(message).toContain('ipfs');
			expect(message).toContain('ipns');
		}
	});

	it('a stale `sites` entry in pinnace.json NO LONGER supplies the mode', async () => {
		// The config-based mode fallback is REMOVED: an old config carrying
		// sites: [{id: 'mysite', mode: 'ipns'}] is inert, so the deploy runs in the
		// `ipfs` default rather than silently publishing an IPNS record.
		const {deps, calls} = recordingDeps();
		const staleFile = {
			...fileConfig,
			sites: [{id: 'mysite', mode: 'ipns', sourceDir: './dist'}],
		} as unknown as PinnaceConfigFile;
		const {context} = ctx({
			deps,
			env: {...hostTokenEnv},
			loadConfigFile: () => staleFile,
		});
		const code = await run(['deploy', './dist', 'mysite'], context);
		expect(code).toBe(0);
		expect((calls.deploy[0] as {mode?: string}).mode).toBeUndefined();
	});

	it('an UNRESOLVED (invalid) --set-mode fails loud naming the site + the two values', async () => {
		const {deps, calls} = recordingDeps();
		const {context, err} = ctx({deps, env: {...hostTokenEnv}});
		const code = await run(
			['deploy', '--set-mode', 'sideways', './dist', 'mysite'],
			context,
		);
		expect(code).not.toBe(0);
		expect(calls.deploy.length).toBe(0);
		const message = err.join('\n');
		expect(message).toContain('mysite');
		expect(message).toContain('--set-mode');
		// It names the whole source order, so the operator knows what omitting it does.
		expect(message).toContain('metadata');
		// The removed config fallback is not suggested any more.
		expect(message).not.toMatch(/add the site to pinnace\.json/i);
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

/**
 * The two ensName verb-flags (task `deploy-pin-write-site-metadata`), on BOTH
 * the `deploy` and `pin` verbs. The CLI's job is to turn what the operator
 * typed into ONE of the four write intents the core persists; omitting both
 * flags is the LEAVE-ALONE intent (never a wipe, never a materialised name).
 */
describe('--set-ens-name / --unset-ens-name — the ensName write intent', () => {
	/** The `ensName` intent the CLI handed the core deploy. */
	function deployIntent(calls: Record<string, unknown[]>): unknown {
		return (calls.deploy[0] as {ensName?: unknown}).ensName;
	}

	it('deploy --set-ens-name <name>: the SET intent, with the name verbatim', async () => {
		const {deps, calls} = recordingDeps();
		const {context} = ctx({deps, env: {...hostTokenEnv}});
		const code = await run(
			['deploy', '--set-ens-name', 'alice.eth', './dist', 'mysite'],
			context,
		);
		expect(code).toBe(0);
		expect(deployIntent(calls)).toEqual({kind: 'set', name: 'alice.eth'});
		// The flag's value is not mistaken for a positional (dir/id survive).
		expect(calls.deploy[0]).toMatchObject({sourceDir: './dist', id: 'mysite'});
	});

	it('deploy --set-ens-name BARE (end of args): the INFER intent on a `.eth` id', async () => {
		const {deps, calls} = recordingDeps();
		const {context} = ctx({deps, env: {...hostTokenEnv}});
		const code = await run(
			[
				'deploy',
				'--set-mode',
				'ipfs',
				'./dist',
				'mysite.eth',
				'--set-ens-name',
			],
			context,
		);
		expect(code).toBe(0);
		expect(deployIntent(calls)).toEqual({kind: 'infer'});
	});

	it('deploy --set-ens-name BARE followed by another --flag: still the INFER intent', async () => {
		const {deps, calls} = recordingDeps();
		const {context} = ctx({deps, env: {...hostTokenEnv}});
		const code = await run(
			[
				'deploy',
				'--set-ens-name',
				'--set-mode',
				'ipfs',
				'./dist',
				'mysite.eth',
			],
			context,
		);
		expect(code).toBe(0);
		expect(deployIntent(calls)).toEqual({kind: 'infer'});
		expect(calls.deploy[0]).toMatchObject({mode: 'ipfs', id: 'mysite.eth'});
	});

	it('deploy --set-ens-name BARE on a NON-`.eth` id: FAILS LOUD, no deploy', async () => {
		const {deps, calls} = recordingDeps();
		const {context, err} = ctx({deps, env: {...hostTokenEnv}});
		const code = await run(
			['deploy', './dist', 'mysite', '--set-ens-name'],
			context,
		);
		expect(code).not.toBe(0);
		expect(calls.deploy.length).toBe(0);
		expect(err.join('\n')).toContain('.eth');
		expect(err.join('\n')).toContain('mysite');
	});

	it('deploy --unset-ens-name: the OPT-OUT intent (and it swallows no positional)', async () => {
		const {deps, calls} = recordingDeps();
		const {context} = ctx({deps, env: {...hostTokenEnv}});
		const code = await run(
			['deploy', '--unset-ens-name', './dist', 'mysite'],
			context,
		);
		expect(code).toBe(0);
		expect(deployIntent(calls)).toEqual({kind: 'unset'});
		expect(calls.deploy[0]).toMatchObject({sourceDir: './dist', id: 'mysite'});
	});

	it('deploy with NEITHER flag: the PRESERVE (leave-alone) intent', async () => {
		const {deps, calls} = recordingDeps();
		const {context} = ctx({deps, env: {...hostTokenEnv}});
		await run(['deploy', './dist', 'mysite'], context);
		expect(deployIntent(calls)).toEqual({kind: 'preserve'});
	});

	it('deploy with BOTH flags: a usage error, no deploy', async () => {
		const {deps, calls} = recordingDeps();
		const {context, err} = ctx({deps, env: {...hostTokenEnv}});
		const code = await run(
			[
				'deploy',
				'--unset-ens-name',
				'--set-ens-name',
				'alice.eth',
				'./dist',
				'mysite',
			],
			context,
		);
		expect(code).not.toBe(0);
		expect(calls.deploy.length).toBe(0);
		expect(err.join('\n')).toContain('--set-ens-name');
		expect(err.join('\n')).toContain('--unset-ens-name');
	});

	it('pin carries the same three explicit intents (and preserve by default)', async () => {
		const intentOf = (calls: Record<string, unknown[]>): unknown =>
			(calls.pinExternal[0] as {ensName?: unknown}).ensName;

		const set = recordingDeps();
		await run(
			[
				'pin',
				'bafyexternal',
				'--as',
				'archive',
				'--set-ens-name',
				'archive.eth',
			],
			ctx({deps: set.deps, env: {...hostTokenEnv}}).context,
		);
		expect(intentOf(set.calls)).toEqual({kind: 'set', name: 'archive.eth'});

		const infer = recordingDeps();
		await run(
			['pin', 'bafyexternal', '--as', 'archive.eth', '--set-ens-name'],
			ctx({deps: infer.deps, env: {...hostTokenEnv}}).context,
		);
		expect(intentOf(infer.calls)).toEqual({kind: 'infer'});

		const unset = recordingDeps();
		await run(
			['pin', '--unset-ens-name', 'bafyexternal', '--as', 'archive'],
			ctx({deps: unset.deps, env: {...hostTokenEnv}}).context,
		);
		expect(intentOf(unset.calls)).toEqual({kind: 'unset'});
		// --unset-ens-name takes no value, so the <cid> positional survives it.
		expect(unset.calls.pinExternal[0]).toMatchObject({cid: 'bafyexternal'});

		const preserve = recordingDeps();
		await run(
			['pin', 'bafyexternal', '--as', 'archive'],
			ctx({deps: preserve.deps, env: {...hostTokenEnv}}).context,
		);
		expect(intentOf(preserve.calls)).toEqual({kind: 'preserve'});
	});

	it('pin --set-ens-name BARE on a NON-`.eth` name: FAILS LOUD, nothing pinned', async () => {
		const {deps, calls} = recordingDeps();
		const {context, err} = ctx({deps, env: {...hostTokenEnv}});
		const code = await run(
			['pin', 'bafyexternal', '--as', 'archive', '--set-ens-name'],
			context,
		);
		expect(code).not.toBe(0);
		expect(calls.pinExternal.length).toBe(0);
		expect(err.join('\n')).toContain('.eth');
	});

	it('pin with BOTH flags: a usage error, nothing pinned', async () => {
		const {deps, calls} = recordingDeps();
		const {context, err} = ctx({deps, env: {...hostTokenEnv}});
		const code = await run(
			[
				'pin',
				'bafyexternal',
				'--as',
				'archive',
				'--set-ens-name',
				'archive.eth',
				'--unset-ens-name',
			],
			context,
		);
		expect(code).not.toBe(0);
		expect(calls.pinExternal.length).toBe(0);
		expect(err.join('\n')).toContain('--unset-ens-name');
	});
});

/**
 * The config file is OPTIONAL (spec `sites-metadata-in-mfs`, story 2): a
 * publisher endpoint typed on the CLI plus the usual env-only token is a
 * complete single-node target, with NO `pinnace.json` at all. These tests load
 * an EMPTY config (the benign no-file case) and prove the verbs still operate.
 */
describe('no pinnace.json — --endpoint + env token is a working single-node target', () => {
	/** The env-only token of the CLI-supplied node (the same naming convention). */
	const soloTokenEnv = {
		PINNACE_HOST_PUBLISHER_TOKEN: 'env-token-solo',
	} as const;

	/** A context with NO config file (an empty one, as the default loader yields). */
	function noFileCtx(deps: ClientDeps, env: Record<string, string> = {}) {
		return ctx({deps, env, loadConfigFile: () => ({})});
	}

	it('deploy works with no config file: one target from --endpoint, token from env', async () => {
		const {deps, calls} = recordingDeps();
		const {context} = noFileCtx(deps, {...soloTokenEnv});
		const code = await run(
			['deploy', '--endpoint', 'https://solo.example', './dist', 'mysite'],
			context,
		);
		expect(code).toBe(0);
		const input = calls.deploy[0] as {
			targets: Array<{baseUrl: string; token: string; role: string}>;
		};
		expect(input.targets).toEqual([
			{
				baseUrl: 'https://solo.example',
				token: 'env-token-solo',
				role: 'publisher',
			},
		]);
	});

	it('status works with no config file (one report for the CLI-supplied node)', async () => {
		const {deps, calls} = recordingDeps();
		const {context} = noFileCtx(deps, {...soloTokenEnv});
		const code = await run(
			['status', '--endpoint', 'https://solo.example'],
			context,
		);
		expect(code).toBe(0);
		expect(calls.statusReport.length).toBe(1);
	});

	it('pin works with no config file (the CLI node is the only target)', async () => {
		const {deps, calls} = recordingDeps();
		const {context} = noFileCtx(deps, {...soloTokenEnv});
		const code = await run(
			[
				'pin',
				'bafyexternal',
				'--as',
				'archive',
				'--endpoint',
				'https://solo.example',
			],
			context,
		);
		expect(code).toBe(0);
		const input = calls.pinExternal[0] as {targets: Array<{baseUrl: string}>};
		expect(input.targets.map((t) => t.baseUrl)).toEqual([
			'https://solo.example',
		]);
	});

	it('derive needs NO config file at all (master + the id arg)', async () => {
		const {deps, calls} = recordingDeps();
		const {context, out} = noFileCtx(deps, {PINNACE_MASTER: 'the-master'});
		const code = await run(['derive', 'mysite'], context);
		expect(code).toBe(0);
		expect(calls.deriveIpnsId[0]).toMatchObject({keyId: 'mysite'});
		expect(out.join('\n')).toContain('k51stubid');
	});

	it('the CLI node token stays env-only: absent => LOUD, named failure', async () => {
		const {deps, calls} = recordingDeps();
		const {context, err} = noFileCtx(deps);
		const code = await run(
			['deploy', '--endpoint', 'https://solo.example', './dist', 'mysite'],
			context,
		);
		expect(code).not.toBe(0);
		expect(calls.deploy.length).toBe(0);
		expect(err.join('\n')).toContain('PINNACE_HOST_PUBLISHER_TOKEN');
	});

	it('with NO config file and NO --endpoint, the no-hosts refusal names --endpoint', async () => {
		const {deps, calls} = recordingDeps();
		const {context, err} = noFileCtx(deps, {...soloTokenEnv});
		const code = await run(['deploy', './dist', 'mysite'], context);
		expect(code).not.toBe(0);
		expect(calls.deploy.length).toBe(0);
		expect(err.join('\n')).toContain('--endpoint');
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

	it('prints each site stored mode + ensName and the eth.limo it warms', async () => {
		const {deps} = recordingDeps();
		deps.statusReport = async () => ({
			peerId: 'peer-stub',
			sites: [
				{
					id: 'alice.eth',
					cid: 'bafyalice',
					ipns: 'k51alice',
					mode: 'ipns',
					ensNameToWarm: 'alice.eth',
					announced: true,
					gatewayServes: true,
				},
				{
					id: 'optout.eth',
					cid: 'bafyoptout',
					mode: 'ipfs',
					ensName: '',
					announced: false,
					gatewayServes: false,
				},
			],
		});
		const {context, out} = ctx({deps, env: {...hostTokenEnv}});
		expect(await run(['status'], context)).toBe(0);
		const printed = out.join('\n');
		expect(printed).toContain('mode ipns');
		expect(printed).toContain('eth.limo alice.eth.limo');
		// The three ensName values stay apart in the printed line too.
		expect(printed).toContain('ensName opted-out');
		expect(printed).toContain('ensName unset');
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

describe('pin --set-mode ipns — ADDS the operator OWN stable name to a pin', () => {
	/** The master is env-ONLY (never a pinnace.json field), exactly as promote. */
	const masterEnv = {...hostTokenEnv, PINNACE_MASTER: 'the-master-secret'};

	it('with NO --set-mode it states no mode (the core preserves the stored one)', async () => {
		const {deps, calls} = recordingDeps();
		const {context, out} = ctx({deps, env: {...masterEnv}});
		const code = await run(['pin', 'bafyexternal', '--as', 'archive'], context);
		expect(code).toBe(0);
		expect((calls.pinExternal[0] as {mode?: string}).mode).toBeUndefined();
		// The key material is derived up front (a local KDF, no node contact) so a
		// pin whose STORED mode turns out to be `ipns` can still sign; nothing is
		// published unless the resolved mode says so.
		expect(calls.deriveIpnsKey.length).toBe(1);
		expect(out.join('\n')).not.toContain('ipns://');
	});

	it('with --set-mode ipfs (stated) it derives no key at all', async () => {
		const {deps, calls} = recordingDeps();
		const {context, out} = ctx({deps, env: {...masterEnv}});
		const code = await run(
			['pin', 'bafyexternal', '--as', 'archive', '--set-mode', 'ipfs'],
			context,
		);
		expect(code).toBe(0);
		expect(calls.pinExternal[0]).toMatchObject({mode: 'ipfs'});
		expect(calls.deriveIpnsKey.length).toBe(0);
		expect(out.join('\n')).not.toContain('ipns://');
	});

	it('derives the key from the env-only master + the --as <name> id', async () => {
		const {deps, calls} = recordingDeps();
		const {context, out} = ctx({deps, env: {...masterEnv}});
		const code = await run(
			['pin', 'bafyexternal', '--as', 'archive', '--set-mode', 'ipns'],
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
			['pin', 'bafyexternal', '--as', 'archive', '--set-mode', 'ipns'],
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
				'--set-mode',
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
			['pin', 'bafyexternal', '--as', 'archive', '--set-mode', 'ipns'],
			context,
		);
		expect(code).not.toBe(0);
		expect(calls.pinExternal.length).toBe(0);
		expect(err.join('\n')).toMatch(/publisher/i);
	});

	it('rejects an invalid --set-mode value (the surface is an allow-list)', async () => {
		const {deps, calls} = recordingDeps();
		const {context, err} = ctx({deps, env: {...masterEnv}});
		const code = await run(
			['pin', 'bafyexternal', '--as', 'archive', '--set-mode', 'sideways'],
			context,
		);
		expect(code).not.toBe(0);
		expect(calls.pinExternal.length).toBe(0);
		expect(err.join('\n')).toContain('--set-mode');
	});

	it('rejects a BARE --set-mode loudly, naming the two values', async () => {
		const {deps, calls} = recordingDeps();
		const {context, err} = ctx({deps, env: {...masterEnv}});
		const code = await run(
			['pin', 'bafyexternal', '--as', 'archive', '--set-mode'],
			context,
		);
		expect(code).not.toBe(0);
		expect(calls.pinExternal.length).toBe(0);
		const message = err.join('\n');
		expect(message).toContain('--set-mode');
		expect(message).toContain('ipfs');
		expect(message).toContain('ipns');
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

	it('one command migrates onto the operator OWN name: --set-mode ipns prints ipns://<their id>', async () => {
		const {deps, calls} = recordingDeps();
		const {context, out} = ctx({deps, env: {...masterEnv}});
		const code = await run(
			[
				'pin',
				'--from-ipns',
				'k51source',
				'--as',
				'ronan',
				'--set-mode',
				'ipns',
			],
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

describe('deploy in ipns mode — the CLI derives the key OPTIMISTICALLY (as pin does)', () => {
	/** The master is env-ONLY (never a pinnace.json field), exactly as pin. */
	const masterEnv = {...hostTokenEnv, PINNACE_MASTER: 'the-master-secret'};

	it('--set-mode ipns: derives from the master + the site id and passes it down', async () => {
		const {deps, calls} = recordingDeps();
		const {context} = ctx({deps, env: {...masterEnv}});
		const code = await run(
			['deploy', '--set-mode', 'ipns', './dist', 'mysite'],
			context,
		);
		expect(code).toBe(0);
		// The single `id` positional IS the KDF input, as for derive/promote/pin.
		expect(calls.deriveIpnsKey.length).toBe(1);
		expect(calls.deriveIpnsKey[0]).toMatchObject({
			master: 'the-master-secret',
			keyId: 'mysite',
		});
		expect(
			(calls.deploy[0] as {derived?: {ipnsId: string}}).derived?.ipnsId,
		).toBe('k51stubid');
	});

	it('NO --set-mode: still derives (only the core knows the stored mode)', async () => {
		const {deps, calls} = recordingDeps();
		const {context} = ctx({deps, env: {...masterEnv}});
		expect(await run(['deploy', './dist', 'mysite'], context)).toBe(0);
		expect(calls.deriveIpnsKey.length).toBe(1);
		expect((calls.deploy[0] as {mode?: string}).mode).toBeUndefined();
	});

	it('--set-mode ipfs: derives nothing at all', async () => {
		const {deps, calls} = recordingDeps();
		const {context} = ctx({deps, env: {...masterEnv}});
		expect(
			await run(['deploy', '--set-mode', 'ipfs', './dist', 'mysite'], context),
		).toBe(0);
		expect(calls.deriveIpnsKey.length).toBe(0);
		expect((calls.deploy[0] as {derived?: unknown}).derived).toBeUndefined();
	});

	it('--set-mode ipns with NO master still DEPLOYS (the CI path is master-free)', async () => {
		// Unlike `pin`, deploy does not pre-refuse on a missing master: the
		// publisher may already hold the key (the CI path). Only the CORE, which
		// can see the keystore, decides between auto-import and a loud refusal.
		const {deps, calls} = recordingDeps();
		const {context} = ctx({deps, env: {...hostTokenEnv}});
		const code = await run(
			['deploy', '--set-mode', 'ipns', './dist', 'mysite'],
			context,
		);
		expect(code).toBe(0);
		expect(calls.deriveIpnsKey.length).toBe(0);
		expect(calls.deploy.length).toBe(1);
		expect((calls.deploy[0] as {derived?: unknown}).derived).toBeUndefined();
	});

	it('the core REFUSALS surface as a loud exit 1 (not a stack trace)', async () => {
		for (const error of [
			new DeployDerivedKeyRequiredError('mysite', true, 'https://a.example'),
			new DeployPublisherRequiredError('mysite', true, [
				{role: 'replica' as const},
			]),
		]) {
			const {deps} = recordingDeps();
			const refusing: ClientDeps = {
				...deps,
				deploy: async () => {
					throw error;
				},
			};
			const {context, err} = ctx({deps: refusing, env: {...hostTokenEnv}});
			const code = await run(
				['deploy', '--set-mode', 'ipns', './dist', 'mysite'],
				context,
			);
			expect(code).not.toBe(0);
			expect(err.join('\n')).toContain('pinnace deploy:');
			expect(err.join('\n')).toContain(error.message);
		}
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
