import {describe, it, expect} from 'vitest';
import {run, type ClientDeps, type RunContext} from '../../src/cli/run.js';
import type {PinnaceConfigFile} from '../../src/config/config-resolution.js';

/**
 * These tests cover the GLOBAL `--endpoint <url>` flag and the shared
 * bare-flag refusal it generalises:
 *
 *  - `--endpoint` is accepted in BOTH positions (before or after the command),
 *    exactly like `--config`, and means the same thing in each,
 *  - a BARE `--endpoint` (end of argv, immediately followed by another
 *    `--flag`, or an explicit empty value) is a LOUD usage error: it must
 *    NEVER be dropped, which would silently WIDEN the run back to the config's
 *    hosts,
 *  - giving it in both positions refuses loudly instead of picking one,
 *  - what the flag MEANS is unchanged: it REPLACES the file's hosts for the
 *    run, while `--host-endpoint.<name>` still overrides the endpoint OF a
 *    configured host,
 *  - the sibling value-taking flags that shared the swallowed-bare-form defect
 *    (`--host`, `--gateways`, `--host-endpoint.<name>`, `--host-token.<name>`,
 *    provision's and install-ci's optional flags) refuse the same way.
 *
 * They stay hermetic: env + config file are injected through the
 * {@link RunContext}, so the operator's real environment and real
 * `./pinnace.json` are never read.
 */

/** A recording stub core; only the verbs these tests dispatch to. */
function recordingDeps(): {deps: ClientDeps; calls: Record<string, unknown[]>} {
	const calls: Record<string, unknown[]> = {
		deploy: [],
		statusReport: [],
		pinExternal: [],
		listSites: [],
		provision: [],
		emitCi: [],
	};
	const deps: Partial<ClientDeps> = {
		deploy: async (input) => {
			calls.deploy.push(input);
			return {
				cid: 'bafyStub',
				mode: input.mode ?? 'ipfs',
				ok: [],
				failed: [],
				success: true,
			};
		},
		statusReport: async (input) => {
			calls.statusReport.push(input);
			return {peerId: 'peer-stub', sites: []};
		},
		pinExternal: async (input) => {
			calls.pinExternal.push(input);
			return {
				cid: input.cid ?? 'bafyStub',
				name: input.name,
				recursive: input.recursive ?? true,
				mode: input.mode ?? 'ipfs',
				ok: [],
				failed: [],
				success: true,
			};
		},
		listSites: async (input) => {
			calls.listSites.push(input);
			return [];
		},
		provision: (input) => {
			calls.provision.push(input);
			return {
				host: 'hetzner',
				cloudInit: {path: 'cloud-init.yaml', contents: '#cloud-config\n'},
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
	};
	return {deps: deps as ClientDeps, calls};
}

/** A two-host in-memory `pinnace.json` (what a dropped --endpoint widens to). */
const fileConfig: PinnaceConfigFile = {
	hosts: [
		{name: 'a', endpoint: 'https://a.example', role: 'publisher'},
		{name: 'b', endpoint: 'https://b.example', role: 'replica'},
	],
};

/** Tokens for the file hosts AND for the CLI-supplied single node. */
const tokenEnv = {
	PINNACE_HOST_A_TOKEN: 'env-token-a',
	PINNACE_HOST_B_TOKEN: 'env-token-b',
	PINNACE_HOST_PUBLISHER_TOKEN: 'env-token-solo',
} as const;

function ctx(overrides: Partial<RunContext> = {}): {
	context: RunContext;
	out: string[];
	err: string[];
} {
	const out: string[] = [];
	const err: string[] = [];
	const context: RunContext = {
		env: {...tokenEnv},
		loadConfigFile: () => fileConfig,
		out: (line) => out.push(line),
		err: (line) => err.push(line),
		...overrides,
	};
	return {context, out, err};
}

describe('--endpoint is GLOBAL: accepted before OR after the command', () => {
	it('deploy behaves identically with --endpoint before and after the verb', async () => {
		const before = recordingDeps();
		const codeBefore = await run(
			['--endpoint', 'https://solo.example', 'deploy', './dist', 'mysite'],
			ctx({deps: before.deps}).context,
		);
		const after = recordingDeps();
		const codeAfter = await run(
			['deploy', '--endpoint', 'https://solo.example', './dist', 'mysite'],
			ctx({deps: after.deps}).context,
		);
		expect(codeBefore).toBe(0);
		expect(codeAfter).toBe(0);
		expect(before.calls.deploy[0]).toEqual(after.calls.deploy[0]);
		// And it is the CLI node alone, not the file's two hosts.
		const input = before.calls.deploy[0] as {
			sourceDir: string;
			id: string;
			targets: Array<{baseUrl: string; token: string; role: string}>;
		};
		expect(input.sourceDir).toBe('./dist');
		expect(input.id).toBe('mysite');
		expect(input.targets).toEqual([
			{
				baseUrl: 'https://solo.example',
				token: 'env-token-solo',
				role: 'publisher',
			},
		]);
	});

	it('`pinnace --endpoint <url> status` works (it is not read as a command)', async () => {
		const {deps, calls} = recordingDeps();
		const {context, err} = ctx({deps});
		const code = await run(
			['--endpoint', 'https://solo.example', 'status'],
			context,
		);
		expect(code).toBe(0);
		expect(err.join('\n')).not.toContain('unknown command');
		// One report, against the CLI-supplied node only.
		expect(calls.statusReport.length).toBe(1);
		expect(
			(calls.statusReport[0] as {client: {baseUrl: string}}).client.baseUrl,
		).toBe('https://solo.example');
	});

	it('is global for the site namespace too (before the `site` verb)', async () => {
		const {deps, calls} = recordingDeps();
		const {context} = ctx({deps});
		const code = await run(
			['--endpoint', 'https://solo.example', 'site', 'list'],
			context,
		);
		expect(code).toBe(0);
		expect(
			(calls.listSites[0] as {client: {baseUrl: string}}).client.baseUrl,
		).toBe('https://solo.example');
	});

	it('refuses LOUDLY when given in BOTH positions rather than picking one', async () => {
		const {deps, calls} = recordingDeps();
		const {context, err} = ctx({deps});
		const code = await run(
			[
				'--endpoint',
				'https://one.example',
				'deploy',
				'--endpoint',
				'https://two.example',
				'./dist',
				'mysite',
			],
			context,
		);
		expect(code).toBe(1);
		expect(calls.deploy.length).toBe(0);
		const message = err.join('\n');
		expect(message).toContain('--endpoint');
		expect(message).toContain('https://one.example');
		expect(message).toContain('https://two.example');
	});

	it('refuses a repeat even when both values are the same', async () => {
		const {deps, calls} = recordingDeps();
		const {context, err} = ctx({deps});
		const code = await run(
			[
				'status',
				'--endpoint',
				'https://solo.example',
				'--endpoint',
				'https://solo.example',
			],
			context,
		);
		expect(code).toBe(1);
		expect(calls.statusReport.length).toBe(0);
		expect(err.join('\n')).toContain('--endpoint');
	});
});

describe('a BARE --endpoint is a loud usage error, never a silent widening', () => {
	/** The three bare shapes, in both positions. */
	const bareShapes: Array<{why: string; argv: string[]}> = [
		{
			why: 'at the end of argv',
			argv: ['deploy', './dist', 'mysite', '--endpoint'],
		},
		{
			why: 'immediately followed by another --flag',
			argv: ['deploy', '--endpoint', '--set-mode', 'ipns', './dist', 'mysite'],
		},
		{
			why: 'an explicit empty value',
			argv: ['deploy', '--endpoint', '', './dist', 'mysite'],
		},
		{
			why: 'before the verb, followed by another --flag',
			argv: ['--endpoint', '--config', 'pinnace.json', 'status'],
		},
	];

	for (const {why, argv} of bareShapes) {
		it(`refuses a bare --endpoint ${why} (and dispatches nothing)`, async () => {
			const {deps, calls} = recordingDeps();
			const {context, err} = ctx({deps});
			const code = await run(argv, context);
			expect(code).toBe(1);
			// The whole point: the run did NOT widen back to the file's hosts.
			expect(calls.deploy.length).toBe(0);
			expect(calls.statusReport.length).toBe(0);
			const message = err.join('\n');
			expect(message).toContain('--endpoint');
			// It shows the expected form.
			expect(message).toContain('<url>');
		});
	}

	it('refuses `pinnace --endpoint` alone rather than exiting 0 with no command', async () => {
		const {deps} = recordingDeps();
		const {context, err} = ctx({deps});
		expect(await run(['--endpoint'], context)).toBe(1);
		expect(err.join('\n')).toContain('--endpoint');
	});
});

describe('--endpoint MEANS the same thing: arg > env > file, replacing the hosts', () => {
	it('replaces the file hosts for the run (given before the verb)', async () => {
		const {deps, calls} = recordingDeps();
		const {context} = ctx({deps});
		const code = await run(
			['--endpoint', 'https://solo.example', 'status'],
			context,
		);
		expect(code).toBe(0);
		// The two file hosts are NOT reported: the CLI node replaced them.
		expect(calls.statusReport.length).toBe(1);
	});

	it('--host-endpoint.<name> still overrides the endpoint OF a configured host', async () => {
		const {deps, calls} = recordingDeps();
		const {context} = ctx({deps});
		const code = await run(
			['deploy', '--host-endpoint.a', 'https://a2.example', './dist', 'mysite'],
			context,
		);
		expect(code).toBe(0);
		const input = calls.deploy[0] as {targets: Array<{baseUrl: string}>};
		// Both hosts stay; only a's endpoint moved.
		expect(input.targets.map((t) => t.baseUrl)).toEqual([
			'https://a2.example',
			'https://b.example',
		]);
	});
});

describe('sibling value-taking flags refuse their bare form the same way', () => {
	const cases: Array<{name: string; argv: string[]; dispatch: string}> = [
		{
			name: '--host (pin: a bare one would widen to every node)',
			argv: ['pin', 'bafyexternal', '--as', 'archive', '--host'],
			dispatch: 'pinExternal',
		},
		{
			name: '--host (site: a bare one would auto-pick a node)',
			argv: ['site', 'list', '--host'],
			dispatch: 'listSites',
		},
		{
			name: '--gateways',
			argv: ['deploy', './dist', 'mysite', '--gateways'],
			dispatch: 'deploy',
		},
		{
			name: '--host-endpoint.<name>',
			argv: ['deploy', './dist', 'mysite', '--host-endpoint.a'],
			dispatch: 'deploy',
		},
		{
			name: '--host-token.<name>',
			argv: ['deploy', './dist', 'mysite', '--host-token.a'],
			dispatch: 'deploy',
		},
		{
			name: "provision's --kubo-version",
			argv: [
				'provision',
				'--host',
				'hetzner',
				'--api-domain',
				'api.example',
				'--acme-email',
				'a@example',
				'--bearer-token',
				't',
				'--role',
				'publisher',
				'--kubo-version',
			],
			dispatch: 'provision',
		},
		{
			name: "install-ci's --branch",
			argv: [
				'install-ci',
				'--system',
				'github',
				'--build-command',
				'npm run build',
				'--output-dir',
				'dist',
				'--branch',
			],
			dispatch: 'emitCi',
		},
	];

	for (const {name, argv, dispatch} of cases) {
		it(`a bare ${name} is a loud usage error`, async () => {
			const {deps, calls} = recordingDeps();
			const {context, err} = ctx({deps});
			const code = await run(argv, context);
			expect(code).toBe(1);
			expect(calls[dispatch].length).toBe(0);
			expect(err.join('\n')).toMatch(/needs a value/);
		});
	}

	it('leaves the OPTIONAL-value flags alone: a bare --set-ens-name still INFERS', async () => {
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

	it('leaves --set-mode its OWN tailored bare refusal (naming ipfs|ipns)', async () => {
		const {deps, calls} = recordingDeps();
		const {context, err} = ctx({deps});
		const code = await run(
			['deploy', './dist', 'mysite', '--set-mode'],
			context,
		);
		expect(code).toBe(1);
		expect(calls.deploy.length).toBe(0);
		const message = err.join('\n');
		expect(message).toContain('ipfs');
		expect(message).toContain('ipns');
	});
});
