import {describe, it, expect, vi, afterEach} from 'vitest';
import {KuboRpcClient} from '../../src/rpc/kubo-rpc-client.js';
import {MockKuboApi} from '../../src/rpc/mock-kubo.js';
import {
	statusReport,
	makeStatusOp,
	defaultProvidersLookup,
	type GatewayProbe,
	type ProvidersLookup,
} from '../../src/status/status-report.js';
import {
	CheckUnavailableError,
	type CheckOutcome,
} from '../../src/status/check-outcome.js';
import {resolveEnsNameToWarm} from '../../src/site/site-wrapper.js';
import {discoverSites} from '../../src/node/node-commands.js';
import {
	encodeSiteMetadata,
	type SiteMetadata,
} from '../../src/site/site-wrapper.js';

/**
 * The `status` core is tested ENTIRELY against fakes:
 *  - the Kubo daemon is the recording MockKuboApi (files/ls, files/stat,
 *    key/list, id) — no live daemon,
 *  - the two EXTERNAL checks (delegated-routing providers lookup, cold public
 *    gateway probe) are injected fakes — no live network.
 * Not one live request leaves the process.
 */

function clientWith(mock: MockKuboApi, token = 'status-token') {
	return new KuboRpcClient({
		baseUrl: mock.baseUrl,
		token,
		fetchImpl: mock.fetchImpl,
	});
}

/**
 * A mock Kubo seeded for status: two sites under /sites (alice.eth, bob), a
 * distinct CID per site, one same-named key (alice.eth) so only alice has an
 * IPNS id, and an `id` returning this node's PeerID.
 */
function mockForStatus(): MockKuboApi {
	const mock = new MockKuboApi();
	mock.on('files/ls', {json: {Entries: [{Name: 'alice.eth'}, {Name: 'bob'}]}});
	mock.on('id', {json: {ID: 'peer-self'}});
	mock.on('key/list', {
		json: {Keys: [{Name: 'alice.eth', Id: 'k51alice'}]},
	});
	return mock;
}

/**
 * files/stat is single-path but the mock returns one canned response for every
 * path. To give each site a DISTINCT CID we intercept the base fetch: alice.eth
 * -> bafyalice, bob -> bafybob. (The mock still records the requests.)
 */
function withDistinctCids(mock: MockKuboApi): MockKuboApi {
	const base = mock.fetchImpl;
	Object.defineProperty(mock, 'fetchImpl', {
		value: async (input: string | URL, init?: Parameters<typeof base>[1]) => {
			const url = new URL(typeof input === 'string' ? input : input.toString());
			if (url.pathname.endsWith('/files/stat')) {
				const arg = url.searchParams.get('arg') ?? '';
				await base(input, init); // record the call
				// The stat targets the wrapper's CONTENT subpath
				// (`/sites/<id>/content`), so match on the id INSIDE the path.
				const cid = arg.includes('/alice.eth/') ? 'bafyalice' : 'bafybob';
				return new Response(JSON.stringify({Hash: cid, Type: 'directory'}), {
					status: 200,
					headers: {'content-type': 'application/json'},
				});
			}
			return base(input, init);
		},
		writable: true,
	});
	return mock;
}

/**
 * Seed `/sites/<id>/metadata.json` per site. `files/read` is single-path but the
 * mock answers every path with ONE canned response, so the per-site metadata is
 * seeded by intercepting the base fetch (the same pattern
 * {@link withDistinctCids} uses for CIDs). A site absent from the map gets
 * Kubo's loud non-2xx for a missing path — i.e. really no `metadata.json`, as a
 * site placed before metadata existed has. The bodies go through the REAL
 * codec, so `""` reaches the report exactly as MFS would hand it over.
 */
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
 * A mock Kubo whose `/sites/*` holds the metadata cases the report must carry
 * through UNFLATTENED:
 *  - `alice.eth`  -> `{mode: 'ipns'}`, ensName ABSENT (the `.eth` inference),
 *  - `blog`       -> an explicit `named.eth` on a non-`.eth` id,
 *  - `optout.eth` -> `ensName: ""`, the opt-out that must stay distinct,
 *  - `bob`        -> NO `metadata.json` at all (an older/plain site).
 */
function mockWithMetadataCases(): MockKuboApi {
	const mock = new MockKuboApi();
	mock.on('files/ls', {
		json: {
			Entries: [
				{Name: 'alice.eth'},
				{Name: 'blog'},
				{Name: 'optout.eth'},
				{Name: 'bob'},
			],
		},
	});
	mock.on('files/stat', {json: {Hash: 'bafysite', Type: 'directory'}});
	mock.on('id', {json: {ID: 'peer-self'}});
	mock.on('key/list', {json: {Keys: [{Name: 'alice.eth', Id: 'k51alice'}]}});
	return withPerSiteMetadata(mock, {
		'alice.eth': {mode: 'ipns'},
		blog: {ensName: 'named.eth', mode: 'ipfs'},
		'optout.eth': {ensName: '', mode: 'ipfs'},
	});
}

/** Build the report over {@link mockWithMetadataCases}, checks stubbed out. */
async function metadataReportSites() {
	const report = await statusReport({
		client: clientWith(mockWithMetadataCases()),
		sitesDir: '/sites',
		providersLookup: async () => ({Providers: []}),
		gatewayProbe: async () => 504,
	});
	return report.sites;
}

/**
 * Build the report over {@link mockWithMetadataCases} with a probe that ANSWERS
 * per URL, returning both the sites and every URL the probe was asked for — the
 * eth.limo probe must go through the SAME injected {@link GatewayProbe} as the
 * CID one, so no test ever reaches the live network.
 */
async function metadataReportProbed(
	probe: (url: string) => number | Promise<number>,
) {
	const probed: string[] = [];
	const report = await statusReport({
		client: clientWith(mockWithMetadataCases()),
		sitesDir: '/sites',
		providersLookup: async () => ({Providers: []}),
		gatewayProbe: async (url) => {
			probed.push(url);
			return probe(url);
		},
	});
	return {sites: report.sites, probed};
}

/**
 * `status` REPORTS what the site's MFS metadata says, so the operator can SEE
 * what the box will do with it: the stored `mode`, the stored `ensName` (all
 * three of its values kept apart), and the eth.limo name the on-box `warm` rule
 * resolves from them — through the SAME `resolveEnsNameToWarm` the loop uses,
 * never a second copy of the rule.
 */
describe('status core — reports the site stored metadata (mode + ensName)', () => {
	it('carries the stored mode and ensName onto each SiteStatus', async () => {
		const sites = await metadataReportSites();
		const alice = sites.find((s) => s.id === 'alice.eth')!;
		expect(alice.mode).toBe('ipns');
		const blog = sites.find((s) => s.id === 'blog')!;
		expect(blog.mode).toBe('ipfs');
		expect(blog.ensName).toBe('named.eth');
	});

	it('keeps ensName "" (opt out) DISTINCT from an ABSENT ensName', async () => {
		const sites = await metadataReportSites();
		// The opt-out is reported as the empty string it is stored as...
		expect(sites.find((s) => s.id === 'optout.eth')!.ensName).toBe('');
		// ...and a site that stores none reports ABSENT, not `''`.
		expect(sites.find((s) => s.id === 'alice.eth')!.ensName).toBeUndefined();
		expect(sites.find((s) => s.id === 'bob')!.ensName).toBeUndefined();
	});

	it('reports a site with NO metadata as storing nothing (mode absent too)', async () => {
		const bob = (await metadataReportSites()).find((s) => s.id === 'bob')!;
		expect(bob.mode).toBeUndefined();
		expect(bob.ensName).toBeUndefined();
		expect(bob.ensNameToWarm).toBeUndefined();
	});

	it('reports the RESOLVED eth.limo target via the three-way warm rule', async () => {
		const sites = await metadataReportSites();
		const byId = (id: string) => sites.find((s) => s.id === id)!;
		// Absent ensName + `.eth` id -> INFERRED.
		expect(byId('alice.eth').ensNameToWarm).toBe('alice.eth');
		// Explicit name on a non-`.eth` id -> that name.
		expect(byId('blog').ensNameToWarm).toBe('named.eth');
		// `""` opts out, even on a `.eth` id.
		expect(byId('optout.eth').ensNameToWarm).toBeUndefined();
		// Absent + non-`.eth` id -> nothing to warm.
		expect(byId('bob').ensNameToWarm).toBeUndefined();
		// The rule is the one the warm loop uses, not a re-implementation.
		expect(byId('alice.eth').ensNameToWarm).toBe(
			resolveEnsNameToWarm('alice.eth', {mode: 'ipns'}),
		);
	});
});

/**
 * `<name>.limo` is the URL a HUMAN visits, so the report must answer whether it
 * SERVES, not merely which name would be warmed. It is probed through the very
 * same injectable {@link GatewayProbe} the CID gateway uses (widened from a cid
 * to a full URL rather than forked into a second probe), and a site that
 * resolves NO name has nothing to probe: that reads as NOT APPLICABLE
 * (`undefined`), never as a failure.
 */
describe('status core — probes the eth.limo URL each site resolves', () => {
	it('probes https://<name>.limo/ for every site with a RESOLVED ens name', async () => {
		const {probed} = await metadataReportProbed(() => 200);
		// Exactly the two sites that resolve a name: the `.eth` id by INFERENCE and
		// the explicit name on a non-`.eth` id.
		expect(probed.filter((u) => u.endsWith('.limo/'))).toEqual([
			'https://alice.eth.limo/',
			'https://named.eth.limo/',
		]);
		// The CID gateway probe is unchanged: still one per site, by URL.
		expect(probed.filter((u) => u.includes('ipfs.dweb.link')).length).toBe(4);
	});

	it('reports the eth.limo probe status and whether it served', async () => {
		const {sites} = await metadataReportProbed((url) =>
			url === 'https://alice.eth.limo/' ? 200 : 504,
		);
		const byId = (id: string) => sites.find((s) => s.id === id)!;
		expect(byId('alice.eth').ethLimoHttp).toBe(200);
		expect(byId('alice.eth').ethLimoServes).toEqual({state: 'yes'});
		// A site whose eth.limo answered but did NOT serve: probed, and a real no.
		expect(byId('blog').ethLimoHttp).toBe(504);
		expect(byId('blog').ethLimoServes).toEqual({state: 'no'});
	});

	it('reports NO resolved name as not-applicable, distinct from a failed probe', async () => {
		const {sites, probed} = await metadataReportProbed(() => 504);
		const byId = (id: string) => sites.find((s) => s.id === id)!;
		// `""` opts out and a non-`.eth` id infers nothing: neither is a FAILURE,
		// so neither reports `false` — there was nothing to probe at all.
		expect(byId('optout.eth').ethLimoServes).toBeUndefined();
		expect(byId('optout.eth').ethLimoHttp).toBeUndefined();
		expect(byId('bob').ethLimoServes).toBeUndefined();
		// ...and a site that WAS probed and failed reads a real `no`, not absent.
		expect(byId('blog').ethLimoServes).toEqual({state: 'no'});
		// Nothing was probed for them (no wasted request, no invented name).
		expect(probed.some((u) => u.includes('optout'))).toBe(false);
		expect(probed.some((u) => u.includes('bob.limo'))).toBe(false);
	});

	it('an eth.limo probe that THROWS is reported, never thrown (report still renders)', async () => {
		const {sites} = await metadataReportProbed((url) => {
			if (url.endsWith('.limo/')) throw new Error('eth.limo is down');
			return 200;
		});
		expect(sites).toHaveLength(4);
		const byId = (id: string) => sites.find((s) => s.id === id)!;
		// The probe could not be MADE: no status, and UNKNOWN (never a `no`, which
		// would claim eth.limo answered and refused to serve).
		expect(byId('alice.eth').ethLimoHttp).toBeUndefined();
		expect(byId('alice.eth').ethLimoServes).toEqual({
			state: 'unknown',
			reason: 'eth.limo is down',
		});
		// The rest of the report is intact, including the CID-gateway half.
		expect(byId('alice.eth').gatewayServes).toEqual({state: 'yes'});
		expect(byId('alice.eth').ensNameToWarm).toBe('alice.eth');
		// A site with nothing to probe is still not-applicable, not false.
		expect(byId('bob').ethLimoServes).toBeUndefined();
	});
});

describe('status core — per-site four-field report shape', () => {
	it('reports id, cid, ipns, announced, gatewayServes per discovered site', async () => {
		const mock = withDistinctCids(mockForStatus());
		const client = clientWith(mock);

		// Fake delegated-routing: our PeerID is a provider for alice's CID only.
		const providers: ProvidersLookup = async (cid) => ({
			Providers:
				cid === 'bafyalice' ? [{ID: 'peer-self'}] : [{ID: 'peer-other'}],
		});
		// Fake cold-gateway probe (by URL): alice serves (206), bob is cold (504).
		const gateway: GatewayProbe = async (url) =>
			url.includes('bafyalice') ? 206 : 504;

		const report = await statusReport({
			client,
			sitesDir: '/sites',
			providersLookup: providers,
			gatewayProbe: gateway,
		});

		expect(report.peerId).toBe('peer-self');
		expect(report.sites).toHaveLength(2);

		const alice = report.sites.find((s) => s.id === 'alice.eth')!;
		expect(alice.cid).toBe('bafyalice');
		expect(alice.ipns).toBe('k51alice');
		expect(alice.announced).toEqual({state: 'yes'});
		expect(alice.gatewayHttp).toBe(206);
		expect(alice.gatewayServes).toEqual({state: 'yes'});

		const bob = report.sites.find((s) => s.id === 'bob')!;
		expect(bob.cid).toBe('bafybob');
		// bob has NO same-named key -> no IPNS id.
		expect(bob.ipns).toBeUndefined();
		// The lookup ANSWERED and our peer was not in it: a real negative.
		expect(bob.announced).toEqual({state: 'no'});
		expect(bob.gatewayHttp).toBe(504);
		// The gateway ANSWERED (504) and did not serve: also a real negative.
		expect(bob.gatewayServes).toEqual({state: 'no'});
	});

	it('passes the site CID to the routing check and its gateway URL to the probe', async () => {
		const mock = withDistinctCids(mockForStatus());
		const client = clientWith(mock);
		const providerCids: string[] = [];
		const gatewayUrls: string[] = [];
		const providers: ProvidersLookup = async (cid) => {
			providerCids.push(cid);
			return {Providers: []};
		};
		const gateway: GatewayProbe = async (url) => {
			gatewayUrls.push(url);
			return 200;
		};
		await statusReport({
			client,
			providersLookup: providers,
			gatewayProbe: gateway,
		});
		expect(providerCids.sort()).toEqual(['bafyalice', 'bafybob']);
		// The probe takes the full URL (the ONE probe both targets go through), so
		// the CID one is the dweb.link subdomain URL, spelled once in the core.
		expect(gatewayUrls).toContain('https://bafyalice.ipfs.dweb.link/');
		expect(gatewayUrls).toContain('https://bafybob.ipfs.dweb.link/');
	});

	it('treats a 2xx/206 gateway status as serving and anything else as not', async () => {
		const mock = withDistinctCids(mockForStatus());
		const client = clientWith(mock);
		const providers: ProvidersLookup = async () => ({Providers: []});
		for (const [code, serves] of [
			[200, true],
			[206, true],
			[301, false],
			[404, false],
			[504, false],
		] as const) {
			const report = await statusReport({
				client,
				providersLookup: providers,
				gatewayProbe: async () => code,
			});
			expect(
				report.sites.every(
					(s) => s.gatewayServes.state === (serves ? 'yes' : 'no'),
				),
			).toBe(true);
		}
	});

	it('never hits the live network: only the injected checks + mock Kubo are used', async () => {
		const mock = withDistinctCids(mockForStatus());
		const client = clientWith(mock);
		let providerCalls = 0;
		let gatewayCalls = 0;
		await statusReport({
			client,
			providersLookup: async () => {
				providerCalls++;
				return {Providers: []};
			},
			gatewayProbe: async () => {
				gatewayCalls++;
				return 200;
			},
		});
		// Two sites -> two routing lookups; the probe additionally covers the ONE
		// eth.limo name that resolves (alice.eth), all through the fakes only.
		expect(providerCalls).toBe(2);
		expect(gatewayCalls).toBe(3);
		// Every Kubo call went to the mock (files/ls, id, key/list, files/stat x2).
		expect(mock.requestsFor('files/ls').length).toBe(1);
		expect(mock.requestsFor('id').length).toBe(1);
		expect(mock.requestsFor('key/list').length).toBe(1);
		expect(mock.requestsFor('files/stat').length).toBe(2);
	});
});

/**
 * The rule this whole module is a worked example of (CONTEXT.md `## Conventions`):
 * a check that could not RUN never reports a definitive negative. A live box
 * reported `announced=false` for a site the delegated router WAS listing — the
 * lookup had failed (rate limiting), and a failed lookup was indistinguishable
 * from a real negative. All three external checks are three-valued now: yes /
 * no / unknown-with-reason.
 */
describe('status core — a check that could NOT run reports unknown, never a negative', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	/** The report over the two-site mock, with both checks supplied. */
	async function reportWith(checks: {
		providers?: ProvidersLookup;
		gateway?: GatewayProbe;
		peerId?: string;
	}) {
		const mock = withDistinctCids(mockForStatus());
		if (checks.peerId !== undefined) {
			mock.on('id', {json: {ID: checks.peerId}});
		}
		return statusReport({
			client: clientWith(mock),
			providersLookup: checks.providers ?? (async () => ({Providers: []})),
			gatewayProbe: checks.gateway ?? (async () => 504),
		});
	}

	it('reports UNKNOWN with the status code when the providers lookup answers non-2xx', async () => {
		// A 429 is the EXPECTED rate-limit case: it says nothing about whether the
		// router lists us, so it must never read as a red cross.
		const report = await reportWith({
			providers: async () => {
				throw new CheckUnavailableError('http 429');
			},
		});
		for (const site of report.sites) {
			expect(site.announced).toEqual({state: 'unknown', reason: 'http 429'});
		}
	});

	it('the DEFAULT lookup turns a non-2xx into a could-not-check, not an empty provider list', async () => {
		// The bug at the root of the live-box report: `if (!res.ok) return
		// {Providers: []}` made a 429 indistinguishable from "the router answered,
		// you are not in it". The fetch is stubbed — no live network.
		vi.stubGlobal(
			'fetch',
			async () => new Response('slow down', {status: 429}),
		);
		await expect(defaultProvidersLookup('bafyalice')).rejects.toBeInstanceOf(
			CheckUnavailableError,
		);
		await expect(defaultProvidersLookup('bafyalice')).rejects.toMatchObject({
			reason: 'http 429',
		});
	});

	it('the DEFAULT lookup still parses a 2xx answer as the providers list', async () => {
		vi.stubGlobal(
			'fetch',
			async () =>
				new Response(JSON.stringify({Providers: [{ID: 'peer-self'}]}), {
					status: 200,
					headers: {'content-type': 'application/json'},
				}),
		);
		await expect(defaultProvidersLookup('bafyalice')).resolves.toEqual({
			Providers: [{ID: 'peer-self'}],
		});
	});

	it('reports UNKNOWN when the providers lookup THROWS (network / DNS / parse)', async () => {
		const report = await reportWith({
			providers: async () => {
				throw new Error('fetch failed');
			},
		});
		for (const site of report.sites) {
			expect(site.announced).toEqual({
				state: 'unknown',
				reason: 'fetch failed',
			});
		}
	});

	it('keeps the TRUE negative: a lookup that ANSWERS without our peer is `no`', async () => {
		const report = await reportWith({
			providers: async () => ({Providers: [{ID: 'peer-other'}]}),
		});
		for (const site of report.sites) {
			expect(site.announced).toEqual({state: 'no'});
		}
	});

	it('reports YES when the lookup CONTAINS our peer (the live box case)', async () => {
		// The delegated router WAS listing this node (third of three providers);
		// the report must say so.
		const report = await reportWith({
			providers: async () => ({
				Providers: [{ID: 'peer-a'}, {ID: 'peer-b'}, {ID: 'peer-self'}],
			}),
		});
		for (const site of report.sites) {
			expect(site.announced).toEqual({state: 'yes'});
		}
	});

	it('reports UNKNOWN when the node PeerID is unavailable (nothing to compare)', async () => {
		let lookups = 0;
		const report = await reportWith({
			peerId: '',
			providers: async () => {
				lookups++;
				return {Providers: [{ID: 'peer-self'}]};
			},
		});
		expect(report.peerId).toBe('');
		for (const site of report.sites) {
			expect(site.announced).toEqual({
				state: 'unknown',
				reason: 'no peer id',
			});
		}
		// We could not identify the node, so there was nothing to ask about.
		expect(lookups).toBe(0);
	});

	it('separates a gateway that could not be PROBED from one that answered and did not serve', async () => {
		const unreachable = await reportWith({
			gateway: async () => {
				throw new Error('gateway down');
			},
		});
		for (const site of unreachable.sites) {
			expect(site.gatewayServes).toEqual({
				state: 'unknown',
				reason: 'gateway down',
			});
			// No status: the probe never got an answer to record.
			expect(site.gatewayHttp).toBeUndefined();
		}
		const answered = await reportWith({gateway: async () => 504});
		for (const site of answered.sites) {
			expect(site.gatewayServes).toEqual({state: 'no'});
			expect(site.gatewayHttp).toBe(504);
		}
	});

	it('keeps eth.limo NOT-APPLICABLE distinct from UNKNOWN (four states)', async () => {
		const {sites} = await metadataReportProbed((url) => {
			if (url === 'https://alice.eth.limo/')
				throw new Error('eth.limo is down');
			if (url.endsWith('.limo/')) return 504;
			return 200;
		});
		const byId = (id: string) => sites.find((s) => s.id === id)!;
		// Probed, could not be reached -> unknown WITH a reason.
		expect(byId('alice.eth').ethLimoServes).toEqual({
			state: 'unknown',
			reason: 'eth.limo is down',
		});
		// Probed, answered, did not serve -> a real no.
		expect(byId('blog').ethLimoServes).toEqual({state: 'no'});
		// NOTHING to probe (`""` opt-out / non-`.eth` id) -> absent, still.
		expect(byId('optout.eth').ethLimoServes).toBeUndefined();
		expect(byId('bob').ethLimoServes).toBeUndefined();
	});

	it('renders the FULL report when every external call fails, and throws nothing', async () => {
		const report = await reportWith({
			providers: async () => {
				throw new Error('delegated-routing down');
			},
			gateway: async () => {
				throw new Error('gateway down');
			},
		});
		expect(report.sites).toHaveLength(2);
		for (const site of report.sites) {
			expect(site.cid).toBeTruthy();
			expect(site.announced.state).toBe('unknown');
			expect(site.gatewayServes.state).toBe('unknown');
		}
		// alice.eth resolves an eth.limo name, so that probe failed too — unknown,
		// never a claim that eth.limo refused to serve.
		const alice = report.sites.find((s) => s.id === 'alice.eth')!;
		expect((alice.ethLimoServes as CheckOutcome).state).toBe('unknown');
	});
});

describe('makeStatusOp — the NodeCommandOps.status adapter', () => {
	it('produces a NodeOpResult carrying the four fields, injectable into node-commands', async () => {
		const mock = withDistinctCids(mockForStatus());
		const client = clientWith(mock);
		const op = makeStatusOp({
			providersLookup: async (cid) => ({
				Providers: cid === 'bafyalice' ? [{ID: 'peer-self'}] : [],
			}),
			gatewayProbe: async (url) => (url.includes('bafyalice') ? 200 : 504),
		});

		const sites = await discoverSites(client, '/sites');
		const result = await op(
			{client, role: 'publisher', sitesDir: '/sites'},
			sites,
		);

		expect(result.sites).toHaveLength(2);
		const alice = result.sites.find((s) => s.id === 'alice.eth')!;
		expect(alice.cid).toBe('bafyalice');
		expect(alice.ipns).toBe('k51alice');
		// The announce + gateway outcomes are carried on the outcome too.
		expect(alice.announced).toEqual({state: 'yes'});
		expect(alice.gatewayServes).toEqual({state: 'yes'});
		// Both checks answered YES, so the site rolls up as verified.
		expect(alice.status).toBe('ok');
	});

	it('rolls an UNKNOWN check up as unverified, never as ok and never as a failure', async () => {
		const mock = withDistinctCids(mockForStatus());
		const client = clientWith(mock);
		const op = makeStatusOp({
			// The announce check could not run; the gateway served.
			providersLookup: async () => {
				throw new CheckUnavailableError('http 429');
			},
			gatewayProbe: async () => 200,
		});
		const sites = await discoverSites(client, '/sites');
		const result = await op(
			{client, role: 'publisher', sitesDir: '/sites'},
			sites,
		);
		for (const site of result.sites) {
			// Not `ok` (we do not know), and the report still came back whole.
			expect(site.status).toBe('unverified');
			expect(site.announced).toEqual({state: 'unknown', reason: 'http 429'});
			expect(site.gatewayServes).toEqual({state: 'yes'});
		}
	});

	it('carries this node PeerID through, so the dashboard header needs no re-fetch', async () => {
		const mock = withDistinctCids(mockForStatus());
		const client = clientWith(mock);
		const op = makeStatusOp({
			providersLookup: async () => ({Providers: []}),
			gatewayProbe: async () => 504,
		});

		const sites = await discoverSites(client, '/sites');
		const result = await op(
			{client, role: 'publisher', sitesDir: '/sites'},
			sites,
		);

		expect(result.peerId).toBe('peer-self');
		// Read ONCE by the report itself; the command layer reuses it.
		expect(mock.requestsFor('id').length).toBe(1);
	});

	it('carries mode, ensName and the resolved eth.limo target into the payload', async () => {
		const client = clientWith(mockWithMetadataCases());
		const op = makeStatusOp({
			providersLookup: async () => ({Providers: []}),
			gatewayProbe: async () => 504,
		});
		const sites = await discoverSites(client, '/sites');
		const result = await op(
			{client, role: 'publisher', sitesDir: '/sites'},
			sites,
		);

		const byId = (id: string) => result.sites.find((s) => s.id === id)!;
		expect(byId('alice.eth').mode).toBe('ipns');
		expect(byId('alice.eth').ensNameToWarm).toBe('alice.eth');
		expect(byId('blog').ensName).toBe('named.eth');
		// The eth.limo probe rides along on the same outcome (the JSON payload the
		// dashboard reads): probed-and-cold is a real `no`...
		expect(byId('alice.eth').ethLimoServes).toEqual({state: 'no'});
		expect(byId('alice.eth').ethLimoHttp).toBe(504);
		// ...while a site with nothing to probe carries no verdict at all.
		expect(byId('bob').ethLimoServes).toBeUndefined();

		// The payload is JSON: `""` must SURVIVE as a key (the opt-out), while an
		// absent ensName must leave no key at all. Unlike `ipns`, which the payload
		// deliberately flattens to `''`, ensName is never coerced.
		const payload = JSON.parse(JSON.stringify(result.sites)) as Array<
			Record<string, unknown>
		>;
		const optout = payload.find((s) => s['id'] === 'optout.eth')!;
		expect(optout['ensName']).toBe('');
		const bob = payload.find((s) => s['id'] === 'bob')!;
		// The three-valued checks survive the JSON round trip, reason and all.
		expect(bob['announced']).toEqual({state: 'no'});
		expect('ensName' in bob).toBe(false);
		expect('mode' in bob).toBe(false);
		expect('ensNameToWarm' in bob).toBe(false);
		// Not-applicable carries NO key either, so a consumer cannot mistake it for
		// a probe that ran and failed.
		expect('ethLimoServes' in bob).toBe(false);
		expect('ethLimoHttp' in bob).toBe(false);
	});
});
