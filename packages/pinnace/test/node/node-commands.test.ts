import {describe, it, expect} from 'vitest';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {KuboRpcClient} from '../../src/rpc/kubo-rpc-client.js';
import {MockKuboApi} from '../../src/rpc/mock-kubo.js';
import {
	runNodeCommand,
	discoverSites,
	type NodeCommandContext,
	type NodeCommandOps,
} from '../../src/node/node-commands.js';
import {
	encodeSiteMetadata,
	type SiteMetadata,
} from '../../src/site/site-wrapper.js';

/**
 * These tests ISOLATE the on-box world:
 *  - the Kubo daemon is the recording MockKuboApi (no live daemon),
 *  - every on-box path (dashboard/records/cache) is a per-test temp fixture,
 *  - the publisher endpoint and the gateway fetches are injected fakes.
 * No real/global path is ever read or written.
 */

function clientWith(mock: MockKuboApi, token = 'on-box-token') {
	return new KuboRpcClient({
		baseUrl: mock.baseUrl,
		token,
		fetchImpl: mock.fetchImpl,
	});
}

/**
 * A `routing/put` re-announces its record as the `value-file` multipart part
 * (Kubo's contract), so the record bytes live in `fileParts`, not `bodyText`.
 * Decode that part so the mirror tests can assert the exact re-announced bytes.
 */
function putRecordText(req: {
	fileParts?: Array<{field: string; bytes: Uint8Array}>;
}): string | undefined {
	const part = req.fileParts?.find((p) => p.field === 'value-file');
	return part ? Buffer.from(part.bytes).toString('utf8') : undefined;
}

/** A mock Kubo API pre-seeded so `/sites/*` discovery yields two sites. */
function mockWithTwoSites(): MockKuboApi {
	const mock = new MockKuboApi();
	mock.on('files/ls', {
		json: {Entries: [{Name: 'alice.eth'}, {Name: 'bob'}]},
	});
	// files/stat is single-path; the mock returns the same canned hash for any
	// path, which is fine — the test asserts the CALLS, not distinct CIDs.
	mock.on('files/stat', {json: {Hash: 'bafysite', Type: 'directory'}});
	// No metadata.json seeded by default: an unregistered path answers `{}`,
	// which is exactly the empty metadata a site without one discovers as.
	return mock;
}

/** A base context; individual tests override role / ops / paths as needed. */
async function baseContext(
	mock: MockKuboApi,
	overrides: Partial<NodeCommandContext> = {},
): Promise<{ctx: NodeCommandContext; dir: string}> {
	const dir = await mkdtemp(join(tmpdir(), 'pinnace-node-test-'));
	const ctx: NodeCommandContext = {
		client: clientWith(mock),
		role: 'publisher',
		sitesDir: '/sites',
		gateways: ['https://{cid}.ipfs.dweb.link/'],
		publisherEndpoint: 'https://pub.example.test',
		recordsDir: join(dir, 'records'),
		cacheDir: join(dir, 'cache'),
		dashboardDir: join(dir, 'dash'),
		...overrides,
	};
	return {ctx, dir};
}

describe('pinnace node <verb> — namespace + dispatch', () => {
	it('exposes exactly the four on-box verbs', async () => {
		const mock = mockWithTwoSites();
		const {ctx, dir} = await baseContext(mock);
		try {
			for (const verb of ['republish', 'mirror', 'warm', 'status'] as const) {
				const res = await runNodeCommand(verb, ctx);
				expect(res.verb).toBe(verb);
			}
		} finally {
			await rm(dir, {recursive: true, force: true});
		}
	});

	it('rejects an unknown verb (loud, does not silently no-op)', async () => {
		const mock = mockWithTwoSites();
		const {ctx, dir} = await baseContext(mock);
		try {
			await expect(runNodeCommand('frobnicate' as never, ctx)).rejects.toThrow(
				/unknown/i,
			);
		} finally {
			await rm(dir, {recursive: true, force: true});
		}
	});

	it('each verb dispatches to its matching core op (thin wrapper seam)', async () => {
		const mock = mockWithTwoSites();
		const calls: string[] = [];
		const ops: NodeCommandOps = {
			republish: async () => {
				calls.push('republish');
				return {sites: []};
			},
			mirror: async () => {
				calls.push('mirror');
				return {sites: []};
			},
			warm: async () => {
				calls.push('warm');
				return {sites: []};
			},
			status: async () => {
				calls.push('status');
				return {sites: []};
			},
		};
		// republish needs publisher role, mirror needs replica; run each under a
		// role that lets it through so we prove the dispatch, not the gate.
		const {ctx: pubCtx, dir: d1} = await baseContext(mock, {
			role: 'publisher',
			ops,
		});
		const {ctx: repCtx, dir: d2} = await baseContext(mock, {
			role: 'replica',
			ops,
		});
		try {
			await runNodeCommand('republish', pubCtx);
			await runNodeCommand('warm', pubCtx);
			await runNodeCommand('status', pubCtx);
			await runNodeCommand('mirror', repCtx);
			expect(calls).toEqual(['republish', 'warm', 'status', 'mirror']);
		} finally {
			await rm(d1, {recursive: true, force: true});
			await rm(d2, {recursive: true, force: true});
		}
	});
});

describe('pinnace node — role gating (scheduling all timers on every box is safe)', () => {
	it('republish is SKIPPED (no-op, not an error) on a replica', async () => {
		const mock = mockWithTwoSites();
		let ran = false;
		const ops: Partial<NodeCommandOps> = {
			republish: async () => {
				ran = true;
				return {sites: []};
			},
		};
		const {ctx, dir} = await baseContext(mock, {role: 'replica', ops});
		try {
			const res = await runNodeCommand('republish', ctx);
			expect(res.skipped).toBe(true);
			expect(res.skippedReason).toMatch(/role/i);
			expect(ran).toBe(false);
			// A skipped verb touches NO Kubo RPC at all.
			expect(mock.requests.length).toBe(0);
		} finally {
			await rm(dir, {recursive: true, force: true});
		}
	});

	it('mirror is SKIPPED (no-op, not an error) on a publisher', async () => {
		const mock = mockWithTwoSites();
		let ran = false;
		const ops: Partial<NodeCommandOps> = {
			mirror: async () => {
				ran = true;
				return {sites: []};
			},
		};
		const {ctx, dir} = await baseContext(mock, {role: 'publisher', ops});
		try {
			const res = await runNodeCommand('mirror', ctx);
			expect(res.skipped).toBe(true);
			expect(res.skippedReason).toMatch(/role/i);
			expect(ran).toBe(false);
			expect(mock.requests.length).toBe(0);
		} finally {
			await rm(dir, {recursive: true, force: true});
		}
	});

	it('warm and status run under ANY role (role-agnostic)', async () => {
		const mock = mockWithTwoSites();
		for (const role of ['publisher', 'replica'] as const) {
			const {ctx, dir} = await baseContext(mock, {role});
			try {
				const warmRes = await runNodeCommand('warm', ctx);
				const statusRes = await runNodeCommand('status', ctx);
				expect(warmRes.skipped).toBeFalsy();
				expect(statusRes.skipped).toBeFalsy();
			} finally {
				await rm(dir, {recursive: true, force: true});
			}
		}
	});
});

describe('site auto-discovery from MFS /sites/* (wrapper layout)', () => {
	it('lists /sites and stats each entry CONTENT subpath for its current CID', async () => {
		const mock = mockWithTwoSites();
		const client = clientWith(mock);
		const sites = await discoverSites(client, '/sites');
		expect(sites.map((s) => s.id)).toEqual(['alice.eth', 'bob']);
		expect(sites.every((s) => s.cid === 'bafysite')).toBe(true);
		// It hit files/ls once on /sites, then files/stat of each entry's CONTENT
		// subpath — an entry is now a WRAPPER dir, whose own hash is NOT the site's
		// content cid.
		const ls = mock.requestsFor('files/ls');
		expect(ls.length).toBe(1);
		expect(ls[0].query.get('arg')).toBe('/sites');
		expect(
			mock.requestsFor('files/stat').map((r) => r.query.get('arg')),
		).toEqual(['/sites/alice.eth/content', '/sites/bob/content']);
	});

	it('reads each site metadata.json and carries it on the discovered site', async () => {
		const mock = mockWithTwoSites();
		mock.on('files/read', {text: '{"ensName":"warmed.eth","mode":"ipns"}'});
		const sites = await discoverSites(clientWith(mock), '/sites');
		expect(sites.map((s) => s.metadata)).toEqual([
			{ensName: 'warmed.eth', mode: 'ipns'},
			{ensName: 'warmed.eth', mode: 'ipns'},
		]);
		expect(
			mock.requestsFor('files/read').map((r) => r.query.get('arg')),
		).toEqual(['/sites/alice.eth/metadata.json', '/sites/bob/metadata.json']);
	});

	it('tolerates ABSENT metadata: empty metadata, never a discovery failure', async () => {
		const mock = mockWithTwoSites();
		// A site placed before metadata existed (or by an older pinnace): files/read
		// is a loud 500 from Kubo, which discovery must absorb.
		mock.on('files/read', {status: 500, text: 'file does not exist'});
		const sites = await discoverSites(clientWith(mock), '/sites');
		expect(sites.map((s) => s.id)).toEqual(['alice.eth', 'bob']);
		expect(sites.every((s) => s.cid === 'bafysite')).toBe(true);
		expect(sites.map((s) => s.metadata)).toEqual([{}, {}]);
	});

	it('tolerates a FAILING metadata read: the site is still discovered', async () => {
		// Not an absence but an OUTAGE mid-pass (a token that just went stale): the
		// DISCOVERY side deliberately keeps conflating the two, because the on-box
		// warm/republish/status pass must act on every site it CAN see rather than
		// die on one file. Only the destructive WRITE path refuses instead
		// (`readSiteMetadataForWrite`, task
		// `site-metadata-write-path-no-silent-loss`) — this test is the other half
		// of that split, and pins the tolerance in place.
		const mock = mockWithTwoSites();
		mock.on('files/read', {status: 401, text: 'unauthorized'});
		const sites = await discoverSites(clientWith(mock), '/sites');
		expect(sites.map((s) => s.id)).toEqual(['alice.eth', 'bob']);
		expect(sites.map((s) => s.metadata)).toEqual([{}, {}]);
	});

	it('tolerates MALFORMED metadata: empty metadata, never a discovery failure', async () => {
		const mock = mockWithTwoSites();
		mock.on('files/read', {text: 'not json at all'});
		const sites = await discoverSites(clientWith(mock), '/sites');
		expect(sites.map((s) => s.id)).toEqual(['alice.eth', 'bob']);
		expect(sites.map((s) => s.metadata)).toEqual([{}, {}]);
	});
});

describe('node republish (publisher) — default op wiring over the mock Kubo RPC', () => {
	it('for each site: name/publish then routing/get, and EXPORTS the record to the records dir', async () => {
		const mock = mockWithTwoSites();
		mock.on('key/list', {
			json: {
				Keys: [
					{Name: 'alice.eth', Id: 'k51alice'},
					{Name: 'bob', Id: 'k51bob'},
				],
			},
		});
		mock.on('name/publish', {
			json: {Name: 'k51alice', Value: '/ipfs/bafysite'},
		});
		mock.on('routing/get', {text: 'SIGNED-RECORD-BYTES'});
		const {ctx, dir} = await baseContext(mock, {role: 'publisher'});
		try {
			const res = await runNodeCommand('republish', ctx);
			expect(res.skipped).toBeFalsy();
			// Publisher signs+publishes each site it holds a key for.
			expect(mock.requestsFor('name/publish').length).toBe(2);
			const pub = mock.requestsFor('name/publish')[0];
			expect(pub.query.get('lifetime')).toBe('72h');
			expect(pub.query.get('ttl')).toBe('1h');
			// And exports the raw signed record via routing/get.
			expect(mock.requestsFor('routing/get').length).toBe(2);
			// The exported records were written UNDER the temp records dir only.
			const written = await readdir(ctx.recordsDir!);
			expect(written.sort()).toContain('alice.eth.ipns-record');
			const body = await readFile(
				join(ctx.recordsDir!, 'alice.eth.ipns-record'),
				'utf8',
			);
			expect(body).toBe('SIGNED-RECORD-BYTES');
		} finally {
			await rm(dir, {recursive: true, force: true});
		}
	});

	it('publishes ONLY sites the node holds a key for (ipfs-mode sites are skipped)', async () => {
		const mock = mockWithTwoSites();
		// Only alice.eth has a key; bob is ipfs-mode (no key) -> not published.
		mock.on('key/list', {json: {Keys: [{Name: 'alice.eth', Id: 'k51alice'}]}});
		mock.on('name/publish', {json: {Name: 'k51alice'}});
		mock.on('routing/get', {text: 'REC'});
		const {ctx, dir} = await baseContext(mock, {role: 'publisher'});
		try {
			await runNodeCommand('republish', ctx);
			expect(mock.requestsFor('name/publish').length).toBe(1);
			expect(mock.requestsFor('name/publish')[0].query.get('key')).toBe(
				'alice.eth',
			);
		} finally {
			await rm(dir, {recursive: true, force: true});
		}
	});
});

describe('node mirror (replica) — default op wiring: fetch + routing/put + fallback', () => {
	it('fetches the publisher record and re-announces via routing/put (never signs)', async () => {
		const mock = mockWithTwoSites();
		const fetched: string[] = [];
		const publisherFetch = async (url: string) => {
			fetched.push(url);
			// name record + name id endpoints both resolve.
			if (url.endsWith('.ipns-record')) return 'PUB-RECORD';
			return 'k51pubid';
		};
		const {ctx, dir} = await baseContext(mock, {
			role: 'replica',
			publisherFetch,
		});
		try {
			const res = await runNodeCommand('mirror', ctx);
			expect(res.skipped).toBeFalsy();
			// It fetched from the publisher endpoint...
			expect(
				fetched.some((u) => u.startsWith('https://pub.example.test')),
			).toBe(true);
			// ...and re-announced via routing/put, NEVER name/publish (no signing).
			expect(mock.requestsFor('routing/put').length).toBeGreaterThan(0);
			expect(mock.requestsFor('name/publish').length).toBe(0);
		} finally {
			await rm(dir, {recursive: true, force: true});
		}
	});

	it('FALLS BACK to the last cached record when the publisher is unreachable', async () => {
		const mock = mockWithTwoSites();
		// Publisher fetch always throws (endpoint down).
		const publisherFetch = async () => {
			throw new Error('ECONNREFUSED');
		};
		const {ctx, dir} = await baseContext(mock, {
			role: 'replica',
			publisherFetch,
		});
		try {
			// Pre-seed a cached record + id for alice.eth in the cache dir.
			const {mkdir, writeFile} = await import('node:fs/promises');
			await mkdir(ctx.cacheDir!, {recursive: true});
			await writeFile(
				join(ctx.cacheDir!, 'alice.eth.ipns-record'),
				'CACHED-RECORD',
			);
			await writeFile(join(ctx.cacheDir!, 'alice.eth.ipns-name'), 'k51cached');
			const res = await runNodeCommand('mirror', ctx);
			// alice.eth fell back to cache and STILL re-announced.
			const puts = mock.requestsFor('routing/put');
			expect(puts.length).toBeGreaterThan(0);
			// The re-announced record (the `value-file` part) is the CACHED bytes.
			expect(puts.some((p) => putRecordText(p) === 'CACHED-RECORD')).toBe(true);
			// Never signs, even on the fallback path.
			expect(mock.requestsFor('name/publish').length).toBe(0);
			// A site with neither a live publisher NOR a cache is reported, not thrown.
			expect(res.sites.find((s) => s.id === 'bob')?.status).toMatch(
				/no-record|unreachable|skipped/i,
			);
		} finally {
			await rm(dir, {recursive: true, force: true});
		}
	});
});

/**
 * A mock Kubo whose `/sites/*` holds the FOUR ensName cases, each with the
 * metadata that selects it:
 *  - `blog`      -> explicit `named.eth` (an id that is not `.eth` at all),
 *  - `alice.eth` -> NO metadata.json    (infer the name from the id),
 *  - `optout.eth`-> `ensName: ""`       (opt out, despite the `.eth` id),
 *  - `bob`       -> NO metadata.json    (nothing to warm).
 *
 * `files/read` is single-path but the mock answers every path with ONE canned
 * response, so the per-site metadata is seeded by intercepting the base fetch
 * (the same pattern the status tests use for distinct CIDs). A site absent from
 * the map gets Kubo's loud non-2xx for a missing path — i.e. really no
 * `metadata.json`, as a site placed before metadata existed has. The bodies go
 * through the REAL codec, so `""` reaches the warm rule exactly as MFS would
 * hand it over.
 */
function mockWithFourEnsCases(): MockKuboApi {
	const mock = new MockKuboApi();
	mock.on('files/ls', {
		json: {
			Entries: [
				{Name: 'blog'},
				{Name: 'alice.eth'},
				{Name: 'optout.eth'},
				{Name: 'bob'},
			],
		},
	});
	mock.on('files/stat', {json: {Hash: 'bafysite', Type: 'directory'}});
	return withPerSiteMetadata(mock, {
		blog: {ensName: 'named.eth', mode: 'ipfs'},
		'optout.eth': {ensName: '', mode: 'ipfs'},
	});
}

/** Seed `/sites/<id>/metadata.json` per site (see {@link mockWithFourEnsCases}). */
function withPerSiteMetadata(
	mock: MockKuboApi,
	byId: Record<string, SiteMetadata>,
): MockKuboApi {
	const base = mock.fetchImpl;
	Object.defineProperty(mock, 'fetchImpl', {
		value: async (input: string | URL, init?: Parameters<typeof base>[1]) => {
			const url = new URL(typeof input === 'string' ? input : input.toString());
			if (url.pathname.endsWith('/files/read')) {
				const arg = url.searchParams.get('arg') ?? '';
				await base(input, init); // record the call
				const hit = Object.entries(byId).find(
					([id]) => arg === `/sites/${id}/metadata.json`,
				);
				if (!hit) return new Response('file does not exist', {status: 500});
				return new Response(
					Buffer.from(encodeSiteMetadata(hit[1])).toString('utf8'),
					{status: 200},
				);
			}
			return base(input, init);
		},
		writable: true,
	});
	return mock;
}

/**
 * Run `warm` against `mock` with a fake gateway that ANSWERS per URL, returning
 * the per-site outcomes the verb recorded (the honest report of what happened).
 */
async function warmOutcomes(
	mock: MockKuboApi,
	answer: (url: string) => number | Promise<number>,
	overrides: Partial<NodeCommandContext> = {},
) {
	const {ctx, dir} = await baseContext(mock, {
		gatewayFetch: async (url: string) => answer(url),
		...overrides,
	});
	try {
		return (await runNodeCommand('warm', ctx)).sites;
	} finally {
		await rm(dir, {recursive: true, force: true});
	}
}

/** Run `warm` against `mock`, returning every URL the fake gateway was asked for. */
async function warmedUrls(
	mock: MockKuboApi,
	overrides: Partial<NodeCommandContext> = {},
): Promise<string[]> {
	const warmed: string[] = [];
	const {ctx, dir} = await baseContext(mock, {
		gatewayFetch: async (url: string) => {
			warmed.push(url);
			return 200;
		},
		...overrides,
	});
	try {
		await runNodeCommand('warm', ctx);
		return warmed;
	} finally {
		await rm(dir, {recursive: true, force: true});
	}
}

describe('node warm — re-fetch each site CID through configured gateways + eth.limo', () => {
	it('warms each site CID through every configured gateway, and .eth names via eth.limo', async () => {
		const mock = mockWithTwoSites();
		const warmed: string[] = [];
		const gatewayFetch = async (url: string) => {
			warmed.push(url);
			return 200;
		};
		const {ctx, dir} = await baseContext(mock, {
			gateways: ['https://{cid}.ipfs.dweb.link/', 'https://ipfs.io/ipfs/{cid}'],
			gatewayFetch,
		});
		try {
			await runNodeCommand('warm', ctx);
			// Two sites x two gateways = 4 gateway warms, {cid} substituted.
			const gwWarms = warmed.filter((u) => u.includes('bafysite'));
			expect(gwWarms.length).toBe(4);
			expect(warmed).toContain('https://bafysite.ipfs.dweb.link/');
			expect(warmed).toContain('https://ipfs.io/ipfs/bafysite');
			// Neither site has metadata, so alice.eth is ALSO warmed via eth.limo by
			// INFERENCE from its id; bob (not `.eth`) is not. The metadata-driven
			// cases are the describe block below.
			expect(warmed).toContain('https://alice.eth.limo/');
			expect(warmed.some((u) => u.includes('bob.limo'))).toBe(false);
		} finally {
			await rm(dir, {recursive: true, force: true});
		}
	});
});

/**
 * The eth.limo lever is the site's MFS `metadata.ensName`, NOT its id: the box
 * reads the metadata that travels with the site (spec `sites-metadata-in-mfs`),
 * so all four cases are reachable on a real box. The `.eth` id is only the
 * INFERENCE fallback for a site that says nothing.
 */
describe('node warm — eth.limo resolved from metadata.ensName (three-way rule)', () => {
	it('warms the EXPLICIT ensName, for an id that is not `.eth` at all', async () => {
		const warmed = await warmedUrls(mockWithFourEnsCases());
		expect(warmed).toContain('https://named.eth.limo/');
		// The id itself is never warmed when a name is given.
		expect(warmed.some((u) => u.includes('blog.limo'))).toBe(false);
	});

	it('INFERS the name from a `.eth` id when the site has no ensName', async () => {
		const warmed = await warmedUrls(mockWithFourEnsCases());
		expect(warmed).toContain('https://alice.eth.limo/');
	});

	it('`ensName: ""` OPTS OUT — no eth.limo warm even for a `.eth` id', async () => {
		const warmed = await warmedUrls(mockWithFourEnsCases());
		expect(warmed.some((u) => u.includes('optout.eth.limo'))).toBe(false);
		// ...and the opt-out is not a whole-site skip: its CID still gets warmed.
		expect(warmed.filter((u) => u.includes('bafysite')).length).toBe(4);
	});

	it('warms nothing extra for a non-`.eth` id with no ensName', async () => {
		const warmed = await warmedUrls(mockWithFourEnsCases());
		expect(warmed.some((u) => u.includes('bob.limo'))).toBe(false);
		// Exactly TWO of the four sites resolve an ENS name: blog and alice.eth.
		expect(warmed.filter((u) => u.includes('.limo'))).toEqual([
			'https://named.eth.limo/',
			'https://alice.eth.limo/',
		]);
	});

	it('an explicit ensName OVERRIDES a `.eth` id (identity does not decide)', async () => {
		const mock = new MockKuboApi();
		mock.on('files/ls', {json: {Entries: [{Name: 'alice.eth'}]}});
		mock.on('files/stat', {json: {Hash: 'bafysite', Type: 'directory'}});
		const warmed = await warmedUrls(
			withPerSiteMetadata(mock, {'alice.eth': {ensName: 'other.eth'}}),
		);
		expect(warmed).toContain('https://other.eth.limo/');
		expect(warmed.some((u) => u.includes('alice.eth.limo'))).toBe(false);
	});

	it('records a failing warm rather than throwing (a cold gateway is not a run failure)', async () => {
		const asked: string[] = [];
		const {ctx, dir} = await baseContext(mockWithFourEnsCases(), {
			gatewayFetch: async (url: string) => {
				asked.push(url);
				throw new Error('gateway is cold');
			},
		});
		try {
			const res = await runNodeCommand('warm', ctx);
			expect(res.sites.map((s) => s.id)).toEqual([
				'blog',
				'alice.eth',
				'optout.eth',
				'bob',
			]);
			// The failure is RECORDED (that is the whole point of not throwing): a
			// site whose every warm failed must never report `warmed`.
			expect(res.sites.every((s) => s.status === 'warm-failed')).toBe(true);
			// Every URL was still attempted — one failure never short-circuits.
			expect(asked).toContain('https://named.eth.limo/');
			expect(asked).toContain('https://alice.eth.limo/');
		} finally {
			await rm(dir, {recursive: true, force: true});
		}
	});
});

/**
 * `warm` must report what ACTUALLY happened. It still never throws — a cold or
 * broken gateway is recorded, not raised (ADR-0002's best-effort warming) — but
 * the recorded outcome now distinguishes a warm that worked from one that did
 * not, so the on-box loop can tell an operator whether eth.limo warming works.
 */
describe('node warm — the recorded outcome is what actually happened', () => {
	it('reports `warmed` only when every attempted warm succeeded', async () => {
		const sites = await warmOutcomes(mockWithFourEnsCases(), () => 200);
		expect(sites.every((s) => s.status === 'warmed')).toBe(true);
		// The eth.limo half is called out per site: warmed, or not applicable.
		const byId = (id: string) => sites.find((s) => s.id === id)!;
		expect(byId('blog').ethLimoWarmed).toBe(true);
		expect(byId('alice.eth').ethLimoWarmed).toBe(true);
		expect(byId('optout.eth').ethLimoWarmed).toBeUndefined();
		expect(byId('bob').ethLimoWarmed).toBeUndefined();
	});

	it('reports `partly-warmed` when the CID gateways warmed but eth.limo did not', async () => {
		const sites = await warmOutcomes(mockWithFourEnsCases(), (url) =>
			url.endsWith('.limo/') ? 504 : 200,
		);
		const byId = (id: string) => sites.find((s) => s.id === id)!;
		// The interesting case for a `.eth` site: the CID is hot, the URL a human
		// visits is not — and that is now visible.
		expect(byId('alice.eth').status).toBe('partly-warmed');
		expect(byId('alice.eth').ethLimoWarmed).toBe(false);
		expect(byId('blog').status).toBe('partly-warmed');
		// A site with no eth.limo name to warm is unaffected: it warmed fully.
		expect(byId('bob').status).toBe('warmed');
		expect(byId('optout.eth').status).toBe('warmed');
	});

	it('counts a non-2xx answer as a failed warm, not a silent success', async () => {
		const sites = await warmOutcomes(mockWithFourEnsCases(), () => 504);
		// A cold gateway usually ANSWERS (504/404) rather than throwing, so a
		// status-only failure must be recorded exactly like a thrown one.
		expect(sites.every((s) => s.status === 'warm-failed')).toBe(true);
		expect(sites.find((s) => s.id === 'alice.eth')!.ethLimoWarmed).toBe(false);
	});

	it('never throws, whatever the gateway does (the error policy is unchanged)', async () => {
		await expect(
			warmOutcomes(mockWithFourEnsCases(), () => {
				throw new Error('gateway exploded');
			}),
		).resolves.toHaveLength(4);
	});

	it('reports `nothing-to-warm` rather than success for a site it never warmed', async () => {
		// No gateways configured and no ens name to resolve: zero attempts, so
		// `warmed` would claim work that never happened.
		const sites = await warmOutcomes(mockWithFourEnsCases(), () => 200, {
			gateways: [],
		});
		const byId = (id: string) => sites.find((s) => s.id === id)!;
		expect(byId('bob').status).toBe('nothing-to-warm');
		expect(byId('optout.eth').status).toBe('nothing-to-warm');
		// The sites that DO resolve a name still warmed it.
		expect(byId('alice.eth').status).toBe('warmed');
	});
});

describe('node status — reuses status-report core logic, writes to the dashboard dir only', () => {
	it('delegates to the injected status op and writes its report under the dashboard dir', async () => {
		const mock = mockWithTwoSites();
		const statusOp: NodeCommandOps['status'] = async () => ({
			sites: [
				{id: 'alice.eth', cid: 'bafysite', ipns: 'k51alice'},
				{id: 'bob', cid: 'bafysite', ipns: ''},
			],
		});
		const {ctx, dir} = await baseContext(mock, {
			ops: {status: statusOp},
		});
		try {
			const res = await runNodeCommand('status', ctx);
			expect(res.sites.length).toBe(2);
			// The status JSON is written UNDER the temp dashboard dir only.
			const written = await readdir(ctx.dashboardDir!);
			expect(written).toContain('status.json');
			const body = JSON.parse(
				await readFile(join(ctx.dashboardDir!, 'status.json'), 'utf8'),
			);
			expect(body.sites.length).toBe(2);
			expect(body.sites[0].id).toBe('alice.eth');
		} finally {
			await rm(dir, {recursive: true, force: true});
		}
	});

	it('renders index.html NEXT TO status.json, and nowhere else', async () => {
		const mock = mockWithTwoSites();
		const statusOp: NodeCommandOps['status'] = async () => ({
			peerId: '12D3KooWpeerself',
			sites: [
				{
					id: 'alice.eth',
					cid: 'bafyalice',
					ipns: 'k51alice',
					announced: true,
					gatewayServes: true,
				},
				{
					id: 'bob',
					cid: 'bafybob',
					ipns: '',
					announced: false,
					gatewayServes: false,
				},
			],
		});
		const {ctx, dir} = await baseContext(mock, {ops: {status: statusOp}});
		try {
			await runNodeCommand('status', ctx);
			// BOTH outputs, in the dashboard dir: status.json (machine) + index.html
			// (human). Nothing else is written there, and nothing outside it.
			const written = (await readdir(ctx.dashboardDir!)).sort();
			expect(written).toEqual(['index.html', 'status.json']);
			expect(await readdir(dir)).toEqual(['dash']);

			const html = await readFile(
				join(ctx.dashboardDir!, 'index.html'),
				'utf8',
			);
			expect(html.startsWith('<!doctype html>')).toBe(true);
			expect(html).toContain('12D3KooWpeerself');
			expect(html).toContain('href="https://bafyalice.ipfs.dweb.link/"');
			expect(html).toContain('href="https://k51alice.ipns.dweb.link/"');
			expect(html).toContain('<meta http-equiv="refresh"');

			// The HTML shows the SAME `generated` stamp status.json carries (one view
			// of one report, never two clocks).
			const body = JSON.parse(
				await readFile(join(ctx.dashboardDir!, 'status.json'), 'utf8'),
			);
			expect(html).toContain(body.generated);
			// status.json stays the machine payload it was: generated + sites only.
			expect(Object.keys(body).sort()).toEqual(['generated', 'sites']);
		} finally {
			await rm(dir, {recursive: true, force: true});
		}
	});

	it('carries the site metadata into BOTH views, keeping "" distinct from absent', async () => {
		const mock = mockWithTwoSites();
		const statusOp: NodeCommandOps['status'] = async () => ({
			peerId: '12D3KooWpeerself',
			sites: [
				{
					id: 'alice.eth',
					cid: 'bafyalice',
					ipns: 'k51alice',
					mode: 'ipns',
					ensNameToWarm: 'alice.eth',
					// The one site with an eth.limo URL to probe — and it did not serve.
					ethLimoServes: false,
					ethLimoHttp: 504,
				},
				{
					id: 'optout.eth',
					cid: 'bafyoptout',
					ipns: '',
					mode: 'ipfs',
					ensName: '',
				},
				{id: 'bob', cid: 'bafybob', ipns: ''},
			],
		});
		const {ctx, dir} = await baseContext(mock, {ops: {status: statusOp}});
		try {
			await runNodeCommand('status', ctx);
			const body = JSON.parse(
				await readFile(join(ctx.dashboardDir!, 'status.json'), 'utf8'),
			) as {sites: Array<Record<string, unknown>>};
			const byId = (id: string) => body.sites.find((s) => s['id'] === id)!;
			expect(byId('alice.eth')['mode']).toBe('ipns');
			expect(byId('alice.eth')['ensNameToWarm']).toBe('alice.eth');
			// The eth.limo probe verdict reaches the machine payload...
			expect(byId('alice.eth')['ethLimoServes']).toBe(false);
			expect(byId('alice.eth')['ethLimoHttp']).toBe(504);
			// ...and a site with nothing to probe carries no verdict to mistake for
			// a failure.
			expect('ethLimoServes' in byId('optout.eth')).toBe(false);
			// The opt-out survives the JSON round trip as `""`...
			expect(byId('optout.eth')['ensName']).toBe('');
			// ...while a site that stores nothing carries no key at all.
			expect('ensName' in byId('bob')).toBe(false);
			expect('mode' in byId('bob')).toBe(false);

			// The human view shows the same fields (mode + the eth.limo it warms).
			const html = await readFile(
				join(ctx.dashboardDir!, 'index.html'),
				'utf8',
			);
			expect(html).toContain('>ipns<');
			expect(html).toContain('href="https://alice.eth.limo/"');
			expect(html).toContain('opted out');
			// The eth.limo column shows the NAME and whether it serves: alice's row
			// is the only `no` on the page (the other two probed nothing).
			const aliceRow = html.slice(
				html.indexOf('alice.eth'),
				html.indexOf('optout.eth'),
			);
			expect(aliceRow).toContain('>no<');
		} finally {
			await rm(dir, {recursive: true, force: true});
		}
	});

	it('writes neither output when no dashboard dir is configured', async () => {
		const mock = mockWithTwoSites();
		const {ctx, dir} = await baseContext(mock, {dashboardDir: undefined});
		try {
			await runNodeCommand('status', ctx);
			expect(await readdir(dir)).toEqual([]);
		} finally {
			await rm(dir, {recursive: true, force: true});
		}
	});
});
