import {describe, it, expect} from 'vitest';
import {
	mkdtemp,
	mkdir,
	readFile,
	readdir,
	writeFile,
	rm,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {KuboRpcClient} from '../../src/rpc/kubo-rpc-client.js';
import {MockKuboApi} from '../../src/rpc/mock-kubo.js';
import {deriveIpnsKey} from '../../src/derive/ipns-key-derivation.js';
import type {
	DiscoveredSite,
	NodeCommandContext,
} from '../../src/node/node-commands.js';
import {
	republishAndExport,
	mirrorAndReannounce,
	makeRepublishOp,
	makeMirrorOp,
	promoteReplicaToPublisher,
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

function clientWith(mock: MockKuboApi, token = 'on-box-token') {
	return new KuboRpcClient({
		baseUrl: mock.baseUrl,
		token,
		fetchImpl: mock.fetchImpl,
	});
}

const SITES: DiscoveredSite[] = [
	{name: 'alice.eth', cid: 'bafyalice'},
	{name: 'bob', cid: 'bafybob'},
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
		.on('routing/get', {text: 'SIGNED-RECORD-BYTES'});
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
			expect(res.sites.find((s) => s.name === 'alice.eth')?.status).toBe(
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
			.on('routing/get', {text: 'REC'});
		const {ctx, dir} = await tempCtx(mock, {role: 'publisher'});
		try {
			const res = await republishAndExport(ctx, SITES);
			expect(mock.requestsFor('name/publish').length).toBe(1);
			expect(mock.requestsFor('name/publish')[0].query.get('key')).toBe(
				'alice.eth',
			);
			expect(res.sites.find((s) => s.name === 'bob')?.status).toBe('no-key');
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
			if (url.endsWith('.ipns-record')) return 'PUB-RECORD';
			return 'k51pubid';
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
			// The re-announced body is the fetched publisher record bytes.
			expect(
				mock
					.requestsFor('routing/put')
					.every((p) => p.bodyText === 'PUB-RECORD'),
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
			expect(puts.some((p) => p.bodyText === 'CACHED-RECORD')).toBe(true);
			expect(puts.some((p) => p.query.get('arg') === '/ipns/k51cached')).toBe(
				true,
			);
			// Never signs, even on the fallback path.
			expect(mock.requestsFor('name/publish').length).toBe(0);
			expect(res.sites.find((s) => s.name === 'alice.eth')?.status).toBe(
				're-announced-cached',
			);
			// bob has neither a live publisher NOR a cache: reported, not thrown.
			expect(res.sites.find((s) => s.name === 'bob')?.status).toBe('no-record');
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
			expect(res.sites.find((s) => s.name === 'alice.eth')?.status).toBe(
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
				url.endsWith('.ipns-record') ? 'PUB-RECORD' : 'k51pubid',
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

			// The fake publisher endpoint serves exactly the exported files.
			const servePublisher = async (url: string): Promise<string> => {
				const file = url.slice(url.lastIndexOf('/') + 1);
				return await readFile(join(pubCtx.recordsDir!, file), 'utf8');
			};
			const liveCtx: NodeCommandContext = {
				...repCtx,
				publisherFetch: servePublisher,
			};
			await mirrorAndReannounce(liveCtx, SITES);
			// The replica re-announced the EXACT bytes the publisher exported.
			const put = repMock.requestsFor('routing/put')[0];
			expect(put.bodyText).toBe('SIGNED-RECORD-BYTES');
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
			expect(res.sites.find((s) => s.name === 'alice.eth')?.status).toBe(
				're-announced-cached',
			);
			expect(repMock.requestsFor('name/publish').length).toBe(0);
		} finally {
			await rm(pubDir, {recursive: true, force: true});
			await rm(repDir, {recursive: true, force: true});
		}
	});
});

describe('promoteReplicaToPublisher (story 14) — import key + flip role, reuses key-import seam', () => {
	const master = 'test-master-secret';
	const keyId = 'mysite';

	it('imports the derived key via key/import and returns the new publisher role within the validity window', async () => {
		const mock = new MockKuboApi().on('key/import', {
			json: {Name: 'alice.eth', Id: 'k51golden'},
		});
		const client = clientWith(mock, 'promote-token');
		const derived = deriveIpnsKey({master, keyId});
		const result = await promoteReplicaToPublisher({
			client,
			currentRole: 'replica',
			keyName: 'alice.eth',
			derived,
		});
		// It imported the key material via key/import (the key-import-publisher seam).
		const imports = mock.requestsFor('key/import');
		expect(imports.length).toBe(1);
		expect(imports[0].query.get('arg')).toBe('alice.eth');
		// The role is flipped to publisher.
		expect(result.role).toBe('publisher');
		expect(result.keyName).toBe('alice.eth');
		// Promotion imports a key; it does NOT itself sign a record (no name/publish
		// here — the promoted node signs on its next republish).
		expect(mock.requestsFor('name/publish').length).toBe(0);
	});

	it('is idempotent-safe on a node already publisher (re-imports the key, stays publisher)', async () => {
		const mock = new MockKuboApi().on('key/import', {
			json: {Name: 'alice.eth'},
		});
		const client = clientWith(mock);
		const result = await promoteReplicaToPublisher({
			client,
			currentRole: 'publisher',
			keyName: 'alice.eth',
			derived: deriveIpnsKey({master, keyId}),
		});
		expect(result.role).toBe('publisher');
		expect(mock.requestsFor('key/import').length).toBe(1);
	});
});
