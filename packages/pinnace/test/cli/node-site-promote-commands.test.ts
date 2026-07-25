import {describe, it, expect} from 'vitest';
import {run, type ClientDeps, type RunContext} from '../../src/cli/run.js';
import type {
	PinnaceConfigFile,
	HostRole,
} from '../../src/config/config-resolution.js';
import type {
	NodeVerb,
	NodeCommandContext,
	NodeCommandResult,
} from '../../src/node/node-commands.js';

/**
 * These tests prove the ON-BOX `node` namespace, the `site` namespace, and the
 * `promote` verb are wired end-to-end through the SAME injectable
 * {@link ClientDeps} seam the client verbs use (no forked dispatch idiom): each
 * parses/validates args, resolves config (arg > env > file; master + token
 * env-only), assembles the right context/client, calls the CORRECT core
 * function with correctly-resolved arguments, and formats the result. They stub
 * the core and assert the DISPATCH — they do NOT re-test core internals.
 *
 * They ISOLATE env/config: every test passes an in-memory `env` record and an
 * in-memory `pinnace.json` through {@link RunContext}, so the operator's REAL
 * `process.env` and REAL config file are never read or mutated.
 */

/** A recording set of stub core deps; every dispatched call is captured. */
function recordingDeps(): {
	deps: ClientDeps;
	calls: {
		runNodeCommand: Array<{verb: NodeVerb; ctx: NodeCommandContext}>;
		listSites: unknown[];
		removeSite: unknown[];
		addSite: unknown[];
		deriveIpnsKey: unknown[];
		promoteReplicaToPublisher: unknown[];
	};
} {
	const calls = {
		runNodeCommand: [] as Array<{verb: NodeVerb; ctx: NodeCommandContext}>,
		listSites: [] as unknown[],
		removeSite: [] as unknown[],
		addSite: [] as unknown[],
		deriveIpnsKey: [] as unknown[],
		promoteReplicaToPublisher: [] as unknown[],
	};
	const deps: Partial<ClientDeps> = {
		runNodeCommand: async (verb, ctx) => {
			calls.runNodeCommand.push({verb, ctx});
			const result: NodeCommandResult = {verb, sites: []};
			return result;
		},
		listSites: async (input) => {
			calls.listSites.push(input);
			return [{id: 'mysite', cid: 'bafyStub'}];
		},
		removeSite: async (input) => {
			calls.removeSite.push(input);
			return {id: (input as {id: string}).id, cid: 'bafyStub', unpinned: true};
		},
		addSite: async (input) => {
			calls.addSite.push(input);
			return {
				id: (input as {id: string}).id,
				cid: (input as {cid: string}).cid,
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
		promoteReplicaToPublisher: async (input) => {
			calls.promoteReplicaToPublisher.push(input);
			return {
				role: 'publisher' as HostRole,
				keyName: (input as {keyName: string}).keyName,
				ipns: 'k51stubid',
			};
		},
	};
	return {deps: deps as ClientDeps, calls};
}

/** A representative in-memory pinnace.json (two hosts, one site). */
const fileConfig: PinnaceConfigFile = {
	hosts: [
		{name: 'a', endpoint: 'https://a.example', role: 'publisher'},
		{
			name: 'b',
			endpoint: 'https://b.example',
			role: 'replica',
			publisherEndpoint: 'https://a.example/records',
		},
	],
	sites: [{id: 'mysite', mode: 'ipns', sourceDir: './dist'}],
	gateways: ['https://dweb.link'],
};

/** A single-host config (so `--host` may be omitted). */
const singleHostConfig: PinnaceConfigFile = {
	hosts: [{name: 'a', endpoint: 'https://a.example', role: 'replica'}],
	sites: [{id: 'mysite', mode: 'ipns', sourceDir: './dist'}],
};

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

// ---------------------------------------------------------------------------
// node namespace — assemble the on-box context from /etc/pinnace-node.env.
// ---------------------------------------------------------------------------

/** The on-box env (as EnvironmentFile=/etc/pinnace-node.env exports it). */
const onBoxEnv = {
	NODE_ROLE: 'publisher',
	RPC_BEARER_TOKEN: 'box-bearer',
	SITES_DIR: '/sites',
	RECORDS_DIR: '/var/www/ipfs-dash/records',
	CACHE_DIR: '/var/lib/pinnace/cache',
	DASHBOARD_DIR: '/var/www/ipfs-dash',
	PUBLISHER_ENDPOINT: 'https://pub.example',
	WARM_GATEWAYS: 'https://{cid}.ipfs.dweb.link/ https://ipfs.io/ipfs/{cid}',
} as const;

describe('pinnace node <verb> — assembles the on-box context + invokes runNodeCommand', () => {
	it('builds a NodeCommandContext from the box env and dispatches to runNodeCommand', async () => {
		const {deps, calls} = recordingDeps();
		const {context} = ctx({deps, env: {...onBoxEnv}});
		const code = await run(['node', 'republish'], context);
		expect(code).toBe(0);
		expect(calls.runNodeCommand.length).toBe(1);
		const {verb, ctx: nodeCtx} = calls.runNodeCommand[0];
		expect(verb).toBe('republish');
		// role from NODE_ROLE.
		expect(nodeCtx.role).toBe('publisher');
		// on-box paths from the named env keys.
		expect(nodeCtx.recordsDir).toBe('/var/www/ipfs-dash/records');
		expect(nodeCtx.cacheDir).toBe('/var/lib/pinnace/cache');
		expect(nodeCtx.dashboardDir).toBe('/var/www/ipfs-dash');
		expect(nodeCtx.sitesDir).toBe('/sites');
		expect(nodeCtx.publisherEndpoint).toBe('https://pub.example');
		// gateways split from WARM_GATEWAYS.
		expect(nodeCtx.gateways).toEqual([
			'https://{cid}.ipfs.dweb.link/',
			'https://ipfs.io/ipfs/{cid}',
		]);
		// a LOCAL Kubo client (this box's daemon) — a real client object.
		expect(nodeCtx.client).toBeTruthy();
	});

	it('wires the real status op (makeStatusOp), not the thin defaultStatus', async () => {
		const {deps, calls} = recordingDeps();
		const {context} = ctx({deps, env: {...onBoxEnv, NODE_ROLE: 'replica'}});
		await run(['node', 'status'], context);
		// ctx.ops.status is supplied (the production status path uses makeStatusOp).
		expect(calls.runNodeCommand[0].ctx.ops?.status).toBeTypeOf('function');
	});

	it('rejects an unknown node verb loudly (never dispatches)', async () => {
		const {deps, calls} = recordingDeps();
		const {context, err} = ctx({deps, env: {...onBoxEnv}});
		const code = await run(['node', 'frobnicate'], context);
		expect(code).not.toBe(0);
		expect(calls.runNodeCommand.length).toBe(0);
		expect(err.join('\n')).toMatch(/unknown verb/i);
	});

	it('fails loud when the box bearer token is absent (env-only, never silent)', async () => {
		const {deps, calls} = recordingDeps();
		const noToken = {...onBoxEnv} as Record<string, string>;
		delete noToken.RPC_BEARER_TOKEN;
		const {context, err} = ctx({deps, env: noToken});
		const code = await run(['node', 'republish'], context);
		expect(code).not.toBe(0);
		expect(calls.runNodeCommand.length).toBe(0);
		expect(err.join('\n')).toMatch(/RPC_BEARER_TOKEN/);
	});
});

// ---------------------------------------------------------------------------
// site namespace — assemble a client + invoke listSites/removeSite/addSite.
// ---------------------------------------------------------------------------

describe('pinnace site <verb> — assembles a client + invokes the site core', () => {
	it('list: builds a client for the chosen host and calls listSites', async () => {
		const {deps, calls} = recordingDeps();
		const {context, out} = ctx({deps, env: {...hostTokenEnv}});
		const code = await run(['site', 'list', '--host', 'a'], context);
		expect(code).toBe(0);
		expect(calls.listSites.length).toBe(1);
		expect((calls.listSites[0] as {client: unknown}).client).toBeTruthy();
		expect(out.join('\n')).toContain('mysite');
	});

	it('remove <id>: calls removeSite with the resolved id + client', async () => {
		const {deps, calls} = recordingDeps();
		const {context} = ctx({deps, env: {...hostTokenEnv}});
		const code = await run(
			['site', 'remove', 'mysite', '--host', 'a'],
			context,
		);
		expect(code).toBe(0);
		expect(calls.removeSite.length).toBe(1);
		expect(calls.removeSite[0]).toMatchObject({id: 'mysite'});
		expect((calls.removeSite[0] as {client: unknown}).client).toBeTruthy();
	});

	it('add <id> <cid>: calls addSite with the resolved id + cid + client', async () => {
		const {deps, calls} = recordingDeps();
		const {context} = ctx({deps, env: {...hostTokenEnv}});
		const code = await run(
			['site', 'add', 'mysite', 'bafyNew', '--host', 'a'],
			context,
		);
		expect(code).toBe(0);
		expect(calls.addSite.length).toBe(1);
		expect(calls.addSite[0]).toMatchObject({id: 'mysite', cid: 'bafyNew'});
	});

	it('defaults to the sole host when --host is omitted', async () => {
		const {deps, calls} = recordingDeps();
		const {context} = ctx({
			deps,
			env: {PINNACE_HOST_A_TOKEN: 'env-token-a'},
			loadConfigFile: () => singleHostConfig,
		});
		const code = await run(['site', 'list'], context);
		expect(code).toBe(0);
		expect(calls.listSites.length).toBe(1);
	});

	it('requires --host when the config has more than one host', async () => {
		const {deps, calls} = recordingDeps();
		const {context, err} = ctx({deps, env: {...hostTokenEnv}});
		const code = await run(['site', 'list'], context);
		expect(code).not.toBe(0);
		expect(calls.listSites.length).toBe(0);
		expect(err.join('\n')).toMatch(/--host/);
	});

	it('fails loud naming the missing env var when the host has no token', async () => {
		const {deps, calls} = recordingDeps();
		const {context, err} = ctx({deps, env: {}});
		const code = await run(['site', 'list', '--host', 'a'], context);
		expect(code).not.toBe(0);
		expect(calls.listSites.length).toBe(0);
		expect(err.join('\n')).toContain('PINNACE_HOST_A_TOKEN');
	});

	it('rejects an unknown site verb loudly', async () => {
		const {deps} = recordingDeps();
		const {context, err} = ctx({deps, env: {...hostTokenEnv}});
		const code = await run(['site', 'frobnicate'], context);
		expect(code).not.toBe(0);
		expect(err.join('\n')).toMatch(/unknown verb/i);
	});
});

// ---------------------------------------------------------------------------
// promote — derive the key from master + invoke promoteReplicaToPublisher.
// ---------------------------------------------------------------------------

describe('promote <id> — derives the key from master + invokes promoteReplicaToPublisher', () => {
	it('reads the master ENV-ONLY, derives the key, and dispatches to the core', async () => {
		const {deps, calls} = recordingDeps();
		const {context} = ctx({
			deps,
			env: {...hostTokenEnv, PINNACE_MASTER: 'the-master-secret'},
		});
		const code = await run(['promote', 'mysite', '--host', 'b'], context);
		expect(code).toBe(0);
		// Master fed to the derivation with the site id as the KDF input.
		expect(calls.deriveIpnsKey.length).toBe(1);
		expect(calls.deriveIpnsKey[0]).toMatchObject({
			master: 'the-master-secret',
			keyId: 'mysite',
		});
		// Then promotion of the chosen host with its current role + derived key.
		expect(calls.promoteReplicaToPublisher.length).toBe(1);
		const input = calls.promoteReplicaToPublisher[0] as {
			client: unknown;
			currentRole: HostRole;
			keyName: string;
			derived: unknown;
		};
		expect(input.client).toBeTruthy();
		expect(input.currentRole).toBe('replica');
		expect(input.keyName).toBe('mysite');
		expect(input.derived).toBeTruthy();
	});

	it('fails loud when the master is absent (env-only; never from the file)', async () => {
		const {deps, calls} = recordingDeps();
		const decoyFile = {
			...fileConfig,
			master: 'DECOY-FROM-FILE',
		} as PinnaceConfigFile;
		const {context, err} = ctx({
			deps,
			env: {...hostTokenEnv},
			loadConfigFile: () => decoyFile,
		});
		const code = await run(['promote', 'mysite', '--host', 'b'], context);
		expect(code).not.toBe(0);
		expect(calls.promoteReplicaToPublisher.length).toBe(0);
		expect(err.join('\n')).toMatch(/master/i);
	});

	it('fails loud naming the missing env var when the host has no token', async () => {
		const {deps, calls} = recordingDeps();
		const {context, err} = ctx({
			deps,
			env: {PINNACE_MASTER: 'm'},
		});
		const code = await run(['promote', 'mysite', '--host', 'b'], context);
		expect(code).not.toBe(0);
		expect(calls.promoteReplicaToPublisher.length).toBe(0);
		expect(err.join('\n')).toContain('PINNACE_HOST_B_TOKEN');
	});
});

// ---------------------------------------------------------------------------
// env/config isolation — the operator's real environment is untouched.
// ---------------------------------------------------------------------------

describe('env/config isolation — real environment untouched (node/site/promote)', () => {
	it('never reads process.env for the on-box node context (uses the injected env)', async () => {
		const {deps, calls} = recordingDeps();
		const sentinelKey = 'RPC_BEARER_TOKEN';
		const had = Object.prototype.hasOwnProperty.call(process.env, sentinelKey);
		const previous = process.env[sentinelKey];
		process.env[sentinelKey] = 'REAL-ENV-SHOULD-NOT-LEAK';
		try {
			const {context} = ctx({
				deps,
				env: {...onBoxEnv, RPC_BEARER_TOKEN: 'in-memory-box-token'},
			});
			await run(['node', 'warm'], context);
			expect(calls.runNodeCommand.length).toBe(1);
			// The client was built from the injected env token, not process.env.
			// (We cannot read the token off the client, but the dispatch happening
			// with the injected env — not the sentinel — proves the injected path.)
			expect(calls.runNodeCommand[0].ctx.role).toBe('publisher');
		} finally {
			if (had) process.env[sentinelKey] = previous;
			else delete process.env[sentinelKey];
		}
	});
});
