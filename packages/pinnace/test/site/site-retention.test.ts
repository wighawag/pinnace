import {describe, it, expect} from 'vitest';
import {KuboRpcClient} from '../../src/rpc/kubo-rpc-client.js';
import {MockKuboApi} from '../../src/rpc/mock-kubo.js';
import {
	nextHistory,
	prunePins,
	collectProtectedCids,
} from '../../src/site/site-retention.js';
import {placeInMfs} from '../../src/site/site-management.js';
import {parseSiteMetadata} from '../../src/site/site-wrapper.js';

/**
 * Retention: remembering superseded builds (automatic) and forgetting them
 * (opt-in). The invariants worth holding down are the ones whose failure is
 * silent and expensive:
 *
 *  - a superseded cid is REMEMBERED, or it becomes an orphan pin nothing can
 *    see again,
 *  - nothing is unpinned unless the site states a `keep`, because pinnace cannot
 *    read an ENS record and so can never prove an old cid is unreferenced,
 *  - nothing is unpinned that another site still resolves to (Kubo's pins are
 *    not reference-counted, and sites SHARE cids after a promotion),
 *  - a cid leaves `history` only once it is actually unpinned, so a failed
 *    unpin is retried rather than forgotten while still on disk.
 */

function clientWith(mock: MockKuboApi): KuboRpcClient {
	return new KuboRpcClient({
		baseUrl: mock.baseUrl,
		token: 'token',
		fetchImpl: mock.fetchImpl,
	});
}

/** A node whose `/sites` holds the given id -> current content cid mapping. */
function nodeWithSites(sites: Record<string, string>): MockKuboApi {
	const mock = new MockKuboApi();
	mock.on('files/ls', {
		json: {Entries: Object.keys(sites).map((Name) => ({Name}))},
	});
	for (const [id, cid] of Object.entries(sites)) {
		mock.onArg('files/stat', `/sites/${id}/content`, {json: {Hash: cid}});
	}
	return mock;
}

describe('nextHistory: what a placement remembers', () => {
	it('prepends the superseded cid, newest first', () => {
		expect(nextHistory(['bafyOld'], 'bafyPrev', 'bafyNew')).toEqual([
			'bafyPrev',
			'bafyOld',
		]);
	});

	it('records nothing when the same cid is re-placed (it superseded nothing)', () => {
		expect(nextHistory(['bafyOld'], 'bafySame', 'bafySame')).toEqual([
			'bafyOld',
		]);
	});

	it('starts a history on a first write (nothing was there before)', () => {
		expect(nextHistory(undefined, undefined, 'bafyNew')).toEqual([]);
	});

	it('takes a ROLLED-BACK cid out of history (it is current again)', () => {
		// Rolling back to bafyA: it must not stay listed as superseded, or a later
		// prune would unpin the cid the site is currently serving.
		expect(nextHistory(['bafyA', 'bafyB'], 'bafyC', 'bafyA')).toEqual([
			'bafyC',
			'bafyB',
		]);
	});

	it('never duplicates an entry', () => {
		expect(nextHistory(['bafyPrev', 'bafyOld'], 'bafyPrev', 'bafyNew')).toEqual(
			['bafyPrev', 'bafyOld'],
		);
	});
});

describe('prunePins: forgetting is opt-in, and guarded', () => {
	it('unpins NOTHING when the site states no keep policy', async () => {
		const mock = nodeWithSites({live: 'bafyLive'});
		const result = await prunePins({
			client: clientWith(mock),
			sitesDir: '/sites',
			history: ['bafy1', 'bafy2', 'bafy3'],
			apply: true,
		});
		expect(result.pruned).toEqual([]);
		expect(result.history).toEqual(['bafy1', 'bafy2', 'bafy3']);
		expect(mock.requestsFor('pin/rm')).toEqual([]);
		// It does not even LOOK at the node: no policy, no work.
		expect(mock.requests).toEqual([]);
	});

	it('keeps the newest N and unpins the rest', async () => {
		const mock = nodeWithSites({live: 'bafyLive'});
		const result = await prunePins({
			client: clientWith(mock),
			sitesDir: '/sites',
			history: ['bafy1', 'bafy2', 'bafy3', 'bafy4'],
			keep: 2,
			apply: true,
		});
		expect(mock.requestsFor('pin/rm').map((r) => r.query.get('arg'))).toEqual([
			'bafy3',
			'bafy4',
		]);
		expect(result.history).toEqual(['bafy1', 'bafy2']);
		expect(result.pruned.map((p) => p.outcome)).toEqual([
			'unpinned',
			'unpinned',
		]);
	});

	it('keep 0 is meaningful: every superseded build goes', async () => {
		const mock = nodeWithSites({live: 'bafyLive'});
		const result = await prunePins({
			client: clientWith(mock),
			sitesDir: '/sites',
			history: ['bafy1'],
			keep: 0,
			apply: true,
		});
		expect(mock.requestsFor('pin/rm').length).toBe(1);
		expect(result.history).toEqual([]);
	});

	it('NEVER unpins a cid another site currently resolves to', async () => {
		// The shape a promotion leaves behind: staging and live hold the same cid,
		// and it is also in staging's history from an earlier build.
		const mock = nodeWithSites({
			'mysite.eth': 'bafyPromoted',
			'mysite-staging': 'bafyNewest',
		});
		const result = await prunePins({
			client: clientWith(mock),
			sitesDir: '/sites',
			history: ['bafyPromoted', 'bafyStale'],
			keep: 0,
			apply: true,
		});
		// Kubo's pins are not reference-counted, so unpinning bafyPromoted here
		// would take the LIVE site's content with it.
		expect(mock.requestsFor('pin/rm').map((r) => r.query.get('arg'))).toEqual([
			'bafyStale',
		]);
		expect(result.pruned).toEqual([
			{cid: 'bafyPromoted', outcome: 'protected'},
			{cid: 'bafyStale', outcome: 'unpinned'},
		]);
		// The protected cid stays ACCOUNTABLE: it is still held, so it stays listed.
		expect(result.history).toEqual(['bafyPromoted']);
	});

	it('keeps a FAILED unpin in history, so the next prune retries it', async () => {
		const mock = nodeWithSites({live: 'bafyLive'});
		mock.on('pin/rm', {status: 500, text: 'pin/rm: not pinned'});
		const result = await prunePins({
			client: clientWith(mock),
			sitesDir: '/sites',
			history: ['bafyStale'],
			keep: 0,
			apply: true,
		});
		expect(result.pruned[0].outcome).toBe('failed');
		expect(result.pruned[0].error).toContain('500');
		expect(result.history).toEqual(['bafyStale']);
	});

	it('dry run decides everything and changes nothing', async () => {
		const mock = nodeWithSites({'mysite.eth': 'bafyPromoted'});
		const result = await prunePins({
			client: clientWith(mock),
			sitesDir: '/sites',
			history: ['bafyPromoted', 'bafyStale'],
			keep: 0,
			apply: false,
		});
		// The guard still runs, so what it reports is what a real run would do.
		expect(result.pruned).toEqual([
			{cid: 'bafyPromoted', outcome: 'protected'},
			{cid: 'bafyStale', outcome: 'unpinned'},
		]);
		expect(mock.requestsFor('pin/rm')).toEqual([]);
		expect(result.history).toEqual(['bafyPromoted', 'bafyStale']);
	});

	it('REFUSES to prune when it cannot list the sites to protect', async () => {
		const mock = new MockKuboApi();
		mock.on('files/ls', {status: 401, text: 'unauthorized'});
		await expect(
			prunePins({
				client: clientWith(mock),
				sitesDir: '/sites',
				history: ['bafyStale'],
				keep: 0,
				apply: true,
			}),
		).rejects.toThrow(/not optional/);
		expect(mock.requestsFor('pin/rm')).toEqual([]);
	});

	it('collectProtectedCids reads every site’s CURRENT content', async () => {
		const mock = nodeWithSites({a: 'bafyA', b: 'bafyB'});
		expect(await collectProtectedCids(clientWith(mock), '/sites')).toEqual(
			new Set(['bafyA', 'bafyB']),
		);
	});
});

describe('placeInMfs: the write path does the bookkeeping', () => {
	/** The metadata JSON a recorded `files/write` carried. */
	function writtenMetadata(mock: MockKuboApi) {
		const part = mock
			.requestsFor('files/write')[0]
			.fileParts?.find((p) => p.field === 'file');
		return parseSiteMetadata(part!.bytes);
	}

	it('remembers the superseded cid in the site’s own metadata', async () => {
		const mock = nodeWithSites({blog: 'bafyPrevious'});
		const result = await placeInMfs(
			clientWith(mock),
			'/sites',
			'blog',
			'bafyNew',
			{mode: 'ipfs'},
		);
		expect(result.previousCid).toBe('bafyPrevious');
		expect(writtenMetadata(mock).history).toEqual(['bafyPrevious']);
		// Remembering is free; forgetting is not: with no keep policy stated,
		// nothing is unpinned.
		expect(mock.requestsFor('pin/rm')).toEqual([]);
	});

	it('applies the site’s stored keep policy as it writes', async () => {
		const mock = nodeWithSites({blog: 'bafyPrevious'});
		await placeInMfs(clientWith(mock), '/sites', 'blog', 'bafyNew', {
			mode: 'ipfs',
			keep: 1,
			history: ['bafyOlder', 'bafyOldest'],
		});
		// history becomes [previous, older, oldest]; keep 1 leaves the newest.
		expect(mock.requestsFor('pin/rm').map((r) => r.query.get('arg'))).toEqual([
			'bafyOlder',
			'bafyOldest',
		]);
		expect(writtenMetadata(mock).history).toEqual(['bafyPrevious']);
	});

	it('records nothing when a node cannot say what it held (best effort)', async () => {
		const mock = new MockKuboApi();
		mock.on('files/stat', {status: 500, text: 'boom'});
		const result = await placeInMfs(
			clientWith(mock),
			'/sites',
			'blog',
			'bafyNew',
			{mode: 'ipfs'},
		);
		// The placement is what must succeed; the accounting is best-effort.
		expect(result.history).toEqual([]);
		expect(mock.requestsFor('files/cp').length).toBe(1);
		expect(writtenMetadata(mock).history).toBeUndefined();
	});
});
