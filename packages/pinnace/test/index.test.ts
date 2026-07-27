import {describe, it, expect} from 'vitest';
import {name, PINNACE, PINNACE_VERSION} from '../src/index.js';
import {run, type ClientDeps, type RunContext} from '../src/cli/run.js';
import type {PinnaceConfigFile} from '../src/config/config-resolution.js';

/**
 * A hermetic context that stubs the node/site core so these SEAM tests assert
 * ROUTING (the verb reaches the right namespace + dispatches into the core)
 * without touching a live daemon, the real env, or the real ./pinnace.json.
 * The full dispatch-with-resolved-args coverage lives in
 * test/cli/node-site-authorize-commands.test.ts; here we only prove the router
 * hands the four node verbs / three site verbs through end-to-end.
 */
function seamContext(): RunContext {
	const file: PinnaceConfigFile = {
		hosts: [{name: 'a', endpoint: 'https://a.example', role: 'publisher'}],
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

	it('exposes the package VERSION as a separate fact from the name', () => {
		// One source of truth, re-exported from the core (test/version.test.ts
		// ties it to package.json and proves it resolves from dist too).
		expect(PINNACE_VERSION).not.toEqual(PINNACE);
		expect(PINNACE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
	});
});

describe('pinnace cli seam', () => {
	it('dispatches `version` through to the core version (thin-wrapper seam)', async () => {
		const lines: string[] = [];
		const code = await run(['version'], {out: (line) => lines.push(line)});
		expect(code).toEqual(0);
		expect(lines).toEqual([PINNACE_VERSION]);
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
