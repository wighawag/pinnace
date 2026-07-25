import {describe, it, expect} from 'vitest';
import {name, PINNACE} from '../src/index.js';
import {run, type ClientDeps, type RunContext} from '../src/cli/run.js';
import type {PinnaceConfigFile} from '../src/config/config-resolution.js';

/**
 * A hermetic context that stubs the node/site core so these SEAM tests assert
 * ROUTING (the verb reaches the right namespace + dispatches into the core)
 * without touching a live daemon, the real env, or the real ./pinnace.json.
 * The full dispatch-with-resolved-args coverage lives in
 * test/cli/node-site-promote-commands.test.ts; here we only prove the router
 * hands the four node verbs / three site verbs through end-to-end.
 */
function seamContext(): RunContext {
	const file: PinnaceConfigFile = {
		hosts: [{name: 'a', endpoint: 'https://a.example', role: 'publisher'}],
		sites: [{id: 'mysite', mode: 'ipns', sourceDir: './dist'}],
	};
	const deps: Partial<ClientDeps> = {
		runNodeCommand: async (verb) => ({verb, sites: []}),
		listSites: async () => [],
		removeSite: async (input) => ({id: input.id, unpinned: true}),
		addSite: async (input) => ({id: input.id, cid: input.cid}),
	};
	return {
		env: {
			PINNACE_HOST_A_TOKEN: 'env-token-a',
			NODE_ROLE: 'publisher',
			RPC_BEARER_TOKEN: 'box-bearer',
		},
		loadConfigFile: () => file,
		deps: deps as ClientDeps,
		out: () => {},
		err: () => {},
	};
}

describe('pinnace core', () => {
	it('exposes the package name from the library core', () => {
		expect(name()).toEqual('pinnace');
		expect(PINNACE).toEqual('pinnace');
	});
});

describe('pinnace cli seam', () => {
	it('dispatches `version` through to the core name (thin-wrapper seam)', async () => {
		const code = await run(['version']);
		expect(code).toEqual(0);
	});

	it('routes the on-box `node <verb>` namespace and accepts the four verbs', async () => {
		for (const verb of ['republish', 'mirror', 'warm', 'status']) {
			expect(await run(['node', verb], seamContext())).toEqual(0);
		}
	});

	it('rejects `node` with a missing or unknown verb (non-zero exit)', async () => {
		expect(await run(['node'], seamContext())).toEqual(1);
		expect(await run(['node', 'frobnicate'], seamContext())).toEqual(1);
	});

	it('routes the `site <verb>` namespace and accepts list/remove/add', async () => {
		// remove/add need their positional args to reach the core cleanly.
		expect(await run(['site', 'list'], seamContext())).toEqual(0);
		expect(await run(['site', 'remove', 'mysite'], seamContext())).toEqual(0);
		expect(
			await run(['site', 'add', 'mysite', 'bafyNew'], seamContext()),
		).toEqual(0);
	});

	it('rejects `site` with a missing or unknown verb (non-zero exit)', async () => {
		expect(await run(['site'], seamContext())).toEqual(1);
		expect(await run(['site', 'frobnicate'], seamContext())).toEqual(1);
	});
});
