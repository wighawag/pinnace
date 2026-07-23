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

/** A mock Kubo API pre-seeded so `/sites/*` discovery yields two sites. */
function mockWithTwoSites(): MockKuboApi {
	const mock = new MockKuboApi();
	mock.on('files/ls', {
		json: {Entries: [{Name: 'alice.eth'}, {Name: 'bob'}]},
	});
	// files/stat is single-path; the mock returns the same canned hash for any
	// path, which is fine — the test asserts the CALLS, not distinct CIDs.
	mock.on('files/stat', {json: {Hash: 'bafysite', Type: 'directory'}});
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

describe('site auto-discovery from MFS /sites/*', () => {
	it('lists /sites and stats each entry for its current CID', async () => {
		const mock = mockWithTwoSites();
		const client = clientWith(mock);
		const sites = await discoverSites(client, '/sites');
		expect(sites.map((s) => s.name)).toEqual(['alice.eth', 'bob']);
		expect(sites.every((s) => s.cid === 'bafysite')).toBe(true);
		// It hit files/ls once on /sites, then files/stat per entry.
		const ls = mock.requestsFor('files/ls');
		expect(ls.length).toBe(1);
		expect(ls[0].query.get('arg')).toBe('/sites');
		expect(mock.requestsFor('files/stat').length).toBe(2);
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
			// The re-announced body is the CACHED record bytes.
			expect(puts.some((p) => p.bodyText === 'CACHED-RECORD')).toBe(true);
			// Never signs, even on the fallback path.
			expect(mock.requestsFor('name/publish').length).toBe(0);
			// A site with neither a live publisher NOR a cache is reported, not thrown.
			expect(res.sites.find((s) => s.name === 'bob')?.status).toMatch(
				/no-record|unreachable|skipped/i,
			);
		} finally {
			await rm(dir, {recursive: true, force: true});
		}
	});
});

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
			// alice.eth (an ENS name) is ALSO warmed via eth.limo; bob is not.
			expect(warmed).toContain('https://alice.eth.limo/');
			expect(warmed.some((u) => u.includes('bob.limo'))).toBe(false);
		} finally {
			await rm(dir, {recursive: true, force: true});
		}
	});
});

describe('node status — reuses status-report core logic, writes to the dashboard dir only', () => {
	it('delegates to the injected status op and writes its report under the dashboard dir', async () => {
		const mock = mockWithTwoSites();
		const statusOp: NodeCommandOps['status'] = async () => ({
			sites: [
				{name: 'alice.eth', cid: 'bafysite', ipns: 'k51alice'},
				{name: 'bob', cid: 'bafysite', ipns: ''},
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
			expect(body.sites[0].name).toBe('alice.eth');
		} finally {
			await rm(dir, {recursive: true, force: true});
		}
	});
});
