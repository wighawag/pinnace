import {describe, it, expect} from 'vitest';
import {run, type ClientDeps, type RunContext} from '../../src/cli/run.js';
import type {PinnaceConfigFile} from '../../src/config/config-resolution.js';
import type {
	NodeVerb,
	NodeCommandContext,
	NodeCommandResult,
} from '../../src/node/node-commands.js';

/**
 * These tests close the last hole in the CLI's standing rule — A FLAG YOU TYPE
 * MUST NEVER MEAN NOTHING — by extending it from a flag's VALUE (the bare-flag
 * refusal) to its NAME: every verb declares the flags it accepts, and anything
 * else is a LOUD refusal naming it, before the verb does anything.
 *
 * The regression that motivated it, on a real box, right after the `--mode` ->
 * `--set-mode` rename: `pinnace pin --from-ipns <src> --as ronan.eth --mode
 * ipns` PARSED, nobody read `--mode`, the site was pinned as `ipfs`, no IPNS
 * record was published, and the stored metadata would then have made the on-box
 * `republish` skip the name until it lapsed. Only a missing `ipns://` line gave
 * it away; a CI or cron run would have failed silently.
 *
 * The two halves tested here are equally load-bearing: an unknown flag refuses
 * (per verb), AND every currently-valid flag on every verb still parses and
 * dispatches — wrongly refusing a valid command would be worse than the bug
 * being fixed. Env/config are in-memory throughout ({@link RunContext}), so the
 * operator's real `process.env` / `pinnace.json` are never read, and the core is
 * stubbed so nothing touches a daemon.
 */

/** A recording set of stub core deps, covering every verb's dispatch. */
function recordingDeps(): {deps: ClientDeps; calls: Record<string, unknown[]>} {
	const calls: Record<string, unknown[]> = {
		provision: [],
		deploy: [],
		emitCi: [],
		statusReport: [],
		deriveIpnsId: [],
		pinExternal: [],
		runNodeCommand: [],
		listSites: [],
		removeSite: [],
		addSite: [],
		deriveIpnsKey: [],
		authorizePublisher: [],
	};
	const deps: ClientDeps = {
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
			const cid = input.cid ?? 'bafyresolvedstub';
			return {
				cid,
				...(input.fromIpns ? {fromIpns: input.fromIpns} : {}),
				name: input.name,
				recursive: input.recursive ?? true,
				mode: input.mode ?? 'ipfs',
				ok: input.targets.map((t) => ({
					baseUrl: t.baseUrl,
					cid,
					name: input.name,
					recursive: input.recursive ?? true,
					published: false,
				})),
				failed: [],
				success: true,
			};
		},
		runNodeCommand: async (verb: NodeVerb, nodeCtx: NodeCommandContext) => {
			calls.runNodeCommand.push({verb, ctx: nodeCtx});
			const result: NodeCommandResult = {verb, sites: []};
			return result;
		},
		listSites: async (input) => {
			calls.listSites.push(input);
			return [{id: 'mysite', cid: 'bafyStub'}];
		},
		removeSite: async (input) => {
			calls.removeSite.push(input);
			return {id: input.id, cid: 'bafyStub', unpinned: true};
		},
		addSite: async (input) => {
			calls.addSite.push(input);
			return {id: input.id, cid: input.cid};
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
			return {
				publisher: input.publisher.name,
				sites: (input.ids ?? []).map((id) => ({
					id,
					ipns: 'k51stubid',
					status: 'authorized' as const,
				})),
				unchecked: [],
			};
		},
	};
	return {deps, calls};
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

/**
 * Tokens are env-only; every host used below resolves one — including the
 * synthetic `publisher` host that `--endpoint` mints.
 */
const env = {
	PINNACE_HOST_A_TOKEN: 'env-token-a',
	PINNACE_HOST_B_TOKEN: 'env-token-b',
	PINNACE_HOST_PUBLISHER_TOKEN: 'env-token-solo',
	PINNACE_MASTER: 'the-master',
} as const;

/** The on-box env (as `EnvironmentFile=/etc/pinnace-node.env` exports it). */
const onBoxEnv = {
	NODE_ROLE: 'publisher',
	RPC_BEARER_TOKEN: 'box-bearer',
	SITES_DIR: '/sites',
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
		env,
		loadConfigFile: () => fileConfig,
		out: (line) => out.push(line),
		err: (line) => err.push(line),
		...overrides,
	};
	return {context, out, err};
}

/**
 * One case per verb: a VALID full command line (using every flag that verb
 * really accepts) and the core call it must dispatch, plus the same line with
 * one unknown flag appended.
 */
interface VerbCase {
	/** The verb, as it is named in the refusal message. */
	verb: string;
	/** A full, valid invocation of that verb. */
	valid: string[];
	/** The `ClientDeps` key the valid line must reach. */
	dispatch: string;
	/** An extra RunContext (the on-box env for `node`). */
	overrides?: Partial<RunContext>;
	/** A flag NAME that verb does not accept (with a value, so it parses). */
	unknown?: string[];
	/** A flag the verb DOES accept, to prove the refusal names the real set. */
	accepts?: string;
}

const verbCases: VerbCase[] = [
	{
		verb: 'pinnace provision',
		valid: [
			'provision',
			'--host',
			'hetzner',
			'--api-domain',
			'api.example',
			'--acme-email',
			'a@example',
			'--bearer-token',
			'tok',
			'--role',
			'publisher',
			'--dashboard-domain',
			'dash.example',
			'--publisher-endpoint',
			'https://pub.example/records',
			'--kubo-version',
			'0.38.1',
			'--pinnace-version',
			'0.8.1',
			'--node-major',
			'22',
		],
		dispatch: 'provision',
		accepts: '--acme-email',
	},
	{
		verb: 'pinnace deploy',
		valid: [
			'deploy',
			'--set-mode',
			'ipfs',
			'--set-ens-name',
			'mysite.eth',
			'--gateways',
			'https://g.example/ipfs/{cid}',
			'--host-endpoint.a',
			'https://a2.example',
			'--host-token.a',
			'tok-a',
			'./dist',
			'mysite',
		],
		dispatch: 'deploy',
		accepts: '--set-mode',
	},
	{
		verb: 'pinnace pin',
		valid: [
			'pin',
			'bafyexternal',
			'--as',
			'archive',
			'--set-mode',
			'ipfs',
			'--host',
			'a',
			'--no-recursive',
			'--set-ens-name',
			'archive.eth',
			'--gateways',
			'https://g.example/ipfs/{cid}',
			'--host-endpoint.a',
			'https://a2.example',
			'--host-token.a',
			'tok-a',
		],
		dispatch: 'pinExternal',
		accepts: '--from-ipns',
	},
	{
		verb: 'pinnace status',
		valid: [
			'status',
			'--gateways',
			'https://g.example/ipfs/{cid}',
			'--host-endpoint.a',
			'https://a2.example',
			'--host-token.a',
			'tok-a',
		],
		dispatch: 'statusReport',
		accepts: '--host-endpoint.<name>',
	},
	{
		verb: 'pinnace derive',
		valid: ['derive', 'mysite'],
		dispatch: 'deriveIpnsId',
	},
	{
		verb: 'pinnace install-ci',
		valid: [
			'install-ci',
			'--system',
			'github',
			'--site',
			'mysite.eth',
			'--output-dir',
			'dist',
			'--emit',
			'workflow',
			'--set-mode',
			'ipfs',
			'--build-command',
			'npm run build',
			'--package-manager',
			'pnpm',
			'--branch',
			'main',
			'--node-version',
			'22',
			'--action-ref',
			'main',
		],
		dispatch: 'emitCi',
		accepts: '--build-command',
	},
	{
		verb: 'pinnace site',
		valid: [
			'site',
			'list',
			'--host',
			'a',
			'--gateways',
			'https://g.example/ipfs/{cid}',
			'--host-endpoint.a',
			'https://a2.example',
			'--host-token.a',
			'tok-a',
		],
		dispatch: 'listSites',
		accepts: '--host',
	},
	{
		verb: 'pinnace authorize',
		valid: [
			'authorize',
			'mysite',
			'--gateways',
			'https://g.example/ipfs/{cid}',
			'--host-endpoint.a',
			'https://a2.example',
			'--host-token.a',
			'tok-a',
		],
		dispatch: 'authorizePublisher',
		accepts: '--host-token.<name>',
	},
	{
		verb: 'pinnace node',
		valid: ['node', 'status'],
		dispatch: 'runNodeCommand',
		overrides: {env: onBoxEnv},
	},
];

describe('every currently-valid flag still parses (the guard against over-refusing)', () => {
	for (const {verb, valid, dispatch, overrides} of verbCases) {
		it(`${verb}: a full command line using all of its real flags still runs`, async () => {
			const {deps, calls} = recordingDeps();
			const {context, err} = ctx({deps, ...overrides});
			const code = await run(valid, context);
			expect(err.join('\n')).toBe('');
			expect(code).toBe(0);
			expect(calls[dispatch].length).toBeGreaterThan(0);
		});
	}

	it('pinnace deploy: the OTHER ensName form (--unset-ens-name) is accepted too', async () => {
		const {deps, calls} = recordingDeps();
		const {context, err} = ctx({deps});
		const code = await run(
			['deploy', '--unset-ens-name', '--set-mode', 'ipfs', './dist', 'mysite'],
			context,
		);
		expect(err.join('\n')).toBe('');
		expect(code).toBe(0);
		expect(calls.deploy.length).toBe(1);
	});

	it('pinnace pin: the migrate form (--from-ipns, --unset-ens-name) is accepted too', async () => {
		const {deps, calls} = recordingDeps();
		const {context, err} = ctx({deps});
		const code = await run(
			['pin', '--from-ipns', 'k51src', '--as', 'ronan.eth', '--unset-ens-name'],
			context,
		);
		expect(err.join('\n')).toBe('');
		expect(code).toBe(0);
		expect(calls.pinExternal.length).toBe(1);
	});

	it('pinnace site: add/remove keep their positionals and --host', async () => {
		const {deps, calls} = recordingDeps();
		const {context, err} = ctx({deps});
		expect(
			await run(['site', 'add', 'mysite', 'bafyStub', '--host', 'a'], context),
		).toBe(0);
		expect(
			await run(['site', 'remove', 'mysite', '--host', 'a'], context),
		).toBe(0);
		expect(err.join('\n')).toBe('');
		expect(calls.addSite.length).toBe(1);
		expect(calls.removeSite.length).toBe(1);
	});

	it('pinnace version still prints the version', async () => {
		const {deps} = recordingDeps();
		const {context, out} = ctx({deps});
		expect(await run(['version'], context)).toBe(0);
		expect(out.length).toBe(1);
	});
});

describe('an unknown flag NAME is a loud refusal, per verb', () => {
	for (const {verb, valid, dispatch, overrides, accepts} of verbCases) {
		it(`${verb}: refuses an unknown flag, names it, and dispatches nothing`, async () => {
			const {deps, calls} = recordingDeps();
			const {context, err} = ctx({deps, ...overrides});
			const code = await run([...valid, '--nonsense', 'x'], context);
			expect(code).toBe(1);
			// The operation did NOT happen: the refusal is BEFORE any dispatch.
			expect(calls[dispatch].length).toBe(0);
			const message = err.join('\n');
			expect(message).toContain(verb);
			expect(message).toContain('unknown flag');
			expect(message).toContain("'--nonsense'");
			// It lists what the verb DOES accept, so the operator can fix it.
			if (accepts) expect(message).toContain(accepts);
		});
	}

	it('pinnace version: refuses an unknown flag rather than printing anyway', async () => {
		const {deps} = recordingDeps();
		const {context, out, err} = ctx({deps});
		expect(await run(['version', '--nonsense', 'x'], context)).toBe(1);
		expect(out.length).toBe(0);
		expect(err.join('\n')).toContain("'--nonsense'");
	});

	it('a verb that takes NO flags of its own says exactly that', async () => {
		const {deps, calls} = recordingDeps();
		const {context, err} = ctx({deps});
		expect(await run(['derive', 'mysite', '--host', 'a'], context)).toBe(1);
		expect(calls.deriveIpnsId.length).toBe(0);
		expect(err.join('\n')).toMatch(/accepts no flags of its own/);
	});

	it('names EVERY unknown flag on the line, not just the first', async () => {
		const {deps, calls} = recordingDeps();
		const {context, err} = ctx({deps});
		const code = await run(
			['status', '--nonsense', 'x', '--other', 'y'],
			context,
		);
		expect(code).toBe(1);
		expect(calls.statusReport.length).toBe(0);
		const message = err.join('\n');
		expect(message).toContain("'--nonsense'");
		expect(message).toContain("'--other'");
	});
});

describe('the regression that shipped: pin --mode after the --set-mode rename', () => {
	it('refuses `pin --from-ipns <src> --as x --mode ipns` and suggests --set-mode', async () => {
		const {deps, calls} = recordingDeps();
		const {context, err} = ctx({deps});
		const code = await run(
			[
				'pin',
				'--from-ipns',
				'k51source',
				'--as',
				'ronan.eth',
				'--mode',
				'ipns',
			],
			context,
		);
		expect(code).toBe(1);
		// Nothing was pinned as `ipfs` behind the operator's back.
		expect(calls.pinExternal.length).toBe(0);
		const message = err.join('\n');
		expect(message).toContain("'--mode'");
		expect(message).toContain('--set-mode');
		expect(message).toMatch(/renamed/i);
	});

	it('suggests the rename on `deploy --mode` too (both verbs were renamed)', async () => {
		const {deps, calls} = recordingDeps();
		const {context, err} = ctx({deps});
		const code = await run(
			['deploy', '--mode', 'ipns', './dist', 'mysite'],
			context,
		);
		expect(code).toBe(1);
		expect(calls.deploy.length).toBe(0);
		expect(err.join('\n')).toContain('--set-mode');
	});

	it('catches the plain typo too (`--set-mod ipns` used to pin as ipfs in silence)', async () => {
		const {deps, calls} = recordingDeps();
		const {context, err} = ctx({deps});
		const code = await run(
			['pin', 'bafyexternal', '--as', 'archive', '--set-mod', 'ipns'],
			context,
		);
		expect(code).toBe(1);
		expect(calls.pinExternal.length).toBe(0);
		expect(err.join('\n')).toContain("'--set-mod'");
	});
});

describe('the per-host override flags are PREFIX-shaped and stay accepted', () => {
	const nodeTouching: Array<{name: string; argv: string[]; dispatch: string}> =
		[
			{
				name: 'deploy',
				argv: ['deploy', './dist', 'mysite'],
				dispatch: 'deploy',
			},
			{
				name: 'pin',
				argv: ['pin', 'bafyexternal', '--as', 'archive'],
				dispatch: 'pinExternal',
			},
			{name: 'status', argv: ['status'], dispatch: 'statusReport'},
			{
				name: 'site',
				argv: ['site', 'list', '--host', 'a'],
				dispatch: 'listSites',
			},
			{
				name: 'authorize',
				argv: ['authorize', 'mysite'],
				dispatch: 'authorizePublisher',
			},
		];

	for (const {name, argv, dispatch} of nodeTouching) {
		it(`${name} accepts --host-endpoint.<name> / --host-token.<name> for ANY host name`, async () => {
			const {deps, calls} = recordingDeps();
			const {context, err} = ctx({deps});
			const code = await run(
				[
					...argv,
					'--host-endpoint.a',
					'https://a2.example',
					'--host-token.b',
					'tok-b',
				],
				context,
			);
			expect(err.join('\n')).toBe('');
			expect(code).toBe(0);
			expect(calls[dispatch].length).toBeGreaterThan(0);
		});
	}

	it('still refuses a MISSPELLED prefix flag (--host-endpoints.a)', async () => {
		const {deps, calls} = recordingDeps();
		const {context, err} = ctx({deps});
		const code = await run(
			['status', '--host-endpoints.a', 'https://a2.example'],
			context,
		);
		expect(code).toBe(1);
		expect(calls.statusReport.length).toBe(0);
		expect(err.join('\n')).toContain("'--host-endpoints.a'");
	});
});

describe('the GLOBAL flags are stripped first, so they are never "unknown"', () => {
	const positions: Array<{why: string; argv: string[]}> = [
		{
			why: 'before the command',
			argv: [
				'--config',
				'pinnace.json',
				'--endpoint',
				'https://solo.example',
				'status',
			],
		},
		{
			why: 'after the command',
			argv: [
				'status',
				'--config',
				'pinnace.json',
				'--endpoint',
				'https://solo.example',
			],
		},
	];

	for (const {why, argv} of positions) {
		it(`--config / --endpoint given ${why} are accepted`, async () => {
			const {deps, calls} = recordingDeps();
			const {context, err} = ctx({deps});
			const code = await run(argv, context);
			expect(err.join('\n')).toBe('');
			expect(code).toBe(0);
			expect(calls.statusReport.length).toBe(1);
		});
	}

	it('the globals reach the verbs that touch no node without being refused', async () => {
		const {deps, calls} = recordingDeps();
		const {context, err} = ctx({deps});
		const code = await run(
			['--endpoint', 'https://solo.example', 'derive', 'mysite'],
			context,
		);
		expect(err.join('\n')).toBe('');
		expect(code).toBe(0);
		expect(calls.deriveIpnsId.length).toBe(1);
	});
});

describe('the two guards compose: bare-value and unknown-name', () => {
	it('a KNOWN flag with no value still gets the bare-flag refusal', async () => {
		const {deps, calls} = recordingDeps();
		const {context, err} = ctx({deps});
		const code = await run(
			['deploy', './dist', 'mysite', '--gateways'],
			context,
		);
		expect(code).toBe(1);
		expect(calls.deploy.length).toBe(0);
		expect(err.join('\n')).toMatch(/needs a value/);
	});

	it('a bare --set-ens-name still INFERS (the optional-value exemption stands)', async () => {
		const {deps, calls} = recordingDeps();
		const {context} = ctx({deps});
		const code = await run(
			['deploy', './dist', 'mysite.eth', '--set-ens-name'],
			context,
		);
		expect(code).toBe(0);
		expect((calls.deploy[0] as {ensName: {kind: string}}).ensName).toEqual({
			kind: 'infer',
		});
	});

	it('a bare UNKNOWN flag is refused as UNKNOWN (the truer message wins)', async () => {
		const {deps, calls} = recordingDeps();
		const {context, err} = ctx({deps});
		const code = await run(['status', '--nonsense'], context);
		expect(code).toBe(1);
		expect(calls.statusReport.length).toBe(0);
		expect(err.join('\n')).toContain('unknown flag');
	});

	it("authorize keeps its OWN tailored --host refusal (not 'unknown flag')", async () => {
		const {deps, calls} = recordingDeps();
		const {context, err} = ctx({deps});
		const code = await run(['authorize', 'mysite', '--host', 'a'], context);
		expect(code).toBe(1);
		expect(calls.authorizePublisher.length).toBe(0);
		const message = err.join('\n');
		expect(message).toContain('--host is not accepted');
		expect(message).not.toContain('unknown flag');
	});
});
