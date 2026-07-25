import {describe, it, expect} from 'vitest';
import {KuboRpcClient} from '../../src/rpc/kubo-rpc-client.js';
import {MockKuboApi} from '../../src/rpc/mock-kubo.js';
import {
	pinExternal,
	PinStageError,
	type PinTarget,
} from '../../src/pin/pin-external.js';
import {removeSite} from '../../src/site/site-management.js';
import {discoverSites} from '../../src/node/node-commands.js';

/**
 * `pinExternal` tests (task `pin-external-cid`).
 *
 * Pinning an ARBITRARY network CID is tested at the Kubo RPC boundary through
 * the recording {@link MockKuboApi} (spec Testing Decisions: no live daemon).
 * We assert:
 *  - the `pin/add?arg=<cid>&recursive=true` call shape + each node's OWN bearer
 *    token, on EVERY configured node (redundant by default),
 *  - the MFS placement (`files/mkdir` / `files/rm` / `files/cp`) at
 *    `/sites/<name>` so status/warm/republish auto-discover the pin,
 *  - the deploy-style `allSettled` partial-failure semantics (a non-empty
 *    success subset is still an overall success), including which STAGE failed,
 *  - that `site remove <name>` (the EXISTING verb) unpins a pin-added site, so
 *    no second removal verb is needed.
 *
 * Each node gets its OWN MockKuboApi (own baseUrl + token + recorded requests),
 * so the fan-out and per-token isolation are observable.
 */

const EXTERNAL_CID = 'bafyexternalcid';

/** A fresh mock node; `files/stat` resolves to the pinned CID (for removal). */
function mockNode(baseUrl: string, cid = EXTERNAL_CID): MockKuboApi {
	const mock = new MockKuboApi(baseUrl);
	mock.on('files/stat', {json: {Hash: cid, Type: 'directory'}});
	return mock;
}

/** A pin target backed by its own recording mock (distinct baseUrl + token). */
function targetWith(mock: MockKuboApi, token: string): PinTarget {
	return {baseUrl: mock.baseUrl, token, fetchImpl: mock.fetchImpl};
}

describe('pinExternal — pin/add an arbitrary CID on EVERY node (redundant)', () => {
	it('issues pin/add?arg=<cid>&recursive=true on every node with its OWN token', async () => {
		const a = mockNode('https://node-a.test');
		const b = mockNode('https://node-b.test');
		const result = await pinExternal({
			targets: [targetWith(a, 'token-a'), targetWith(b, 'token-b')],
			cid: EXTERNAL_CID,
			name: 'archive',
		});

		expect(result.success).toBe(true);
		expect(result.ok.map((r) => r.baseUrl)).toEqual([
			'https://node-a.test',
			'https://node-b.test',
		]);
		expect(result.failed.length).toBe(0);
		expect(result.cid).toBe(EXTERNAL_CID);
		expect(result.name).toBe('archive');
		expect(result.recursive).toBe(true);

		const tokens = {a: 'Bearer token-a', b: 'Bearer token-b'};
		for (const [key, mock] of [
			['a', a],
			['b', b],
		] as const) {
			const pin = mock.requestsFor('pin/add');
			expect(pin.length).toBe(1);
			expect(pin[0].query.get('arg')).toBe(EXTERNAL_CID);
			expect(pin[0].query.get('recursive')).toBe('true');
			expect(pin[0].headers['authorization']).toBe(tokens[key]);
		}
	});

	it('does NOT import a CAR (pin FETCHES an existing CID; it never uploads bytes)', async () => {
		const a = mockNode('https://node-a.test');
		await pinExternal({
			targets: [targetWith(a, 'token-a')],
			cid: EXTERNAL_CID,
			name: 'archive',
		});
		expect(a.requestsFor('dag/import').length).toBe(0);
		expect(a.requestsFor('add').length).toBe(0);
	});

	it('passes recursive=false through when the operator disables recursion', async () => {
		const a = mockNode('https://node-a.test');
		const result = await pinExternal({
			targets: [targetWith(a, 'token-a')],
			cid: EXTERNAL_CID,
			name: 'archive',
			recursive: false,
		});
		expect(result.recursive).toBe(false);
		expect(a.requestsFor('pin/add')[0].query.get('recursive')).toBe('false');
	});

	it('narrows to a single node when only one target is given (--host)', async () => {
		const a = mockNode('https://node-a.test');
		const b = mockNode('https://node-b.test');
		const result = await pinExternal({
			targets: [targetWith(a, 'token-a')],
			cid: EXTERNAL_CID,
			name: 'archive',
		});
		expect(result.ok.map((r) => r.baseUrl)).toEqual(['https://node-a.test']);
		expect(b.requests.length).toBe(0);
	});
});

describe('pinExternal — MFS placement so the pin is tracked like a site', () => {
	it('places the pinned CID at /sites/<name> (mkdir / rm / cp) AFTER pinning', async () => {
		const a = mockNode('https://node-a.test');
		await pinExternal({
			targets: [targetWith(a, 'token-a')],
			cid: EXTERNAL_CID,
			name: 'archive',
		});

		// The exact call sequence: pin FIRST (the node must hold the bytes), then
		// the MFS placement that makes status/warm/republish discover it.
		expect(a.requests.map((r) => r.path)).toEqual([
			'pin/add',
			'files/mkdir',
			'files/rm',
			'files/cp',
		]);

		const mkdir = a.requestsFor('files/mkdir')[0];
		expect(mkdir.query.get('arg')).toBe('/sites');
		expect(mkdir.query.get('parents')).toBe('true');

		const cp = a.requestsFor('files/cp')[0];
		expect(cp.query.getAll('arg')).toEqual([
			`/ipfs/${EXTERNAL_CID}`,
			'/sites/archive',
		]);
	});

	it('lands the pin where the on-box auto-discovery (warm/status) reads sites', async () => {
		const a = mockNode('https://node-a.test');
		await pinExternal({
			targets: [targetWith(a, 'token-a')],
			cid: EXTERNAL_CID,
			name: 'archive',
		});

		// Feed the MFS listing back from the placement the pin ACTUALLY made (the
		// mock holds no state): the entry `pin` created is the entry the on-box
		// discovery (used by warm / republish / status / the dashboard) reads.
		const placed = a
			.requestsFor('files/cp')
			.map((r) => r.query.getAll('arg')[1].replace('/sites/', ''));
		a.on('files/ls', {json: {Entries: placed.map((Name) => ({Name}))}});

		const discovered = await discoverSites(
			new KuboRpcClient({
				baseUrl: a.baseUrl,
				token: 'token-a',
				fetchImpl: a.fetchImpl,
			}),
		);
		expect(discovered).toEqual([{id: 'archive', cid: EXTERNAL_CID}]);
	});

	it('honours an explicit sitesDir', async () => {
		const a = mockNode('https://node-a.test');
		await pinExternal({
			targets: [targetWith(a, 'token-a')],
			cid: EXTERNAL_CID,
			name: 'archive',
			sitesDir: '/custom',
		});
		expect(a.requestsFor('files/cp')[0].query.getAll('arg')).toEqual([
			`/ipfs/${EXTERNAL_CID}`,
			'/custom/archive',
		]);
	});
});

describe('pinExternal — fan-out partial failure (a non-empty subset is success)', () => {
	it('reports the unretrievable node and still succeeds overall', async () => {
		const good = mockNode('https://good.test');
		const bad = mockNode('https://bad.test');
		// Kubo could not find/fetch the content on this node.
		bad.on('pin/add', {status: 500, text: 'merkledag: not found'});

		const result = await pinExternal({
			targets: [targetWith(good, 'token-good'), targetWith(bad, 'token-bad')],
			cid: EXTERNAL_CID,
			name: 'archive',
		});

		expect(result.success).toBe(true);
		expect(result.ok.map((r) => r.baseUrl)).toEqual(['https://good.test']);
		expect(result.failed.length).toBe(1);
		expect(result.failed[0].baseUrl).toBe('https://bad.test');
		expect(result.failed[0].stage).toBe('pin');
		// The error is clear about WHAT failed and WHY it might have (retrievability).
		expect(result.failed[0].error).toBeInstanceOf(PinStageError);
		expect(result.failed[0].error.message).toContain('pin/add');
		expect(result.failed[0].error.message).toContain(EXTERNAL_CID);
		expect(result.failed[0].error.message).toMatch(/retrievab/i);

		// The failing node never got the MFS placement (nothing to place).
		expect(bad.requestsFor('files/cp').length).toBe(0);
		// The good node was unaffected by the bad node's failure.
		expect(good.requestsFor('files/cp').length).toBe(1);
	});

	it('reports the MFS-placement stage separately from the pin stage', async () => {
		const a = mockNode('https://node-a.test');
		a.on('files/cp', {status: 500, text: 'file already exists'});
		const result = await pinExternal({
			targets: [targetWith(a, 'token-a')],
			cid: EXTERNAL_CID,
			name: 'archive',
		});
		expect(result.success).toBe(false);
		expect(result.failed[0].stage).toBe('place');
		expect(result.failed[0].error.message).toContain('/sites/archive');
		// It DID pin (the failure is downstream of the pin).
		expect(a.requestsFor('pin/add').length).toBe(1);
	});

	it('every node failing is NOT a success', async () => {
		const a = mockNode('https://a.test');
		const b = mockNode('https://b.test');
		a.on('pin/add', {status: 500, text: 'boom'});
		b.on('pin/add', {status: 500, text: 'boom'});
		const result = await pinExternal({
			targets: [targetWith(a, 'token-a'), targetWith(b, 'token-b')],
			cid: EXTERNAL_CID,
			name: 'archive',
		});
		expect(result.success).toBe(false);
		expect(result.ok.length).toBe(0);
		expect(result.failed.length).toBe(2);
	});
});

describe('site remove — the EXISTING verb unpins a pin-added site', () => {
	it('removes the MFS entry AND pin/rm the externally-pinned CID', async () => {
		const a = mockNode('https://node-a.test');
		await pinExternal({
			targets: [targetWith(a, 'token-a')],
			cid: EXTERNAL_CID,
			name: 'archive',
		});

		const client = new KuboRpcClient({
			baseUrl: a.baseUrl,
			token: 'token-a',
			fetchImpl: a.fetchImpl,
		});
		const removed = await removeSite({client, id: 'archive'});

		// The same MFS entry + the same pin the `pin` verb created: one removal
		// verb covers both deployed and pin-added sites.
		expect(removed.cid).toBe(EXTERNAL_CID);
		expect(removed.unpinned).toBe(true);
		const rm = a.requestsFor('files/rm');
		expect(rm[rm.length - 1].query.get('arg')).toBe('/sites/archive');
		const unpin = a.requestsFor('pin/rm');
		expect(unpin.length).toBe(1);
		expect(unpin[0].query.get('arg')).toBe(EXTERNAL_CID);
	});
});
