import {describe, it, expect} from 'vitest';
import {KuboRpcClient} from '../../src/rpc/kubo-rpc-client.js';
import {MockKuboApi} from '../../src/rpc/mock-kubo.js';
import {
	statusReport,
	makeStatusOp,
	type GatewayProbe,
	type ProvidersLookup,
} from '../../src/status/status-report.js';
import {discoverSites} from '../../src/node/node-commands.js';

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
				const cid = arg.endsWith('/alice.eth') ? 'bafyalice' : 'bafybob';
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

describe('status core — per-site four-field report shape', () => {
	it('reports id, cid, ipns, announced, gatewayServes per discovered site', async () => {
		const mock = withDistinctCids(mockForStatus());
		const client = clientWith(mock);

		// Fake delegated-routing: our PeerID is a provider for alice's CID only.
		const providers: ProvidersLookup = async (cid) => ({
			Providers:
				cid === 'bafyalice' ? [{ID: 'peer-self'}] : [{ID: 'peer-other'}],
		});
		// Fake cold-gateway probe: alice serves (206), bob is cold (504).
		const gateway: GatewayProbe = async (cid) =>
			cid === 'bafyalice' ? 206 : 504;

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
		expect(alice.announced).toBe(true);
		expect(alice.gatewayHttp).toBe(206);
		expect(alice.gatewayServes).toBe(true);

		const bob = report.sites.find((s) => s.id === 'bob')!;
		expect(bob.cid).toBe('bafybob');
		// bob has NO same-named key -> no IPNS id.
		expect(bob.ipns).toBeUndefined();
		expect(bob.announced).toBe(false);
		expect(bob.gatewayHttp).toBe(504);
		expect(bob.gatewayServes).toBe(false);
	});

	it('passes the site CID (not the name) to BOTH external checks', async () => {
		const mock = withDistinctCids(mockForStatus());
		const client = clientWith(mock);
		const providerCids: string[] = [];
		const gatewayCids: string[] = [];
		const providers: ProvidersLookup = async (cid) => {
			providerCids.push(cid);
			return {Providers: []};
		};
		const gateway: GatewayProbe = async (cid) => {
			gatewayCids.push(cid);
			return 200;
		};
		await statusReport({
			client,
			providersLookup: providers,
			gatewayProbe: gateway,
		});
		expect(providerCids.sort()).toEqual(['bafyalice', 'bafybob']);
		expect(gatewayCids.sort()).toEqual(['bafyalice', 'bafybob']);
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
			expect(report.sites.every((s) => s.gatewayServes === serves)).toBe(true);
		}
	});

	it('an external check that THROWS is reported as a failed check, never thrown', async () => {
		const mock = withDistinctCids(mockForStatus());
		const client = clientWith(mock);
		const report = await statusReport({
			client,
			providersLookup: async () => {
				throw new Error('delegated-routing down');
			},
			gatewayProbe: async () => {
				throw new Error('gateway down');
			},
		});
		expect(report.sites).toHaveLength(2);
		// A failed announce check is `announced=false` (not findable), not a throw.
		expect(report.sites.every((s) => s.announced === false)).toBe(true);
		// A failed gateway probe is `gatewayServes=false`, not a throw.
		expect(report.sites.every((s) => s.gatewayServes === false)).toBe(true);
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
		// Two sites -> exactly two of each external check, through the fakes only.
		expect(providerCalls).toBe(2);
		expect(gatewayCalls).toBe(2);
		// Every Kubo call went to the mock (files/ls, id, key/list, files/stat x2).
		expect(mock.requestsFor('files/ls').length).toBe(1);
		expect(mock.requestsFor('id').length).toBe(1);
		expect(mock.requestsFor('key/list').length).toBe(1);
		expect(mock.requestsFor('files/stat').length).toBe(2);
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
			gatewayProbe: async (cid) => (cid === 'bafyalice' ? 200 : 504),
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
		expect(alice.announced).toBe(true);
		expect(alice.gatewayServes).toBe(true);
	});
});
