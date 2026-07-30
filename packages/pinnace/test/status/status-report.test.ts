import {describe, it, expect, vi, afterEach} from 'vitest';
import {KuboRpcClient} from '../../src/rpc/kubo-rpc-client.js';
import {MockKuboApi, routingGetBody} from '../../src/rpc/mock-kubo.js';
import {
	statusReport,
	makeStatusOp,
	defaultProvidersLookup,
	defaultGatewayProbe,
	type GatewayProbe,
	type GatewayProbeResult,
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
		gatewayProbe: async () => ({status: 504}),
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
	probe: (
		url: string,
	) => number | GatewayProbeResult | Promise<number | GatewayProbeResult>,
) {
	const probed: string[] = [];
	const report = await statusReport({
		client: clientWith(mockWithMetadataCases()),
		sitesDir: '/sites',
		providersLookup: async () => ({Providers: []}),
		gatewayProbe: async (url) => {
			probed.push(url);
			// The seam answers with a RESULT OBJECT (status + headers); a test that
			// only cares about the status may say so with a bare number.
			const answer = await probe(url);
			return typeof answer === 'number' ? {status: answer} : answer;
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

/**
 * The MISMATCH axes: `status` must be able to say "your ENS name is not
 * pointing at this site" and "eth.limo is serving an older CID". Both are read
 * from the headers the eth.limo probe already receives, through the SAME single
 * probe seam (now widened to carry them), so no test touches the network.
 *
 * The live regression: eth.limo answered `x-ipfs-path: /ipns/<SOURCE name>` for
 * a site pinnace publishes under a DIFFERENT name, while serving OUR cid — so
 * every existing indicator was green and the site was one old-publisher outage
 * away from going dark.
 */
describe('status core — eth.limo origin + freshness from the probe headers', () => {
	/** The SOURCE publisher's name, as the live box's header spelled it. */
	const SOURCE_NAME =
		'k51qzi5uqu5dlu1ien9spji7pu49mfw97mn0qv4azugqcvenj0dvzq9bgwp1zc';

	it('reports FOREIGN naming the source name while freshness stays CURRENT (the live box)', async () => {
		const {sites} = await metadataReportProbed((url) =>
			url.endsWith('.limo/')
				? {
						status: 200,
						headers: {
							'x-ipfs-path': `/ipns/${SOURCE_NAME}/`,
							// The mock's sites all stat to `bafysite`, so the roots header
							// IS our current cid: the bytes are ours, the NAME is not.
							'x-ipfs-roots': 'bafysite',
						},
					}
				: {status: 200},
		);
		const alice = sites.find((s) => s.id === 'alice.eth')!;
		// Green on every old indicator...
		expect(alice.ethLimoServes).toEqual({state: 'yes'});
		expect(alice.ethLimoFreshness).toEqual({state: 'current'});
		// ...and the mismatch is finally visible, naming what to fix.
		expect(alice.ethLimoOrigin).toEqual({
			state: 'foreign',
			path: `/ipns/${SOURCE_NAME}`,
		});
	});

	it('reports OURS + STALE naming the served cid when the gateway lags a deploy', async () => {
		const {sites} = await metadataReportProbed((url) =>
			url.endsWith('.limo/')
				? {
						status: 200,
						headers: {
							// alice.eth is ipns-mode with key `k51alice`: the name IS ours.
							'x-ipfs-path': '/ipns/k51alice/',
							'x-ipfs-roots': 'bafyprevious',
						},
					}
				: {status: 200},
		);
		const alice = sites.find((s) => s.id === 'alice.eth')!;
		expect(alice.ethLimoOrigin).toEqual({state: 'ours'});
		// Post-deploy lag is normal: reported, named, and never a red negative.
		expect(alice.ethLimoFreshness).toEqual({
			state: 'stale',
			servedCid: 'bafyprevious',
		});
	});

	it('reports UNKNOWN with a reason on BOTH axes when the headers are missing', async () => {
		const {sites} = await metadataReportProbed(() => ({status: 200}));
		const alice = sites.find((s) => s.id === 'alice.eth')!;
		expect(alice.ethLimoServes).toEqual({state: 'yes'});
		expect(alice.ethLimoOrigin).toEqual({
			state: 'unknown',
			reason: 'no x-ipfs-path header',
		});
		expect(alice.ethLimoFreshness).toEqual({
			state: 'unknown',
			reason: 'no x-ipfs-roots header',
		});
	});

	it('reports UNKNOWN with the PROBE reason on both axes when the probe could not be made', async () => {
		const {sites} = await metadataReportProbed((url) => {
			if (url.endsWith('.limo/')) throw new Error('eth.limo is down');
			return {status: 200};
		});
		const alice = sites.find((s) => s.id === 'alice.eth')!;
		expect(alice.ethLimoOrigin).toEqual({
			state: 'unknown',
			reason: 'eth.limo is down',
		});
		expect(alice.ethLimoFreshness).toEqual({
			state: 'unknown',
			reason: 'eth.limo is down',
		});
	});

	it('reports NOT-APPLICABLE (absent) on both axes for a site that resolves NO ens name', async () => {
		const {sites} = await metadataReportProbed(() => ({
			status: 200,
			headers: {'x-ipfs-path': '/ipfs/bafysite', 'x-ipfs-roots': 'bafysite'},
		}));
		const byId = (id: string) => sites.find((s) => s.id === id)!;
		// `""` opts out and a non-`.eth` id infers nothing: there was no
		// `<name>.limo` to ask about, which is NOT the same as "could not ask".
		for (const id of ['optout.eth', 'bob']) {
			expect(byId(id).ethLimoOrigin).toBeUndefined();
			expect(byId(id).ethLimoFreshness).toBeUndefined();
		}
		// ...while a site that WAS probed carries both verdicts.
		expect(byId('blog').ethLimoOrigin).toBeDefined();
		expect(byId('blog').ethLimoFreshness).toBeDefined();
	});

	it('surfaces an ipns-mode site whose ENS holds an immutable cid as FROZEN', async () => {
		const {sites} = await metadataReportProbed((url) =>
			url.endsWith('.limo/')
				? {
						status: 200,
						headers: {
							// The CURRENT cid, but as an immutable ENS contenthash: it will
							// never follow the next deploy of this ipns-mode site.
							'x-ipfs-path': '/ipfs/bafysite',
							'x-ipfs-roots': 'bafysite',
						},
					}
				: {status: 200},
		);
		const alice = sites.find((s) => s.id === 'alice.eth')!;
		expect(alice.ethLimoFreshness).toEqual({state: 'current'});
		expect(alice.ethLimoOrigin).toEqual({
			state: 'frozen',
			path: '/ipfs/bafysite',
		});
	});

	it('carries both axes into the makeStatusOp payload the dashboard reads', async () => {
		const client = clientWith(mockWithMetadataCases());
		const op = makeStatusOp({
			providersLookup: async () => ({Providers: []}),
			gatewayProbe: async (url) =>
				url.endsWith('.limo/')
					? {
							status: 200,
							headers: {
								'x-ipfs-path': `/ipns/${SOURCE_NAME}`,
								'x-ipfs-roots': 'bafyold',
							},
						}
					: {status: 200},
		});
		const result = await op(
			{client, role: 'publisher', sitesDir: '/sites'},
			await discoverSites(client, '/sites'),
		);
		const byId = (id: string) => result.sites.find((s) => s.id === id)!;
		expect(byId('alice.eth').ethLimoOrigin).toEqual({
			state: 'foreign',
			path: `/ipns/${SOURCE_NAME}`,
		});
		expect(byId('alice.eth').ethLimoFreshness).toEqual({
			state: 'stale',
			servedCid: 'bafyold',
		});
		// A mismatch is NOT a failed check: the CID-side roll-up token is untouched.
		expect(byId('alice.eth').status).toBe('unverified');
		// Nothing to probe -> no keys at all in the payload (JSON stays key-free).
		const bob = JSON.parse(JSON.stringify(byId('bob')));
		expect('ethLimoOrigin' in bob).toBe(false);
		expect('ethLimoFreshness' in bob).toBe(false);
	});
});

describe('status core — the ONE probe seam carries status AND headers', () => {
	it('sends the CID gateway and the eth.limo name through the SAME probe', async () => {
		const {sites, probed} = await metadataReportProbed((url) => ({
			status: url.includes('ipfs.dweb.link') ? 206 : 200,
			headers: {'x-ipfs-path': '/ipfs/bafysite', 'x-ipfs-roots': 'bafysite'},
		}));
		// One CID probe per site, plus the two sites that resolve an ENS name.
		expect(probed.filter((u) => u.includes('ipfs.dweb.link')).length).toBe(4);
		expect(probed.filter((u) => u.endsWith('.limo/')).length).toBe(2);
		// The CID half still reads the status out of the widened result...
		for (const site of sites) {
			expect(site.gatewayHttp).toBe(206);
			expect(site.gatewayServes).toEqual({state: 'yes'});
		}
		// ...and the CID probe's headers are not mistaken for the eth.limo ones:
		// `blog` is ipfs-mode and its ENS serves our own cid, so it reads `ours`.
		expect(sites.find((s) => s.id === 'blog')!.ethLimoOrigin).toEqual({
			state: 'ours',
		});
	});

	it('the DEFAULT probe returns the status AND the response headers, lower-cased', async () => {
		vi.stubGlobal(
			'fetch',
			async () =>
				new Response('a', {
					status: 206,
					headers: {
						'X-Ipfs-Path': '/ipns/k51alice/',
						'X-Ipfs-Roots': 'bafysite',
					},
				}),
		);
		const result = await defaultGatewayProbe('https://alice.eth.limo/');
		vi.unstubAllGlobals();
		expect(result.status).toBe(206);
		expect(result.headers?.['x-ipfs-path']).toBe('/ipns/k51alice/');
		expect(result.headers?.['x-ipfs-roots']).toBe('bafysite');
	});
});

describe('status core — per-site report shape', () => {
	it('reports id, cid, ipns, announced, gatewayServes per discovered site', async () => {
		const mock = withDistinctCids(mockForStatus());
		const client = clientWith(mock);

		// Fake delegated-routing: our PeerID is a provider for alice's CID only.
		const providers: ProvidersLookup = async (cid) => ({
			Providers:
				cid === 'bafyalice' ? [{ID: 'peer-self'}] : [{ID: 'peer-other'}],
		});
		// Fake cold-gateway probe (by URL): alice serves (206), bob is cold (504).
		const gateway: GatewayProbe = async (url) => ({
			status: url.includes('bafyalice') ? 206 : 504,
		});

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
			return {status: 200};
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
				gatewayProbe: async () => ({status: code}),
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
				return {status: 200};
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
			gatewayProbe: checks.gateway ?? (async () => ({status: 504})),
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
		const answered = await reportWith({gateway: async () => ({status: 504})});
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
			gatewayProbe: async (url) => ({
				status: url.includes('bafyalice') ? 200 : 504,
			}),
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
			gatewayProbe: async () => ({status: 200}),
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
			gatewayProbe: async () => ({status: 504}),
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
			gatewayProbe: async () => ({status: 504}),
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

describe('status core — the record SEQUENCE (which record wins)', () => {
	/** Seed a readable record + inspect result on a status mock. */
	function withSequence(mock: MockKuboApi, sequence: number): MockKuboApi {
		return mock
			.on('routing/get', {text: routingGetBody('raw-record')})
			.on('name/inspect', {json: {Entry: {Sequence: sequence}}});
	}

	it('reports the sequence for a site this node holds the key for', async () => {
		const mock = withSequence(withDistinctCids(mockForStatus()), 9);
		const report = await statusReport({
			client: clientWith(mock),
			sitesDir: '/sites',
			providersLookup: async () => ({Providers: []}),
			gatewayProbe: async () => ({status: 200}),
		});
		const alice = report.sites.find((s) => s.id === 'alice.eth')!;
		expect(alice.sequence).toEqual({state: 'known', sequence: 9});
	});

	it('leaves the sequence ABSENT (not applicable) for a site with no key here', async () => {
		// bob has no keystore key, so there is no name of OURS to ask about. That
		// is not the same as a check that failed, and must not read as one.
		const mock = withSequence(withDistinctCids(mockForStatus()), 9);
		const report = await statusReport({
			client: clientWith(mock),
			sitesDir: '/sites',
			providersLookup: async () => ({Providers: []}),
			gatewayProbe: async () => ({status: 200}),
		});
		const bob = report.sites.find((s) => s.id === 'bob')!;
		expect(bob.ipns).toBeUndefined();
		expect(bob.sequence).toBeUndefined();
	});

	it('reports UNKNOWN with a reason when the record cannot be read — never 0', async () => {
		// The whole point: a spurious 0 is the failure mode being surfaced, so the
		// REPORT must never manufacture one. routing/get is left unseeded, so the
		// read fails exactly as it would on a node that cannot see the record.
		const mock = withDistinctCids(mockForStatus());
		const report = await statusReport({
			client: clientWith(mock),
			sitesDir: '/sites',
			providersLookup: async () => ({Providers: []}),
			gatewayProbe: async () => ({status: 200}),
		});
		const alice = report.sites.find((s) => s.id === 'alice.eth')!;
		expect(alice.sequence?.state).toBe('unknown');
		expect(alice.sequence).not.toMatchObject({sequence: 0});
	});

	it('a sequence read that fails does not fail the whole report', async () => {
		const mock = withDistinctCids(mockForStatus());
		const report = await statusReport({
			client: clientWith(mock),
			sitesDir: '/sites',
			providersLookup: async () => ({Providers: []}),
			gatewayProbe: async () => ({status: 200}),
		});
		// Every other field still reported for both sites.
		expect(report.sites).toHaveLength(2);
		expect(report.sites.every((s) => s.cid !== '')).toBe(true);
	});

	it('carries the sequence into the status.json payload via makeStatusOp', async () => {
		const mock = withSequence(withDistinctCids(mockForStatus()), 4);
		const client = clientWith(mock);
		const sites = await discoverSites(client, '/sites');
		const op = makeStatusOp({
			providersLookup: async () => ({Providers: []}),
			gatewayProbe: async () => ({status: 200}),
		});
		const result = await op({client, role: 'publisher'}, sites);
		const alice = result.sites.find((s) => s.id === 'alice.eth')!;
		expect(alice.sequence).toEqual({state: 'known', sequence: 4});
		// Absent stays absent in the payload: JSON.stringify drops the key entirely.
		const bob = result.sites.find((s) => s.id === 'bob')!;
		expect(JSON.stringify(bob)).not.toContain('sequence');
	});
});
