import {describe, it, expect} from 'vitest';
import {KuboRpcClient} from '../../src/rpc/kubo-rpc-client.js';
import {MockKuboApi} from '../../src/rpc/mock-kubo.js';
import {
	listSites,
	removeSite,
	addSite,
	type SiteListing,
} from '../../src/site/site-management.js';

/**
 * Site management is a thin vertical slice over the Kubo RPC seam (MFS + pin
 * endpoints). Every test drives it through the recording MockKuboApi (no live
 * daemon, no shared location) and asserts the EXACT calls each verb issues:
 *  - list   reads MFS (files/ls + files/stat) and joins key/list for IPNS ids,
 *  - remove issues files/rm AND unpins (pin/rm) the content,
 *  - add    places /ipfs/<cid> into MFS /sites/<name>.
 */

function clientWith(mock: MockKuboApi, token = 'site-token') {
	return new KuboRpcClient({
		baseUrl: mock.baseUrl,
		token,
		fetchImpl: mock.fetchImpl,
	});
}

/** A mock Kubo API pre-seeded so `/sites/*` discovery yields two sites. */
function mockWithTwoSites(): MockKuboApi {
	const mock = new MockKuboApi();
	mock.on('files/ls', {
		json: {Entries: [{Name: 'alice.eth'}, {Name: 'bob'}]},
	});
	mock.on('files/stat', {json: {Hash: 'bafysite', Type: 'directory'}});
	return mock;
}

describe('site list — enumerate /sites/* with CID and IPNS id', () => {
	it('lists each site with its current CID from MFS', async () => {
		const mock = mockWithTwoSites();
		mock.on('key/list', {json: {Keys: []}});
		const sites = await listSites({client: clientWith(mock)});
		expect(sites.map((s) => s.name)).toEqual(['alice.eth', 'bob']);
		expect(sites.every((s) => s.cid === 'bafysite')).toBe(true);
		// It read MFS: files/ls on /sites, then files/stat per entry.
		const ls = mock.requestsFor('files/ls');
		expect(ls.length).toBe(1);
		expect(ls[0].query.get('arg')).toBe('/sites');
		expect(mock.requestsFor('files/stat').length).toBe(2);
	});

	it('annotates a site with its IPNS id when a same-named key exists', async () => {
		const mock = mockWithTwoSites();
		// alice.eth is ipns-mode (has a key); bob is ipfs-mode (no key).
		mock.on('key/list', {
			json: {Keys: [{Name: 'alice.eth', Id: 'k51alice'}]},
		});
		const sites = await listSites({client: clientWith(mock)});
		const alice = sites.find((s) => s.name === 'alice.eth') as SiteListing;
		const bob = sites.find((s) => s.name === 'bob') as SiteListing;
		expect(alice.ipns).toBe('k51alice');
		expect(bob.ipns).toBeUndefined();
		// It consulted the keystore once to resolve IPNS ids.
		expect(mock.requestsFor('key/list').length).toBe(1);
	});

	it('returns an empty list on a fresh box with no /sites dir', async () => {
		const mock = new MockKuboApi();
		mock.on('files/ls', {status: 500, text: 'no /sites'});
		mock.on('key/list', {json: {Keys: []}});
		const sites = await listSites({client: clientWith(mock)});
		expect(sites).toEqual([]);
	});
});

describe('site remove — files/rm the MFS entry AND unpin the content', () => {
	it('stats the CID, removes the MFS entry, then unpins so storage is reclaimed', async () => {
		const mock = mockWithTwoSites();
		const res = await removeSite({client: clientWith(mock), name: 'bob'});
		expect(res.name).toBe('bob');
		expect(res.cid).toBe('bafysite');
		expect(res.unpinned).toBe(true);

		// It statted the specific site to learn the CID to unpin.
		const stat = mock.requestsFor('files/stat');
		expect(stat.some((r) => r.query.get('arg') === '/sites/bob')).toBe(true);

		// files/rm removed the MFS entry (recursive + force).
		const rm = mock.requestsFor('files/rm');
		expect(rm.length).toBe(1);
		expect(rm[0].query.get('arg')).toBe('/sites/bob');
		expect(rm[0].query.get('recursive')).toBe('true');
		expect(rm[0].query.get('force')).toBe('true');

		// pin/rm unpinned the content by its CID (storage reclaimed).
		const unpin = mock.requestsFor('pin/rm');
		expect(unpin.length).toBe(1);
		expect(unpin[0].query.get('arg')).toBe('bafysite');
	});

	it('removes the MFS entry BEFORE unpinning (entry gone => stops being served/announced)', async () => {
		const mock = mockWithTwoSites();
		await removeSite({client: clientWith(mock), name: 'bob'});
		const order = mock.requests.map((r) => r.path);
		expect(order.indexOf('files/rm')).toBeLessThan(order.indexOf('pin/rm'));
	});

	it('still removes the MFS entry when the content was not pinned (unpin failure is tolerated)', async () => {
		const mock = mockWithTwoSites();
		mock.on('pin/rm', {status: 500, text: 'not pinned'});
		const res = await removeSite({client: clientWith(mock), name: 'bob'});
		// The MFS entry was removed regardless.
		expect(mock.requestsFor('files/rm').length).toBe(1);
		// The unpin was attempted but reported as not-reclaimed, not thrown.
		expect(res.unpinned).toBe(false);
	});
});

describe('site add — place an existing /ipfs/<cid> into MFS /sites/<name>', () => {
	it('mkdir parents, rm old, cp /ipfs/<cid> into /sites/<name>', async () => {
		const mock = new MockKuboApi();
		const res = await addSite({
			client: clientWith(mock),
			name: 'carol.eth',
			cid: 'bafynew',
		});
		expect(res.name).toBe('carol.eth');
		expect(res.cid).toBe('bafynew');

		// mkdir /sites (parents) so a fresh box is fine.
		const mkdir = mock.requestsFor('files/mkdir');
		expect(mkdir.length).toBe(1);
		expect(mkdir[0].query.get('arg')).toBe('/sites');
		expect(mkdir[0].query.get('parents')).toBe('true');

		// rm any existing /sites/<name> (recursive + force) so cp is clean.
		const rm = mock.requestsFor('files/rm');
		expect(rm.length).toBe(1);
		expect(rm[0].query.get('arg')).toBe('/sites/carol.eth');
		expect(rm[0].query.get('recursive')).toBe('true');
		expect(rm[0].query.get('force')).toBe('true');

		// cp /ipfs/<cid> -> /sites/<name>.
		const cp = mock.requestsFor('files/cp');
		expect(cp.length).toBe(1);
		expect(cp[0].query.getAll('arg')).toEqual([
			'/ipfs/bafynew',
			'/sites/carol.eth',
		]);
	});

	it('does NOT import a CAR or pin (add is MFS-placement only, not a deploy)', async () => {
		const mock = new MockKuboApi();
		await addSite({
			client: clientWith(mock),
			name: 'carol.eth',
			cid: 'bafynew',
		});
		expect(mock.requestsFor('dag/import').length).toBe(0);
		expect(mock.requestsFor('pin/add').length).toBe(0);
	});
});
