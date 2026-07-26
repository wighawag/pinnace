import {describe, it, expect} from 'vitest';
import {KuboRpcClient} from '../../src/rpc/kubo-rpc-client.js';
import {MockKuboApi} from '../../src/rpc/mock-kubo.js';
import {deriveIpnsKey} from '../../src/derive/ipns-key-derivation.js';
import {KeyImportRoleError} from '../../src/publisher/key-import.js';
import {
	authorizePublisher,
	AuthorizeSecondSignerError,
} from '../../src/publisher/authorize.js';

/**
 * These tests ISOLATE `authorize` at the mock Kubo RPC boundary (no live
 * daemon, no env, no config file). They pin what the verb actually DOES —
 * grant key MATERIAL to the declared publisher, idempotently — and the two
 * hazards it refuses: a second signer for the same name, and a key landing on
 * a declared replica.
 *
 * NOTHING here asserts a role FLIP: `authorize` persists no role anywhere (a
 * node's role lives in `pinnace.json` `hosts[].role` and in the box's own
 * `NODE_ROLE` cloud-init env, neither of which this verb touches).
 */

const MASTER = 'test-master-secret';

/** The `deriveKey` seam the CLI fills from the env-only master. */
const deriveKey = (id: string) => deriveIpnsKey({master: MASTER, keyId: id});

function clientWith(mock: MockKuboApi, token = 'authorize-token') {
	return new KuboRpcClient({
		baseUrl: mock.baseUrl,
		token,
		fetchImpl: mock.fetchImpl,
	});
}

/** A node holding exactly the named keys (`key/list -l`). */
function nodeHolding(
	keys: Record<string, string>,
	baseUrl = 'https://publisher.example.test',
): MockKuboApi {
	return new MockKuboApi(baseUrl)
		.on('key/list', {
			json: {
				Keys: Object.entries(keys).map(([Name, Id]) => ({Name, Id})),
			},
		})
		.on('key/import', {json: {Name: 'imported', Id: 'k51imported'}});
}

/** Give a node an MFS `/sites` tree with the named sites (for discovery). */
function withSites(mock: MockKuboApi, ids: string[]): MockKuboApi {
	mock.onArg('files/ls', '/sites', {
		json: {Entries: ids.map((Name) => ({Name}))},
	});
	for (const id of ids) {
		mock.onArg('files/stat', `/sites/${id}/content`, {
			json: {Hash: `bafy-${id}`},
		});
	}
	return mock;
}

/** The publisher target every test authorizes against. */
function publisherTarget(mock: MockKuboApi, name = 'pub') {
	return {name, client: clientWith(mock), role: 'publisher' as const};
}

describe('authorize <id> — grants key MATERIAL to the declared publisher', () => {
	it('imports the derived key when the publisher holds none, reporting `authorized` + the ipns id', async () => {
		const mock = nodeHolding({});
		const result = await authorizePublisher({
			publisher: publisherTarget(mock),
			ids: ['mysite'],
			deriveKey,
		});

		const imports = mock.requestsFor('key/import');
		expect(imports.length).toBe(1);
		expect(imports[0].query.get('arg')).toBe('mysite');
		expect(result.sites).toEqual([
			{id: 'mysite', ipns: 'k51imported', status: 'authorized'},
		]);
		// It grants MATERIAL only: nothing signs, nothing re-announces.
		expect(mock.requestsFor('name/publish').length).toBe(0);
		expect(mock.requestsFor('routing/put').length).toBe(0);
	});

	it('is IDEMPOTENT: a key already held is a clean no-op with NO key/import', async () => {
		const mock = nodeHolding({mysite: 'k51held'});
		const result = await authorizePublisher({
			publisher: publisherTarget(mock),
			ids: ['mysite'],
			deriveKey,
		});

		expect(mock.requestsFor('key/import').length).toBe(0);
		expect(result.sites).toEqual([
			{id: 'mysite', ipns: 'k51held', status: 'already-authorized'},
		]);
	});

	it('works for a site that does NOT exist in MFS yet (the pre-deploy CI bootstrap)', async () => {
		// No /sites tree is modelled at all, and none is consulted: naming an id
		// authorizes it outright, so a key can be pre-authorized before deploy 1.
		const mock = nodeHolding({});
		const result = await authorizePublisher({
			publisher: publisherTarget(mock),
			ids: ['not-deployed-yet'],
			deriveKey,
		});

		expect(result.sites[0].status).toBe('authorized');
		expect(mock.requestsFor('files/ls').length).toBe(0);
	});

	it('imports the key DERIVED from the master (never a key/gen on the box)', async () => {
		const mock = nodeHolding({});
		await authorizePublisher({
			publisher: publisherTarget(mock),
			ids: ['mysite'],
			deriveKey,
		});

		expect(mock.requestsFor('key/gen').length).toBe(0);
		const part = mock
			.requestsFor('key/import')[0]
			.fileParts?.find((p) => p.field === 'file');
		const derived = deriveKey('mysite');
		expect(part?.bytes.slice(4, 36)).toEqual(derived.seed);
	});
});

describe('bare authorize — every site the publisher holds in MFS', () => {
	it('discovers /sites/* and reports per-site authorized / already-authorized', async () => {
		const mock = withSites(nodeHolding({old: 'k51old'}), ['old', 'fresh']);
		const result = await authorizePublisher({
			publisher: publisherTarget(mock),
			deriveKey,
		});

		expect(result.sites).toEqual([
			{id: 'old', ipns: 'k51old', status: 'already-authorized'},
			{id: 'fresh', ipns: 'k51imported', status: 'authorized'},
		]);
		// ONLY the site that needed one was imported.
		const imports = mock.requestsFor('key/import');
		expect(imports.length).toBe(1);
		expect(imports[0].query.get('arg')).toBe('fresh');
	});

	it('re-running the bare form is safe: no site is re-imported', async () => {
		const mock = withSites(nodeHolding({a: 'k51a', b: 'k51b'}), ['a', 'b']);
		const result = await authorizePublisher({
			publisher: publisherTarget(mock),
			deriveKey,
		});

		expect(mock.requestsFor('key/import').length).toBe(0);
		expect(result.sites.every((s) => s.status === 'already-authorized')).toBe(
			true,
		);
	});

	it('a publisher with no MFS sites yields an empty report, not an error', async () => {
		const mock = nodeHolding({});
		const result = await authorizePublisher({
			publisher: publisherTarget(mock),
			deriveKey,
		});
		expect(result.sites).toEqual([]);
		expect(mock.requestsFor('key/import').length).toBe(0);
	});
});

describe('guard: another configured host already holds the key (two signers race)', () => {
	it('REFUSES the import, naming that host and the hazard', async () => {
		const pub = nodeHolding({});
		const other = nodeHolding({mysite: 'k51elsewhere'}, 'https://b.example');

		await expect(
			authorizePublisher({
				publisher: publisherTarget(pub),
				others: [{name: 'replica-01', client: clientWith(other)}],
				ids: ['mysite'],
				deriveKey,
			}),
		).rejects.toThrow(AuthorizeSecondSignerError);

		// Refused BEFORE anything was written to the publisher.
		expect(pub.requestsFor('key/import').length).toBe(0);
	});

	it('names the holder, the site and the sequence-number hazard in the message', async () => {
		const pub = nodeHolding({});
		const other = nodeHolding({mysite: 'k51elsewhere'}, 'https://b.example');
		const error = await authorizePublisher({
			publisher: publisherTarget(pub),
			others: [{name: 'replica-01', client: clientWith(other)}],
			ids: ['mysite'],
			deriveKey,
		}).catch((e: unknown) => e as Error);

		expect(error.message).toContain('replica-01');
		expect(error.message).toContain('mysite');
		expect(error.message).toMatch(/sequence number/i);
	});

	it('is PRE-FLIGHT across the whole bare run: one conflict imports NOTHING', async () => {
		const pub = withSites(nodeHolding({}), ['clean', 'contested']);
		const other = nodeHolding({contested: 'k51elsewhere'}, 'https://b.example');

		await expect(
			authorizePublisher({
				publisher: publisherTarget(pub),
				others: [{name: 'replica-01', client: clientWith(other)}],
				deriveKey,
			}),
		).rejects.toThrow(AuthorizeSecondSignerError);

		// `clean` needed a key too, and was NOT imported: the run refused as a whole.
		expect(pub.requestsFor('key/import').length).toBe(0);
	});

	it('an unreachable other host is REPORTED as unchecked, not a refusal', async () => {
		const pub = nodeHolding({});
		const down = new MockKuboApi('https://down.example').on('key/list', {
			status: 500,
			json: {Message: 'boom'},
		});
		const result = await authorizePublisher({
			publisher: publisherTarget(pub),
			others: [{name: 'replica-01', client: clientWith(down)}],
			ids: ['mysite'],
			deriveKey,
		});

		expect(result.unchecked).toEqual(['replica-01']);
		expect(result.sites[0].status).toBe('authorized');
	});

	it('does not probe the other hosts at all when every site is already authorized', async () => {
		const pub = nodeHolding({mysite: 'k51held'});
		const other = nodeHolding({}, 'https://b.example');
		const result = await authorizePublisher({
			publisher: publisherTarget(pub),
			others: [{name: 'replica-01', client: clientWith(other)}],
			ids: ['mysite'],
			deriveKey,
		});

		// Nothing is being imported, so there is no second-signer hazard to check.
		expect(other.requests.length).toBe(0);
		expect(result.unchecked).toEqual([]);
	});
});

describe('guard: the key-import seam still refuses a declared replica (ADR-0003)', () => {
	it('refuses to import onto a host the config declares a replica, touching no node', async () => {
		const mock = nodeHolding({});
		await expect(
			authorizePublisher({
				publisher: {name: 'b', client: clientWith(mock), role: 'replica'},
				ids: ['mysite'],
				deriveKey,
			}),
		).rejects.toThrow(KeyImportRoleError);
		expect(mock.requestsFor('key/import').length).toBe(0);
	});
});
