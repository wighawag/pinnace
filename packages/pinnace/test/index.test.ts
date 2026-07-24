import {describe, it, expect} from 'vitest';
import {name, PINNACE} from '../src/index.js';
import {run} from '../src/cli/run.js';

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
			expect(await run(['node', verb])).toEqual(0);
		}
	});

	it('rejects `node` with a missing or unknown verb (non-zero exit)', async () => {
		expect(await run(['node'])).toEqual(1);
		expect(await run(['node', 'frobnicate'])).toEqual(1);
	});

	it('routes the `site <verb>` namespace and accepts list/remove/add', async () => {
		for (const verb of ['list', 'remove', 'add']) {
			expect(await run(['site', verb])).toEqual(0);
		}
	});

	it('rejects `site` with a missing or unknown verb (non-zero exit)', async () => {
		expect(await run(['site'])).toEqual(1);
		expect(await run(['site', 'frobnicate'])).toEqual(1);
	});
});
