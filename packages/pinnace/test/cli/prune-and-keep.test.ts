import {describe, it, expect, vi, afterEach} from 'vitest';
import {run, type ClientDeps, type RunContext} from '../../src/cli/run.js';
import {MockKuboApi} from '../../src/rpc/mock-kubo.js';
import {
	PruneKeepRequiredError,
	type PruneSiteResult,
} from '../../src/site/site-retention.js';
import {parseSiteMetadata} from '../../src/site/site-wrapper.js';
import type {PinnaceConfigFile} from '../../src/config/config-resolution.js';

/**
 * The RETENTION surface: `--set-keep` / `--unset-keep` on deploy/pin (the
 * policy, stored with the site) and the `prune` verb (the action).
 *
 * The property worth defending hardest is that FORGETTING is opt-in and
 * visible. pinnace cannot read an ENS record, so it can never prove a
 * superseded cid is unreferenced; every default therefore leans towards keeping
 * content, and the one verb that destroys data is a dry run until told
 * otherwise.
 */

const fileConfig: PinnaceConfigFile = {
	hosts: [
		{name: 'a', endpoint: 'https://a.example', role: 'publisher'},
		{name: 'b', endpoint: 'https://b.example', role: 'replica'},
	],
};

const hostTokenEnv = {
	PINNACE_HOST_A_TOKEN: 'token-a',
	PINNACE_HOST_B_TOKEN: 'token-b',
} as const;

function ctx(overrides: Partial<RunContext> = {}): {
	context: RunContext;
	out: string[];
	err: string[];
} {
	const out: string[] = [];
	const err: string[] = [];
	return {
		context: {
			env: {...hostTokenEnv},
			loadConfigFile: () => fileConfig,
			out: (line) => out.push(line),
			err: (line) => err.push(line),
			...overrides,
		},
		out,
		err,
	};
}

/** A stub core that records what the CLI asked of it. */
function recordingDeps(
	result: Partial<PruneSiteResult> = {},
	deploy?: ClientDeps['deploy'],
): {deps: ClientDeps; calls: Record<string, unknown[]>} {
	const calls: Record<string, unknown[]> = {pruneSite: [], deploy: [], pin: []};
	const deps = {
		pruneSite: async (input) => {
			calls.pruneSite.push(input);
			return {
				id: input.id,
				keep: input.keep ?? 3,
				stated: input.keep !== undefined,
				before: ['bafy1', 'bafy2'],
				history: ['bafy1'],
				pruned: [{cid: 'bafy2', outcome: 'unpinned'}],
				...result,
			} satisfies PruneSiteResult;
		},
		deploy:
			deploy ??
			(async (input) => {
				calls.deploy.push(input);
				return {
					cid: 'bafyStub',
					mode: input.mode ?? 'ipfs',
					ok: [],
					failed: [],
					success: true,
				};
			}),
		pinExternal: async (input) => {
			calls.pin.push(input);
			return {
				cid: input.cid ?? 'bafyStub',
				name: input.name,
				recursive: true,
				mode: 'ipfs',
				ok: [],
				failed: [],
				success: true,
			};
		},
	} as Partial<ClientDeps> as ClientDeps;
	return {deps, calls};
}

describe('--set-keep / --unset-keep: the policy, carried by deploy and pin', () => {
	it('deploy passes the stated policy down as an INTENT', async () => {
		const {deps, calls} = recordingDeps();
		const {context} = ctx({deps});
		expect(
			await run(['deploy', '--set-keep', '3', './dist', 'mysite'], context),
		).toBe(0);
		expect((calls.deploy[0] as {keep: unknown}).keep).toEqual({
			kind: 'set',
			keep: 3,
		});
	});

	it('omitting both flags PRESERVES (a routine deploy changes no policy)', async () => {
		const {deps, calls} = recordingDeps();
		const {context} = ctx({deps});
		await run(['deploy', './dist', 'mysite'], context);
		expect((calls.deploy[0] as {keep: unknown}).keep).toEqual({
			kind: 'preserve',
		});
	});

	it('--unset-keep goes back to keeping everything', async () => {
		const {deps, calls} = recordingDeps();
		const {context} = ctx({deps});
		await run(['deploy', '--unset-keep', './dist', 'mysite'], context);
		expect((calls.deploy[0] as {keep: unknown}).keep).toEqual({kind: 'unset'});
	});

	it('pin carries the same policy (one concept, both verbs)', async () => {
		const {deps, calls} = recordingDeps();
		const {context} = ctx({deps});
		await run(
			['pin', 'bafyexternal', '--as', 'mirror', '--set-keep', '0'],
			context,
		);
		expect((calls.pin[0] as {keep: unknown}).keep).toEqual({
			kind: 'set',
			keep: 0,
		});
	});

	it('refuses a count that is not a whole number of builds', async () => {
		for (const bad of ['2.5', '-1', 'lots']) {
			const {deps, calls} = recordingDeps();
			const {context, err} = ctx({deps});
			expect(
				await run(['deploy', '--set-keep', bad, './dist', 'mysite'], context),
			).toBe(1);
			expect(calls.deploy.length).toBe(0);
			expect(err.join('\n')).toMatch(/whole number/);
		}
	});

	it('refuses the two flags together (they contradict)', async () => {
		const {deps, calls} = recordingDeps();
		const {context, err} = ctx({deps});
		expect(
			await run(
				['deploy', '--set-keep', '3', '--unset-keep', './dist', 'mysite'],
				context,
			),
		).toBe(1);
		expect(calls.deploy.length).toBe(0);
		expect(err.join('\n')).toMatch(/contradict/);
	});
});

describe('prune: the action, dry by default', () => {
	it('is a DRY RUN unless --apply, and says so', async () => {
		const {deps, calls} = recordingDeps();
		const {context, out} = ctx({deps});
		expect(await run(['prune', 'mysite'], context)).toBe(0);
		// Every configured node: each holds its own pins.
		expect(calls.pruneSite.length).toBe(2);
		for (const call of calls.pruneSite) {
			expect((call as {apply: boolean}).apply).toBe(false);
		}
		const printed = out.join('\n');
		expect(printed).toMatch(/would unpin bafy2/);
		expect(printed).toMatch(/DRY RUN: nothing was unpinned/);
	});

	it('--apply does it, and says where the space actually comes back', async () => {
		const {deps, calls} = recordingDeps();
		const {context, out} = ctx({deps});
		expect(await run(['prune', 'mysite', '--apply'], context)).toBe(0);
		expect((calls.pruneSite[0] as {apply: boolean}).apply).toBe(true);
		const printed = out.join('\n');
		expect(printed).toMatch(/unpin bafy2/);
		expect(printed).not.toMatch(/DRY RUN/);
		// Unpinning makes blocks eligible; Kubo's gc is what frees the disk.
		expect(printed).toMatch(/repo gc/);
	});

	it('--host narrows to one node', async () => {
		const {deps, calls} = recordingDeps();
		const {context} = ctx({deps});
		await run(['prune', 'mysite', '--host', 'b'], context);
		expect(calls.pruneSite.length).toBe(1);
	});

	it('passes a one-off --keep through, and refuses a bad one', async () => {
		const {deps, calls} = recordingDeps();
		const {context} = ctx({deps});
		await run(['prune', 'mysite', '--keep', '5'], context);
		expect((calls.pruneSite[0] as {keep: number}).keep).toBe(5);

		const {context: c2, err} = ctx({deps: recordingDeps().deps});
		expect(await run(['prune', 'mysite', '--keep', '-2'], c2)).toBe(1);
		expect(err.join('\n')).toMatch(/whole number/);
	});

	it('reports a site with NO policy per node, without guessing one', async () => {
		const {deps} = recordingDeps();
		const failing: ClientDeps = {
			...deps,
			pruneSite: async (input) => {
				throw new PruneKeepRequiredError(input.id);
			},
		};
		const {context, err} = ctx({deps: failing});
		expect(await run(['prune', 'mysite'], context)).toBe(1);
		expect(err.join('\n')).toMatch(/stores no retention policy/);
		// It says how to fix it BOTH ways: a one-off, or a stored policy.
		expect(err.join('\n')).toMatch(/--keep <n>/);
		expect(err.join('\n')).toMatch(/--set-keep/);
	});

	it('needs a site id', async () => {
		const {deps, calls} = recordingDeps();
		const {context, err} = ctx({deps});
		expect(await run(['prune'], context)).toBe(1);
		expect(calls.pruneSite.length).toBe(0);
		expect(err.join('\n')).toMatch(/usage: pinnace prune <id>/);
	});
});

describe('prune: end to end against a mock node (no core stub)', () => {
	/** A node holding `mysite` with a history and a stored keep policy. */
	function node(): MockKuboApi {
		const mock = new MockKuboApi('https://a.example');
		mock.on('files/ls', {json: {Entries: [{Name: 'mysite'}]}});
		mock.onArg('files/stat', '/sites/mysite/content', {
			json: {Hash: 'bafyLive'},
		});
		mock.on('files/read', {
			text: JSON.stringify({
				mode: 'ipfs',
				keep: 1,
				history: ['bafyPrev', 'bafyOld', 'bafyLive'],
			}),
		});
		return mock;
	}

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('unpins only what the policy selects, guarding the live cid, and rewrites history', async () => {
		const mock = node();
		// The CLI builds its own client, so the seam here is the global fetch.
		vi.stubGlobal('fetch', mock.fetchImpl);
		const out: string[] = [];
		const code = await run(['prune', 'mysite', '--apply', '--host', 'a'], {
			env: {...hostTokenEnv},
			loadConfigFile: () => ({hosts: [fileConfig.hosts![0]]}),
			out: (line) => out.push(line),
			err: () => {},
			// The real core: only the network is a mock.
		} as RunContext);
		expect(code).toBe(0);

		// keep 1 => bafyPrev survives; bafyOld goes; bafyLive is PROTECTED because
		// the site currently resolves to it (Kubo pins are not refcounted).
		expect(mock.requestsFor('pin/rm').map((r) => r.query.get('arg'))).toEqual([
			'bafyOld',
		]);
		const write = mock.requestsFor('files/write')[0];
		const bytes = write.fileParts!.find((p) => p.field === 'file')!.bytes;
		expect(parseSiteMetadata(bytes)).toEqual({
			mode: 'ipfs',
			keep: 1,
			history: ['bafyPrev', 'bafyLive'],
		});
		expect(out.join('\n')).toMatch(/protected bafyLive/);
	});
});
