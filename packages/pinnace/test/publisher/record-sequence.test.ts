import {describe, it, expect} from 'vitest';
import {
	mkdtemp,
	mkdir,
	readFile,
	readdir,
	writeFile,
	rm,
} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {KuboRpcClient} from '../../src/rpc/kubo-rpc-client.js';
import {MockKuboApi, routingGetBody} from '../../src/rpc/mock-kubo.js';

/** The publisher-record seam carries BYTES (binary protobuf), never a string. */
const bytes = (s: string) => new TextEncoder().encode(s);

import type {
	DiscoveredSite,
	NodeCommandContext,
} from '../../src/node/node-commands.js';
import {
	republishAndExport,
	mirrorAndReannounce,
	makeRepublishOp,
	makeMirrorOp,
	RECORD_LIFETIME,
	RECORD_TTL,
} from '../../src/publisher/record-sequence.js';

/**
 * These tests ISOLATE the publisher/replica RECORD SEQUENCE at the mock Kubo
 * RPC boundary + a fake publisher endpoint:
 *  - the Kubo daemon is the recording MockKuboApi (no live daemon),
 *  - the publisher's exported-record endpoint is an injected fake fetch,
 *  - every on-box path (records / cache) is a per-test temp fixture.
 * They pin the full SEQUENCE (export -> fetch -> routing/put -> fallback-to-
 * cache) and the load-bearing invariant that a REPLICA NEVER SIGNS.
 */

/**
 * The record bytes of a `routing/put` now travel as the `value-file` multipart
 * part (Kubo's contract; see kubo-rpc-client.test.ts), NOT as a raw body, so
 * they land in `fileParts` rather than `bodyText`. Decode that part back to
 * text so the sequence tests can assert the exact record bytes re-announced.
 */
function putRecordText(req: {
	fileParts?: Array<{field: string; bytes: Uint8Array}>;
}): string | undefined {
	const part = req.fileParts?.find((p) => p.field === 'value-file');
	return part ? Buffer.from(part.bytes).toString('utf8') : undefined;
}

function clientWith(mock: MockKuboApi, token = 'on-box-token'): KuboRpcClient {
	return new KuboRpcClient({
		baseUrl: mock.baseUrl,
		token,
		fetchImpl: mock.fetchImpl,
	});
}

const SITES: DiscoveredSite[] = [
	{id: 'alice.eth', cid: 'bafyalice', metadata: {mode: 'ipns'}},
	{id: 'bob', cid: 'bafybob', metadata: {}},
];

/** A publisher mock that resolves keys, publish, and a routing/get export. */
function publisherMock(): MockKuboApi {
	return new MockKuboApi()
		.on('key/list', {
			json: {
				Keys: [
					{Name: 'alice.eth', Id: 'k51alice'},
					{Name: 'bob', Id: 'k51bob'},
				],
			},
		})
		.on('name/publish', {json: {Name: 'k51alice', Value: '/ipfs/bafyalice'}})
		.on('routing/get', {text: routingGetBody('SIGNED-RECORD-BYTES')});
}

async function tempCtx(
	mock: MockKuboApi,
	overrides: Partial<NodeCommandContext> = {},
): Promise<{ctx: NodeCommandContext; dir: string}> {
	const dir = await mkdtemp(join(tmpdir(), 'pinnace-record-seq-'));
	const ctx: NodeCommandContext = {
		client: clientWith(mock),
		role: 'publisher',
		sitesDir: '/sites',
		publisherEndpoint: 'https://pub.example.test',
		recordsDir: join(dir, 'records'),
		cacheDir: join(dir, 'cache'),
		...overrides,
	};
	return {ctx, dir};
}

describe('republishAndExport (publisher) — exactly one signer, exports the raw record', () => {
	it('for each site the node holds a key for: name/publish (72h) then routing/get export', async () => {
		const mock = publisherMock();
		const {ctx, dir} = await tempCtx(mock, {role: 'publisher'});
		try {
			const res = await republishAndExport(ctx, SITES);
			// It refreshed the record for BOTH keyed sites, ~72h validity, ~1h ttl.
			const pubs = mock.requestsFor('name/publish');
			expect(pubs.length).toBe(2);
			expect(pubs[0].query.get('lifetime')).toBe(RECORD_LIFETIME);
			expect(pubs[0].query.get('ttl')).toBe(RECORD_TTL);
			expect(RECORD_LIFETIME).toBe('72h');
			// It EXPORTED the raw signed record via routing/get (one per keyed site).
			expect(mock.requestsFor('routing/get').length).toBe(2);
			// The exported record + its ipns id were written UNDER the temp records
			// dir only (no global/shared location touched).
			const written = (await readdir(ctx.recordsDir!)).sort();
			expect(written).toContain('alice.eth.ipns-record');
			expect(written).toContain('alice.eth.ipns-name');
			expect(
				await readFile(join(ctx.recordsDir!, 'alice.eth.ipns-record'), 'utf8'),
			).toBe('SIGNED-RECORD-BYTES');
			expect(
				(
					await readFile(join(ctx.recordsDir!, 'alice.eth.ipns-name'), 'utf8')
				).trim(),
			).toBe('k51alice');
			expect(res.sites.find((s) => s.id === 'alice.eth')?.status).toBe(
				'exported',
			);
		} finally {
			await rm(dir, {recursive: true, force: true});
		}
	});

	it('publishes ONLY sites the node holds a key for (ipfs-mode sites are left alone)', async () => {
		const mock = new MockKuboApi()
			.on('key/list', {json: {Keys: [{Name: 'alice.eth', Id: 'k51alice'}]}})
			.on('name/publish', {json: {Name: 'k51alice'}})
			.on('routing/get', {text: routingGetBody('REC')});
		const {ctx, dir} = await tempCtx(mock, {role: 'publisher'});
		try {
			const res = await republishAndExport(ctx, SITES);
			expect(mock.requestsFor('name/publish').length).toBe(1);
			expect(mock.requestsFor('name/publish')[0].query.get('key')).toBe(
				'alice.eth',
			);
			expect(res.sites.find((s) => s.id === 'bob')?.status).toBe('no-key');
		} finally {
			await rm(dir, {recursive: true, force: true});
		}
	});
});

/**
 * `republish` signs on the site's STORED `mode` (its MFS `metadata.json`), not
 * on a key happening to exist in the keystore: the operator's recorded intent
 * is what the box acts on. The three tiers, all pinned below:
 *   stored `ipfs` -> never publish (its own `ipfs-mode` outcome, NOT `no-key`,
 *                    which would claim a key was missing when one is present),
 *   stored `ipns` -> exactly as before (key -> publish, no key -> `no-key`),
 *   mode ABSENT   -> exactly as before (key presence decides), so a site placed
 *                    before metadata existed keeps republishing.
 */
describe('republishAndExport honours the site stored metadata.mode', () => {
	it('does NOT publish a stored-ipfs site even though the node holds a key for it', async () => {
		const mock = publisherMock(); // holds keys for BOTH sites
		const {ctx, dir} = await tempCtx(mock, {role: 'publisher'});
		try {
			const res = await republishAndExport(ctx, [
				{id: 'alice.eth', cid: 'bafyalice', metadata: {mode: 'ipfs'}},
			]);
			// The key exists, but the site says ipfs: nothing is signed or exported.
			expect(mock.requestsFor('name/publish').length).toBe(0);
			expect(mock.requestsFor('routing/get').length).toBe(0);
			expect(existsSync(ctx.recordsDir!)).toBe(false);
			// A DISTINCT outcome: `no-key` would be a lie (there IS a key).
			expect(res.sites[0].status).toBe('ipfs-mode');
		} finally {
			await rm(dir, {recursive: true, force: true});
		}
	});

	it('publishes a stored-ipns site with a key exactly as before', async () => {
		const mock = publisherMock();
		const {ctx, dir} = await tempCtx(mock, {role: 'publisher'});
		try {
			const res = await republishAndExport(ctx, [
				{id: 'alice.eth', cid: 'bafyalice', metadata: {mode: 'ipns'}},
			]);
			expect(mock.requestsFor('name/publish').length).toBe(1);
			expect(mock.requestsFor('routing/get').length).toBe(1);
			expect(res.sites[0].status).toBe('exported');
		} finally {
			await rm(dir, {recursive: true, force: true});
		}
	});

	it('reports no-key for a stored-ipns site the node holds NO key for', async () => {
		const mock = publisherMock();
		const {ctx, dir} = await tempCtx(mock, {role: 'publisher'});
		try {
			const res = await republishAndExport(ctx, [
				{id: 'keyless.eth', cid: 'bafykeyless', metadata: {mode: 'ipns'}},
			]);
			expect(mock.requestsFor('name/publish').length).toBe(0);
			expect(res.sites[0].status).toBe('no-key');
		} finally {
			await rm(dir, {recursive: true, force: true});
		}
	});

	it('BACK-COMPAT: a site with NO stored mode still republishes on key presence', async () => {
		// The load-bearing tier: an existing live site placed before metadata
		// existed (or by an older pinnace) must not silently stop republishing.
		const mock = publisherMock();
		const {ctx, dir} = await tempCtx(mock, {role: 'publisher'});
		try {
			const res = await republishAndExport(ctx, [
				{id: 'alice.eth', cid: 'bafyalice', metadata: {}},
			]);
			expect(mock.requestsFor('name/publish').length).toBe(1);
			expect(mock.requestsFor('name/publish')[0].query.get('key')).toBe(
				'alice.eth',
			);
			expect(res.sites[0].status).toBe('exported');
		} finally {
			await rm(dir, {recursive: true, force: true});
		}
	});

	it('BACK-COMPAT: a site with NO stored mode and no key is still no-key', async () => {
		const mock = publisherMock();
		const {ctx, dir} = await tempCtx(mock, {role: 'publisher'});
		try {
			const res = await republishAndExport(ctx, [
				{id: 'keyless', cid: 'bafykeyless', metadata: {}},
			]);
			expect(mock.requestsFor('name/publish').length).toBe(0);
			expect(res.sites[0].status).toBe('no-key');
		} finally {
			await rm(dir, {recursive: true, force: true});
		}
	});
});

describe('mirrorAndReannounce (replica) — fetch + routing/put, NEVER signs', () => {
	it('fetches the publisher record and re-announces via routing/put (no name/publish)', async () => {
		const mock = new MockKuboApi();
		const fetched: string[] = [];
		const publisherFetch = async (url: string) => {
			fetched.push(url);
			// BYTES: a signed record is binary, so the seam carries bytes.
			if (url.endsWith('.ipns-record')) return bytes('PUB-RECORD');
			return bytes('k51pubid');
		};
		const {ctx, dir} = await tempCtx(mock, {role: 'replica', publisherFetch});
		try {
			const res = await mirrorAndReannounce(ctx, SITES);
			// It fetched from the publisher endpoint...
			expect(
				fetched.some((u) => u.startsWith('https://pub.example.test/records/')),
			).toBe(true);
			// ...and re-announced via routing/put for each site, NEVER signing.
			expect(mock.requestsFor('routing/put').length).toBe(2);
			expect(mock.requestsFor('name/publish').length).toBe(0);
			// The re-announced record (the `value-file` part) is the fetched bytes.
			expect(
				mock
					.requestsFor('routing/put')
					.every((p) => putRecordText(p) === 'PUB-RECORD'),
			).toBe(true);
			expect(res.sites.every((s) => s.status === 're-announced')).toBe(true);
			// A freshly fetched record is cached so a later outage can fall back.
			expect(
				await readFile(join(ctx.cacheDir!, 'alice.eth.ipns-record'), 'utf8'),
			).toBe('PUB-RECORD');
		} finally {
			await rm(dir, {recursive: true, force: true});
		}
	});

	it('FALLS BACK to the last cached record when the publisher is unreachable, still never signing', async () => {
		const mock = new MockKuboApi();
		const publisherFetch = async () => {
			throw new Error('ECONNREFUSED');
		};
		const {ctx, dir} = await tempCtx(mock, {role: 'replica', publisherFetch});
		try {
			// Pre-seed a cached record + id for alice.eth only.
			await mkdir(ctx.cacheDir!, {recursive: true});
			await writeFile(
				join(ctx.cacheDir!, 'alice.eth.ipns-record'),
				'CACHED-RECORD',
			);
			await writeFile(join(ctx.cacheDir!, 'alice.eth.ipns-name'), 'k51cached');
			const res = await mirrorAndReannounce(ctx, SITES);
			const puts = mock.requestsFor('routing/put');
			// alice.eth fell back to cache and STILL re-announced its cached bytes.
			expect(puts.some((p) => putRecordText(p) === 'CACHED-RECORD')).toBe(true);
			expect(puts.some((p) => p.query.get('arg') === '/ipns/k51cached')).toBe(
				true,
			);
			// Never signs, even on the fallback path.
			expect(mock.requestsFor('name/publish').length).toBe(0);
			expect(res.sites.find((s) => s.id === 'alice.eth')?.status).toBe(
				're-announced-cached',
			);
			// bob has neither a live publisher NOR a cache: reported, not thrown.
			expect(res.sites.find((s) => s.id === 'bob')?.status).toBe('no-record');
		} finally {
			await rm(dir, {recursive: true, force: true});
		}
	});
});

describe('node-command adapters (makeRepublishOp / makeMirrorOp) — same core behind the seam', () => {
	it('makeRepublishOp yields the publisher op that exports via routing/get', async () => {
		const mock = publisherMock();
		const {ctx, dir} = await tempCtx(mock, {role: 'publisher'});
		try {
			const op = makeRepublishOp();
			const res = await op(ctx, SITES);
			expect(mock.requestsFor('routing/get').length).toBe(2);
			expect(res.sites.find((s) => s.id === 'alice.eth')?.status).toBe(
				'exported',
			);
		} finally {
			await rm(dir, {recursive: true, force: true});
		}
	});

	it('makeMirrorOp yields the replica op that routing/puts and never signs', async () => {
		const mock = new MockKuboApi();
		const op = makeMirrorOp();
		const {ctx, dir} = await tempCtx(mock, {
			role: 'replica',
			publisherFetch: async (url) =>
				bytes(url.endsWith('.ipns-record') ? 'PUB-RECORD' : 'k51pubid'),
		});
		try {
			await op(ctx, SITES);
			expect(mock.requestsFor('routing/put').length).toBe(2);
			expect(mock.requestsFor('name/publish').length).toBe(0);
		} finally {
			await rm(dir, {recursive: true, force: true});
		}
	});
});

describe('full sequence: publisher EXPORT -> replica FETCH -> routing/put -> fallback', () => {
	it('a replica mirrors the record the publisher exported, then survives a publisher outage from cache', async () => {
		// 1) Publisher exports a record to a shared records dir.
		const pubMock = publisherMock();
		const {ctx: pubCtx, dir: pubDir} = await tempCtx(pubMock, {
			role: 'publisher',
		});
		// 2) Replica has its own Kubo + cache; it fetches from the publisher's
		//    exported files (served by the fake endpoint reading pubDir/records).
		const repMock = new MockKuboApi();
		const {ctx: repCtx, dir: repDir} = await tempCtx(repMock, {
			role: 'replica',
		});
		try {
			await republishAndExport(pubCtx, SITES);

			// The fake publisher endpoint serves exactly the exported files, as
			// BYTES — like the real Caddy vhost, and unlike a utf8 read, which would
			// silently repair a mangled record and hide the very defect this
			// end-to-end test exists to catch.
			const servePublisher = async (url: string): Promise<Uint8Array> => {
				const file = url.slice(url.lastIndexOf('/') + 1);
				return new Uint8Array(await readFile(join(pubCtx.recordsDir!, file)));
			};
			const liveCtx: NodeCommandContext = {
				...repCtx,
				publisherFetch: servePublisher,
			};
			await mirrorAndReannounce(liveCtx, SITES);
			// The replica re-announced the EXACT bytes the publisher exported.
			const put = repMock.requestsFor('routing/put')[0];
			expect(putRecordText(put)).toBe('SIGNED-RECORD-BYTES');
			expect(put.query.get('arg')).toBe('/ipns/k51alice');
			// It never signed.
			expect(repMock.requestsFor('name/publish').length).toBe(0);

			// 3) Publisher now DOWN: the replica falls back to its cache and still
			//    re-announces, so the name keeps a grace window.
			const downCtx: NodeCommandContext = {
				...repCtx,
				publisherFetch: async () => {
					throw new Error('publisher down');
				},
			};
			const before = repMock.requestsFor('routing/put').length;
			const res = await mirrorAndReannounce(downCtx, SITES);
			expect(repMock.requestsFor('routing/put').length).toBeGreaterThan(before);
			expect(res.sites.find((s) => s.id === 'alice.eth')?.status).toBe(
				're-announced-cached',
			);
			expect(repMock.requestsFor('name/publish').length).toBe(0);
		} finally {
			await rm(pubDir, {recursive: true, force: true});
			await rm(repDir, {recursive: true, force: true});
		}
	});
});

/**
 * The record sequence NEVER grants key material: importing a site key onto the
 * publisher is `authorize` (`../publisher/authorize.ts`, its own tests), which
 * used to live here as `promoteReplicaToPublisher`. Pinned so nobody re-adds a
 * key-provisioning path to this module — or re-adds a "role flip" that persists
 * nothing.
 */
describe('the record sequence grants no key material (authorize owns that)', () => {
	it('never issues key/import on either side of the sequence', async () => {
		const pubMock = publisherMock();
		const {ctx, dir} = await tempCtx(pubMock, {role: 'publisher'});
		try {
			await republishAndExport(ctx, SITES);
			await mirrorAndReannounce(
				{
					...ctx,
					role: 'replica',
					publisherFetch: async (url) =>
						bytes(url.endsWith('.ipns-record') ? 'PUB-RECORD' : 'k51pubid'),
				},
				SITES,
			);
			expect(pubMock.requestsFor('key/import').length).toBe(0);
			expect(pubMock.requestsFor('key/gen').length).toBe(0);
		} finally {
			await rm(dir, {recursive: true, force: true});
		}
	});
});
