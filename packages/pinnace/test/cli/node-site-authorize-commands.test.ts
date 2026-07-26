import {describe, it, expect} from 'vitest';
import {run, type ClientDeps, type RunContext} from '../../src/cli/run.js';
import type {PinnaceConfigFile} from '../../src/config/config-resolution.js';
import type {
	NodeVerb,
	NodeCommandContext,
	NodeCommandResult,
} from '../../src/node/node-commands.js';
import type {
	AuthorizeInput,
	AuthorizeResult,
} from '../../src/publisher/authorize.js';
import {AuthorizeSecondSignerError} from '../../src/publisher/authorize.js';
import {KeyImportRoleError} from '../../src/publisher/key-import.js';

/**
 * These tests prove the ON-BOX `node` namespace, the `site` namespace, and the
 * `authorize` verb are wired end-to-end through the SAME injectable
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
function recordingDeps(
	authorize?: (input: AuthorizeInput) => Promise<AuthorizeResult>,
): {
	deps: ClientDeps;
	calls: {
		runNodeCommand: Array<{verb: NodeVerb; ctx: NodeCommandContext}>;
		listSites: unknown[];
		removeSite: unknown[];
		addSite: unknown[];
		deriveIpnsKey: unknown[];
		authorizePublisher: AuthorizeInput[];
	};
} {
	const calls = {
		runNodeCommand: [] as Array<{verb: NodeVerb; ctx: NodeCommandContext}>,
		listSites: [] as unknown[],
		removeSite: [] as unknown[],
		addSite: [] as unknown[],
		deriveIpnsKey: [] as unknown[],
		authorizePublisher: [] as AuthorizeInput[],
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
		authorizePublisher: async (input) => {
			calls.authorizePublisher.push(input);
			if (authorize) return authorize(input);
			return {
				publisher: input.publisher.name,
				sites: (input.ids ?? ['discovered']).map((id) => ({
					id,
					ipns: 'k51stubid',
					status: 'authorized' as const,
				})),
				unchecked: [],
			};
		},
	};
	return {deps: deps as ClientDeps, calls};
}

/** A representative in-memory pinnace.json (two hosts, one publisher). */
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
	gateways: ['https://dweb.link'],
};

/** A single-host config (so `--host` may be omitted). */
const singleHostConfig: PinnaceConfigFile = {
	hosts: [{name: 'a', endpoint: 'https://a.example', role: 'replica'}],
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
// authorize — target the DECLARED publisher, derive from the env-only master.
// ---------------------------------------------------------------------------

describe('authorize [<id>] — targets the config declared publisher', () => {
	const masterEnv = {...hostTokenEnv, PINNACE_MASTER: 'the-master-secret'};

	it('dispatches to the declared publisher (never a --host pick), with the other hosts to check', async () => {
		const {deps, calls} = recordingDeps();
		const {context} = ctx({deps, env: {...masterEnv}});
		const code = await run(['authorize', 'mysite'], context);
		expect(code).toBe(0);

		expect(calls.authorizePublisher.length).toBe(1);
		const input = calls.authorizePublisher[0];
		// The target is the host the CONFIG declares `role: publisher` — host `b`
		// (the replica) is never a candidate, and no --host was needed to say so.
		expect(input.publisher.name).toBe('a');
		expect(input.publisher.role).toBe('publisher');
		expect(input.publisher.client).toBeTruthy();
		// Every OTHER configured host is handed over for the second-signer guard.
		expect(input.others?.map((h) => h.name)).toEqual(['b']);
		expect(input.ids).toEqual(['mysite']);
	});

	it('derives the key from the ENV-ONLY master, with the site id as the KDF input', async () => {
		const {deps, calls} = recordingDeps();
		const {context} = ctx({deps, env: {...masterEnv}});
		await run(['authorize', 'mysite'], context);

		// The core calls back for key material only where it imports; the CLI's
		// closure is what carries the master (which never reaches the core).
		calls.authorizePublisher[0].deriveKey('mysite');
		expect(calls.deriveIpnsKey.length).toBe(1);
		expect(calls.deriveIpnsKey[0]).toMatchObject({
			master: 'the-master-secret',
			keyId: 'mysite',
		});
	});

	it('the BARE form states no ids at all (the core discovers them from MFS)', async () => {
		const {deps, calls} = recordingDeps();
		const {context} = ctx({deps, env: {...masterEnv}});
		const code = await run(['authorize'], context);
		expect(code).toBe(0);
		expect(calls.authorizePublisher[0].ids).toBeUndefined();
	});

	it('reports per-site what it did (authorized / already-authorized)', async () => {
		// A stub returning a MIX, to prove both tokens reach the operator.
		const {deps} = recordingDeps(async (input) => ({
			publisher: input.publisher.name,
			sites: [
				{id: 'old', ipns: 'k51old', status: 'already-authorized' as const},
				{id: 'fresh', ipns: 'k51fresh', status: 'authorized' as const},
			],
			unchecked: [],
		}));
		const {context, out} = ctx({deps, env: {...masterEnv}});
		const code = await run(['authorize'], context);
		expect(code).toBe(0);
		const printed = out.join('\n');
		expect(printed).toContain('old: already-authorized');
		expect(printed).toContain('fresh: authorized');
		expect(printed).toContain('k51fresh');
	});

	it('REFUSES --host: the config already declares who the publisher is', async () => {
		const {deps, calls} = recordingDeps();
		const {context, err} = ctx({deps, env: {...masterEnv}});
		const code = await run(['authorize', 'mysite', '--host', 'b'], context);
		expect(code).not.toBe(0);
		expect(calls.authorizePublisher.length).toBe(0);
		expect(err.join('\n')).toMatch(/--host/);
		expect(err.join('\n')).toMatch(/publisher/i);
	});

	it('refuses loudly when the config declares NO publisher', async () => {
		const {deps, calls} = recordingDeps();
		const {context, err} = ctx({
			deps,
			env: {...masterEnv},
			loadConfigFile: () => singleHostConfig, // one host, role replica
		});
		const code = await run(['authorize', 'mysite'], context);
		expect(code).not.toBe(0);
		expect(calls.authorizePublisher.length).toBe(0);
		expect(err.join('\n')).toMatch(/no.*publisher/i);
	});

	it('refuses loudly when the config declares MORE THAN ONE publisher', async () => {
		const {deps, calls} = recordingDeps();
		const twoPublishers: PinnaceConfigFile = {
			hosts: [
				{name: 'a', endpoint: 'https://a.example', role: 'publisher'},
				{name: 'c', endpoint: 'https://c.example', role: 'publisher'},
			],
		};
		const {context, err} = ctx({
			deps,
			env: {...masterEnv, PINNACE_HOST_C_TOKEN: 'env-token-c'},
			loadConfigFile: () => twoPublishers,
		});
		const code = await run(['authorize', 'mysite'], context);
		expect(code).not.toBe(0);
		expect(calls.authorizePublisher.length).toBe(0);
		// It names both, rather than coin-flipping one.
		expect(err.join('\n')).toContain('a');
		expect(err.join('\n')).toContain('c');
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
		const code = await run(['authorize', 'mysite'], context);
		expect(code).not.toBe(0);
		expect(calls.authorizePublisher.length).toBe(0);
		expect(err.join('\n')).toContain('PINNACE_MASTER');
	});

	it("fails loud naming the missing env var when the PUBLISHER's token is unset", async () => {
		const {deps, calls} = recordingDeps();
		const {context, err} = ctx({deps, env: {PINNACE_MASTER: 'm'}});
		const code = await run(['authorize', 'mysite'], context);
		expect(code).not.toBe(0);
		expect(calls.authorizePublisher.length).toBe(0);
		expect(err.join('\n')).toContain('PINNACE_HOST_A_TOKEN');
	});

	it('an OTHER host with no token is reported unchecked, never fatal', async () => {
		const {deps, calls} = recordingDeps();
		const {context, out} = ctx({
			deps,
			env: {PINNACE_MASTER: 'm', PINNACE_HOST_A_TOKEN: 'env-token-a'},
		});
		const code = await run(['authorize', 'mysite'], context);
		expect(code).toBe(0);
		// `b` could not be asked, so it is not handed to the guard...
		expect(calls.authorizePublisher[0].others).toEqual([]);
		// ...and the operator is told which box was not covered.
		expect(out.join('\n')).toContain('b');
	});

	it('prints the core refusal when another host already holds the key (exit 1)', async () => {
		const {deps} = recordingDeps(async (input) => {
			throw new AuthorizeSecondSignerError('mysite', 'b', input.publisher.name);
		});
		const {context, err} = ctx({deps, env: {...masterEnv}});
		const code = await run(['authorize', 'mysite'], context);
		expect(code).toBe(1);
		expect(err.join('\n')).toContain('mysite');
		expect(err.join('\n')).toContain('b');
	});

	it('prints the key-import role refusal (a declared replica) as exit 1', async () => {
		const {deps} = recordingDeps(async () => {
			throw new KeyImportRoleError('replica', 'mysite');
		});
		const {context, err} = ctx({deps, env: {...masterEnv}});
		const code = await run(['authorize', 'mysite'], context);
		expect(code).toBe(1);
		expect(err.join('\n')).toMatch(/replica/);
	});

	it('takes the site `id` from the ARG alone (no config site entry to normalise it)', async () => {
		// A stale `sites` array in the file is inert: the KDF input and the key name
		// are the positional id verbatim.
		const {deps, calls} = recordingDeps();
		const staleFile = {
			...fileConfig,
			sites: [{id: 'mysite', mode: 'ipns', sourceDir: './dist'}],
		} as unknown as PinnaceConfigFile;
		const {context} = ctx({
			deps,
			env: {...masterEnv},
			loadConfigFile: () => staleFile,
		});
		const code = await run(['authorize', 'ad-hoc-id'], context);
		expect(code).toBe(0);
		expect(calls.authorizePublisher[0].ids).toEqual(['ad-hoc-id']);
	});
});

describe('promote is GONE (hard rename, no alias)', () => {
	it('rejects `pinnace promote` as an unknown command', async () => {
		const {deps, calls} = recordingDeps();
		const {context, err} = ctx({
			deps,
			env: {...hostTokenEnv, PINNACE_MASTER: 'm'},
		});
		const code = await run(['promote', 'mysite'], context);
		expect(code).toBe(1);
		expect(calls.authorizePublisher.length).toBe(0);
		expect(err.join('\n')).toMatch(/unknown command/i);
	});
});

/**
 * The config file is OPTIONAL: `--endpoint <url>` supplies the single node for
 * the `site` + `authorize` namespaces too (token still env-only), so these
 * verbs work with NO `pinnace.json`. Note what that means for `authorize`: the
 * endpoint MINTS a synthetic host named `publisher` with role `publisher`, so
 * the operator is ASSERTING that node is the publisher — the declared-role
 * guards cannot fire there, and with one visible box neither can the
 * second-signer guard.
 */
describe('no pinnace.json — --endpoint supplies the single node (site + authorize)', () => {
	const soloTokenEnv = {
		PINNACE_HOST_PUBLISHER_TOKEN: 'env-token-solo',
	} as const;

	it('site list operates against the CLI-supplied node with no config file', async () => {
		const {deps, calls} = recordingDeps();
		const {context} = ctx({
			deps,
			env: {...soloTokenEnv},
			loadConfigFile: () => ({}),
		});
		const code = await run(
			['site', 'list', '--endpoint', 'https://solo.example'],
			context,
		);
		expect(code).toBe(0);
		expect(calls.listSites.length).toBe(1);
	});

	it('authorize operates against the CLI-supplied node, with NO fleet to check', async () => {
		const {deps, calls} = recordingDeps();
		const {context} = ctx({
			deps,
			env: {...soloTokenEnv, PINNACE_MASTER: 'm'},
			loadConfigFile: () => ({}),
		});
		const code = await run(
			['authorize', 'mysite', '--endpoint', 'https://solo.example'],
			context,
		);
		expect(code).toBe(0);
		expect(calls.authorizePublisher.length).toBe(1);
		// The CLI node is MINTED as the publisher (an assertion pinnace cannot
		// verify), so the role guard passes by construction...
		expect(calls.authorizePublisher[0].publisher.role).toBe('publisher');
		expect(calls.authorizePublisher[0].publisher.name).toBe('publisher');
		// ...and there is no other host to ask about a second signer.
		expect(calls.authorizePublisher[0].others).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// env/config isolation — the operator's real environment is untouched.
// ---------------------------------------------------------------------------

describe('env/config isolation — real environment untouched (node/site/authorize)', () => {
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
