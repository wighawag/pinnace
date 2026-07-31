import {describe, it, expect} from 'vitest';
import {KuboRpcClient} from '../../src/rpc/kubo-rpc-client.js';
import {MockKuboApi} from '../../src/rpc/mock-kubo.js';
import {
	listSites,
	removeSite,
	addSite,
	placeInMfs,
	type SiteListing,
} from '../../src/site/site-management.js';
import {
	parseSiteMetadata,
	SiteMetadataUnreadableError,
	type SiteMetadata,
} from '../../src/site/site-wrapper.js';
import {discoverSites} from '../../src/node/node-commands.js';

/**
 * Site management is a thin vertical slice over the Kubo RPC seam (MFS + pin
 * endpoints). Every test drives it through the recording MockKuboApi (no live
 * daemon, no shared location) and asserts the EXACT calls each verb issues:
 *  - list   reads MFS (files/ls + files/stat of the CONTENT subpath) and joins
 *           key/list for IPNS ids,
 *  - remove issues files/rm of the WRAPPER AND unpins (pin/rm) the CONTENT cid,
 *  - add    places /ipfs/<cid> into MFS /sites/<id>/content and writes the
 *           wrapper's metadata.json.
 *
 * A site in MFS is a WRAPPER dir: `/sites/<id>/content` (the UnixFS root) +
 * `/sites/<id>/metadata.json` (the per-site metadata). Every content-cid read
 * therefore targets the `content` subpath, never the wrapper dir itself (whose
 * hash is the wrapper's, not the site's).
 */

/** The metadata bytes a `files/write` carried (Kubo's multipart `file` part). */
function writtenMetadata(mock: MockKuboApi, index = 0): SiteMetadata {
	const req = mock.requestsFor('files/write')[index];
	const part = req.fileParts?.find((p) => p.field === 'file');
	if (!part) throw new Error('files/write carried no `file` part');
	return parseSiteMetadata(part.bytes);
}

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
		expect(sites.map((s) => s.id)).toEqual(['alice.eth', 'bob']);
		expect(sites.every((s) => s.cid === 'bafysite')).toBe(true);
		// It read MFS: files/ls on /sites, then files/stat of each entry's CONTENT
		// subpath (the wrapper dir's own hash is not the site's cid).
		const ls = mock.requestsFor('files/ls');
		expect(ls.length).toBe(1);
		expect(ls[0].query.get('arg')).toBe('/sites');
		expect(
			mock.requestsFor('files/stat').map((r) => r.query.get('arg')),
		).toEqual(['/sites/alice.eth/content', '/sites/bob/content']);
	});

	it('annotates a site with its IPNS id when a same-named key exists', async () => {
		const mock = mockWithTwoSites();
		// alice.eth is ipns-mode (has a key); bob is ipfs-mode (no key).
		mock.on('key/list', {
			json: {Keys: [{Name: 'alice.eth', Id: 'k51alice'}]},
		});
		const sites = await listSites({client: clientWith(mock)});
		const alice = sites.find((s) => s.id === 'alice.eth') as SiteListing;
		const bob = sites.find((s) => s.id === 'bob') as SiteListing;
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
		const res = await removeSite({client: clientWith(mock), id: 'bob'});
		expect(res.id).toBe('bob');
		expect(res.cid).toBe('bafysite');
		expect(res.unpinned).toBe(true);

		// It statted the site's CONTENT subpath to learn the CID to unpin (the
		// wrapper's own hash would unpin the wrapper, not the site's content).
		const stat = mock.requestsFor('files/stat');
		expect(stat.map((r) => r.query.get('arg'))).toEqual(['/sites/bob/content']);

		// files/rm removed the whole WRAPPER dir (recursive + force).
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
		await removeSite({client: clientWith(mock), id: 'bob'});
		const order = mock.requests.map((r) => r.path);
		expect(order.indexOf('files/rm')).toBeLessThan(order.indexOf('pin/rm'));
	});

	it('still removes the MFS entry when the content was not pinned (unpin failure is tolerated)', async () => {
		const mock = mockWithTwoSites();
		mock.on('pin/rm', {status: 500, text: 'not pinned'});
		const res = await removeSite({client: clientWith(mock), id: 'bob'});
		// The MFS entry was removed regardless.
		expect(mock.requestsFor('files/rm').length).toBe(1);
		// The unpin was attempted but reported as not-reclaimed, not thrown.
		expect(res.unpinned).toBe(false);
	});
});

describe('site add — place an existing /ipfs/<cid> into the MFS wrapper', () => {
	it('mkdir the wrapper (parents), rm old content, cp /ipfs/<cid> into <wrapper>/content', async () => {
		const mock = new MockKuboApi();
		const res = await addSite({
			client: clientWith(mock),
			id: 'carol.eth',
			cid: 'bafynew',
		});
		expect(res.id).toBe('carol.eth');
		expect(res.cid).toBe('bafynew');

		// mkdir /sites/<name> (parents) so a fresh box — with no /sites at all —
		// gets both the sites dir and the site's wrapper.
		const mkdir = mock.requestsFor('files/mkdir');
		expect(mkdir.length).toBe(1);
		expect(mkdir[0].query.get('arg')).toBe('/sites/carol.eth');
		expect(mkdir[0].query.get('parents')).toBe('true');

		// rm any existing CONTENT (recursive + force) so cp is clean — the wrapper
		// (and thus its metadata.json) survives.
		const rm = mock.requestsFor('files/rm');
		expect(rm.length).toBe(1);
		expect(rm[0].query.get('arg')).toBe('/sites/carol.eth/content');
		expect(rm[0].query.get('recursive')).toBe('true');
		expect(rm[0].query.get('force')).toBe('true');

		// cp /ipfs/<cid> -> /sites/<name>/content.
		const cp = mock.requestsFor('files/cp');
		expect(cp.length).toBe(1);
		expect(cp[0].query.getAll('arg')).toEqual([
			'/ipfs/bafynew',
			'/sites/carol.eth/content',
		]);

		// ...and the wrapper's metadata.json was written alongside it.
		const write = mock.requestsFor('files/write');
		expect(write.length).toBe(1);
		expect(write[0].query.get('arg')).toBe('/sites/carol.eth/metadata.json');
		expect(writtenMetadata(mock)).toEqual({mode: 'ipfs'});
	});

	/**
	 * `add` PRESERVES, exactly as its sibling verbs do (task
	 * `site-metadata-write-path-no-silent-loss`). It states nothing about a site's
	 * `ensName` or `mode`, and stating nothing is not a licence to destroy them:
	 * a re-`add` over a live ipns site must not demote it to `ipfs` nor drop the
	 * eth.limo name the operator set. The `ipfs` a FIRST add records is the
	 * DEFAULT mode of a site that stores none, not a mode `add` performed.
	 */
	it('a FIRST add (nothing stored) records {mode: ipfs} with NO ensName key', async () => {
		const mock = new MockKuboApi();
		await addSite({client: clientWith(mock), id: 'carol.eth', cid: 'bafynew'});
		const metadata = writtenMetadata(mock);
		expect(metadata).toEqual({mode: 'ipfs'});
		// Absent, so the on-box warm rule can still INFER from the `.eth` id.
		expect('ensName' in metadata).toBe(false);
	});

	it('re-adding an EXISTING site preserves its stored ensName AND mode', async () => {
		const mock = new MockKuboApi();
		mock.onArg('files/ls', '/sites/carol.eth', {
			json: {Entries: [{Name: 'content'}, {Name: 'metadata.json'}]},
		});
		mock.onArg('files/read', '/sites/carol.eth/metadata.json', {
			text: '{"ensName":"x.eth","mode":"ipns"}',
		});
		await addSite({client: clientWith(mock), id: 'carol.eth', cid: 'bafynew'});
		expect(writtenMetadata(mock)).toEqual({ensName: 'x.eth', mode: 'ipns'});
		// Through the SAME resolver seam deploy/pin use: ONE read, no second pass.
		expect(mock.requestsFor('files/read').length).toBe(1);
	});

	it('preserves the `""` opt-out (never silently re-warms a re-added site)', async () => {
		const mock = new MockKuboApi();
		mock.onArg('files/ls', '/sites/carol.eth', {
			json: {Entries: [{Name: 'metadata.json'}]},
		});
		mock.onArg('files/read', '/sites/carol.eth/metadata.json', {
			text: '{"ensName":"","mode":"ipfs"}',
		});
		await addSite({client: clientWith(mock), id: 'carol.eth', cid: 'bafynew'});
		expect(writtenMetadata(mock).ensName).toBe('');
	});

	it('REFUSES (and writes NOTHING) when the node cannot say what the site stores', async () => {
		const mock = new MockKuboApi();
		mock.on('files/ls', {status: 401, text: 'unauthorized'});
		mock.on('files/read', {status: 401, text: 'unauthorized'});
		const refusal = await addSite({
			client: clientWith(mock),
			id: 'carol.eth',
			cid: 'bafynew',
		}).catch((e: unknown) => e);
		expect(refusal).toBeInstanceOf(SiteMetadataUnreadableError);
		expect((refusal as Error).message).toContain('carol.eth');
		// Nothing was placed: no metadata overwritten, no content swapped.
		expect(mock.requestsFor('files/write').length).toBe(0);
		expect(mock.requestsFor('files/cp').length).toBe(0);
		expect(mock.requestsFor('files/rm').length).toBe(0);
	});

	it('does NOT import a CAR or pin (add is MFS-placement only, not a deploy)', async () => {
		const mock = new MockKuboApi();
		await addSite({
			client: clientWith(mock),
			id: 'carol.eth',
			cid: 'bafynew',
		});
		expect(mock.requestsFor('dag/import').length).toBe(0);
		expect(mock.requestsFor('pin/add').length).toBe(0);
	});
});

describe('placeInMfs — write the wrapper /sites/<id>/{content, metadata.json}', () => {
	it('reads the superseded cid, then mkdir / rm / cp / write, in that order', async () => {
		const mock = new MockKuboApi();
		await placeInMfs(clientWith(mock), '/sites', 'alice.eth', 'bafycontent', {
			ensName: 'alice.eth',
			mode: 'ipns',
		});
		// The leading `files/stat` is the retention bookkeeping: what this site
		// resolved to BEFORE this write, read first because the `cp` replaces it.
		// Without it every re-deploy would leave an orphan pin nothing can see.
		expect(mock.requests.map((r) => r.path)).toEqual([
			'files/stat',
			'files/mkdir',
			'files/rm',
			'files/cp',
			'files/write',
		]);
		expect(mock.requestsFor('files/mkdir')[0].query.get('arg')).toBe(
			'/sites/alice.eth',
		);
		expect(mock.requestsFor('files/rm')[0].query.get('arg')).toBe(
			'/sites/alice.eth/content',
		);
		expect(mock.requestsFor('files/cp')[0].query.getAll('arg')).toEqual([
			'/ipfs/bafycontent',
			'/sites/alice.eth/content',
		]);
		const write = mock.requestsFor('files/write')[0];
		expect(write.query.get('arg')).toBe('/sites/alice.eth/metadata.json');
		expect(writtenMetadata(mock)).toEqual({ensName: 'alice.eth', mode: 'ipns'});
	});

	it('is idempotent: re-placing replaces BOTH the content and the metadata', async () => {
		const mock = new MockKuboApi();
		const client = clientWith(mock);
		await placeInMfs(client, '/sites', 'alice.eth', 'bafyold', {mode: 'ipfs'});
		await placeInMfs(client, '/sites', 'alice.eth', 'bafynew', {
			ensName: 'renamed.eth',
			mode: 'ipns',
		});
		// The second placement cleared the old content and re-copied the new one...
		expect(mock.requestsFor('files/rm').length).toBe(2);
		expect(mock.requestsFor('files/cp')[1].query.getAll('arg')[0]).toBe(
			'/ipfs/bafynew',
		);
		// ...and fully REPLACED the metadata (files/write truncates, per the client).
		expect(writtenMetadata(mock, 0)).toEqual({mode: 'ipfs'});
		expect(writtenMetadata(mock, 1)).toEqual({
			ensName: 'renamed.eth',
			mode: 'ipns',
		});
	});

	it('honours a non-default sites dir', async () => {
		const mock = new MockKuboApi();
		await placeInMfs(clientWith(mock), '/custom', 'bob', 'bafycontent', {
			mode: 'ipfs',
		});
		expect(mock.requestsFor('files/cp')[0].query.getAll('arg')[1]).toBe(
			'/custom/bob/content',
		);
		expect(mock.requestsFor('files/write')[0].query.get('arg')).toBe(
			'/custom/bob/metadata.json',
		);
	});
});

describe('metadata round-trip through MFS (placeInMfs writes, discoverSites reads)', () => {
	/**
	 * The mock holds no state, so the round-trip is closed by hand: feed the
	 * EXACT bytes `placeInMfs` wrote back as the `files/read` response, then let
	 * discovery parse them. That is the real write -> read path a box takes.
	 */
	async function roundTrip(metadata: SiteMetadata): Promise<SiteMetadata> {
		const mock = new MockKuboApi();
		const client = clientWith(mock);
		await placeInMfs(client, '/sites', 'alice.eth', 'bafycontent', metadata);
		const part = mock
			.requestsFor('files/write')[0]
			.fileParts?.find((p) => p.field === 'file');
		mock.on('files/ls', {json: {Entries: [{Name: 'alice.eth'}]}});
		mock.on('files/stat', {json: {Hash: 'bafycontent'}});
		mock.on('files/read', {text: Buffer.from(part!.bytes).toString('utf8')});
		const [site] = await discoverSites(client, '/sites');
		expect(site.cid).toBe('bafycontent');
		return site.metadata;
	}

	it('round-trips {ensName, mode} unchanged', async () => {
		expect(await roundTrip({ensName: 'alice.eth', mode: 'ipns'})).toEqual({
			ensName: 'alice.eth',
			mode: 'ipns',
		});
	});

	it('round-trips ensName: "" (opt out) as DISTINCT from absent (infer)', async () => {
		const optedOut = await roundTrip({ensName: '', mode: 'ipfs'});
		expect(optedOut.ensName).toBe('');
		expect('ensName' in optedOut).toBe(true);

		const inferring = await roundTrip({mode: 'ipfs'});
		expect(inferring.ensName).toBeUndefined();
		expect('ensName' in inferring).toBe(false);
	});
});
