import {describe, it, expect} from 'vitest';
import {KuboRpcClient} from '../../src/rpc/kubo-rpc-client.js';
import {MockKuboApi} from '../../src/rpc/mock-kubo.js';
import {
	pinExternal,
	PinStageError,
	PinPublisherRequiredError,
	PinSourceResolveError,
	type PinTarget,
} from '../../src/pin/pin-external.js';
import {removeSite} from '../../src/site/site-management.js';
import {
	parseSiteMetadata,
	EnsNameInferenceError,
	type SiteMetadata,
} from '../../src/site/site-wrapper.js';
import {discoverSites} from '../../src/node/node-commands.js';
import {deriveIpnsKey} from '../../src/derive/ipns-key-derivation.js';
import {serializeIpnsKeyForImport} from '../../src/publisher/key-import.js';

/**
 * `pinExternal` tests (task `pin-external-cid`).
 *
 * Pinning an ARBITRARY network CID is tested at the Kubo RPC boundary through
 * the recording {@link MockKuboApi} (spec Testing Decisions: no live daemon).
 * We assert:
 *  - the `pin/add?arg=<cid>&recursive=true` call shape + each node's OWN bearer
 *    token, on EVERY configured node (redundant by default),
 *  - the MFS placement (`files/mkdir` / `files/rm` / `files/cp` / `files/write`)
 *    into the wrapper `/sites/<name>/{content, metadata.json}` so
 *    status/warm/republish auto-discover the pin,
 *  - the deploy-style `allSettled` partial-failure semantics (a non-empty
 *    success subset is still an overall success), including which STAGE failed,
 *  - that `site remove <name>` (the EXISTING verb) unpins a pin-added site, so
 *    no second removal verb is needed.
 *
 * Each node gets its OWN MockKuboApi (own baseUrl + token + recorded requests),
 * so the fan-out and per-token isolation are observable.
 */

const EXTERNAL_CID = 'bafyexternalcid';

/** A fresh mock node; `files/stat` resolves to the pinned CID (for removal). */
function mockNode(baseUrl: string, cid = EXTERNAL_CID): MockKuboApi {
	const mock = new MockKuboApi(baseUrl);
	mock.on('files/stat', {json: {Hash: cid, Type: 'directory'}});
	return mock;
}

/** The site metadata a recorded `files/write` carried (Kubo's `file` part). */
function metadataOf(mock: MockKuboApi): SiteMetadata {
	return parseSiteMetadata(metadataBytesOf(mock));
}

/** The RAW `metadata.json` text a recorded `files/write` carried. */
function metadataTextOf(mock: MockKuboApi): string {
	return Buffer.from(metadataBytesOf(mock)).toString('utf8');
}

/** The bytes of the `file` part of the first recorded `files/write`. */
function metadataBytesOf(mock: MockKuboApi): Uint8Array {
	const part = mock
		.requestsFor('files/write')[0]
		.fileParts?.find((p) => p.field === 'file');
	if (!part) throw new Error('files/write carried no `file` part');
	return part.bytes;
}

/** A pin target backed by its own recording mock (distinct baseUrl + token). */
function targetWith(
	mock: MockKuboApi,
	token: string,
	extra: Partial<PinTarget> = {},
): PinTarget {
	return {
		baseUrl: mock.baseUrl,
		token,
		fetchImpl: mock.fetchImpl,
		...extra,
	};
}

describe('pinExternal — pin/add an arbitrary CID on EVERY node (redundant)', () => {
	it('issues pin/add?arg=<cid>&recursive=true on every node with its OWN token', async () => {
		const a = mockNode('https://node-a.test');
		const b = mockNode('https://node-b.test');
		const result = await pinExternal({
			targets: [targetWith(a, 'token-a'), targetWith(b, 'token-b')],
			cid: EXTERNAL_CID,
			name: 'archive',
		});

		expect(result.success).toBe(true);
		expect(result.ok.map((r) => r.baseUrl)).toEqual([
			'https://node-a.test',
			'https://node-b.test',
		]);
		expect(result.failed.length).toBe(0);
		expect(result.cid).toBe(EXTERNAL_CID);
		expect(result.name).toBe('archive');
		expect(result.recursive).toBe(true);

		const tokens = {a: 'Bearer token-a', b: 'Bearer token-b'};
		for (const [key, mock] of [
			['a', a],
			['b', b],
		] as const) {
			const pin = mock.requestsFor('pin/add');
			expect(pin.length).toBe(1);
			expect(pin[0].query.get('arg')).toBe(EXTERNAL_CID);
			expect(pin[0].query.get('recursive')).toBe('true');
			expect(pin[0].headers['authorization']).toBe(tokens[key]);
		}
	});

	it('does NOT import a CAR (pin FETCHES an existing CID; it never uploads bytes)', async () => {
		const a = mockNode('https://node-a.test');
		await pinExternal({
			targets: [targetWith(a, 'token-a')],
			cid: EXTERNAL_CID,
			name: 'archive',
		});
		expect(a.requestsFor('dag/import').length).toBe(0);
		expect(a.requestsFor('add').length).toBe(0);
	});

	it('passes recursive=false through when the operator disables recursion', async () => {
		const a = mockNode('https://node-a.test');
		const result = await pinExternal({
			targets: [targetWith(a, 'token-a')],
			cid: EXTERNAL_CID,
			name: 'archive',
			recursive: false,
		});
		expect(result.recursive).toBe(false);
		expect(a.requestsFor('pin/add')[0].query.get('recursive')).toBe('false');
	});

	it('narrows to a single node when only one target is given (--host)', async () => {
		const a = mockNode('https://node-a.test');
		const b = mockNode('https://node-b.test');
		const result = await pinExternal({
			targets: [targetWith(a, 'token-a')],
			cid: EXTERNAL_CID,
			name: 'archive',
		});
		expect(result.ok.map((r) => r.baseUrl)).toEqual(['https://node-a.test']);
		expect(b.requests.length).toBe(0);
	});
});

describe('pinExternal — MFS placement so the pin is tracked like a site', () => {
	it('places the pinned CID at /sites/<name>/content (mkdir / rm / cp / write) AFTER pinning', async () => {
		const a = mockNode('https://node-a.test');
		await pinExternal({
			targets: [targetWith(a, 'token-a')],
			cid: EXTERNAL_CID,
			name: 'archive',
		});

		// The exact call sequence: pin FIRST (the node must hold the bytes), then
		// the MFS placement that makes status/warm/republish discover it (the
		// `files/read` is the metadata read-modify-write: with no ens flag the pin
		// PRESERVES whatever ensName the entry already carries).
		expect(a.requests.map((r) => r.path)).toEqual([
			'pin/add',
			'files/read',
			'files/mkdir',
			'files/rm',
			'files/cp',
			'files/write',
		]);

		const mkdir = a.requestsFor('files/mkdir')[0];
		expect(mkdir.query.get('arg')).toBe('/sites/archive');
		expect(mkdir.query.get('parents')).toBe('true');

		const cp = a.requestsFor('files/cp')[0];
		expect(cp.query.getAll('arg')).toEqual([
			`/ipfs/${EXTERNAL_CID}`,
			'/sites/archive/content',
		]);

		// The wrapper's metadata.json records the mode the pin ran in (`ipfs` by
		// default).
		const write = a.requestsFor('files/write')[0];
		expect(write.query.get('arg')).toBe('/sites/archive/metadata.json');
		expect(metadataOf(a)).toEqual({mode: 'ipfs'});
	});

	it('lands the pin where the on-box auto-discovery (warm/status) reads sites', async () => {
		const a = mockNode('https://node-a.test');
		await pinExternal({
			targets: [targetWith(a, 'token-a')],
			cid: EXTERNAL_CID,
			name: 'archive',
		});

		// Feed the MFS listing back from the placement the pin ACTUALLY made (the
		// mock holds no state): the entry `pin` created is the entry the on-box
		// discovery (used by warm / republish / status / the dashboard) reads.
		const placed = a
			.requestsFor('files/cp')
			.map((r) =>
				r.query.getAll('arg')[1].replace('/sites/', '').replace('/content', ''),
			);
		a.on('files/ls', {json: {Entries: placed.map((Name) => ({Name}))}});

		const discovered = await discoverSites(
			new KuboRpcClient({
				baseUrl: a.baseUrl,
				token: 'token-a',
				fetchImpl: a.fetchImpl,
			}),
		);
		expect(discovered).toEqual([
			{id: 'archive', cid: EXTERNAL_CID, metadata: {}},
		]);
	});

	it('honours an explicit sitesDir', async () => {
		const a = mockNode('https://node-a.test');
		await pinExternal({
			targets: [targetWith(a, 'token-a')],
			cid: EXTERNAL_CID,
			name: 'archive',
			sitesDir: '/custom',
		});
		expect(a.requestsFor('files/cp')[0].query.getAll('arg')).toEqual([
			`/ipfs/${EXTERNAL_CID}`,
			'/custom/archive/content',
		]);
	});
});

describe('pinExternal — fan-out partial failure (a non-empty subset is success)', () => {
	it('reports the unretrievable node and still succeeds overall', async () => {
		const good = mockNode('https://good.test');
		const bad = mockNode('https://bad.test');
		// Kubo could not find/fetch the content on this node.
		bad.on('pin/add', {status: 500, text: 'merkledag: not found'});

		const result = await pinExternal({
			targets: [targetWith(good, 'token-good'), targetWith(bad, 'token-bad')],
			cid: EXTERNAL_CID,
			name: 'archive',
		});

		expect(result.success).toBe(true);
		expect(result.ok.map((r) => r.baseUrl)).toEqual(['https://good.test']);
		expect(result.failed.length).toBe(1);
		expect(result.failed[0].baseUrl).toBe('https://bad.test');
		expect(result.failed[0].stage).toBe('pin');
		// The error is clear about WHAT failed and WHY it might have (retrievability).
		expect(result.failed[0].error).toBeInstanceOf(PinStageError);
		expect(result.failed[0].error.message).toContain('pin/add');
		expect(result.failed[0].error.message).toContain(EXTERNAL_CID);
		expect(result.failed[0].error.message).toMatch(/retrievab/i);

		// The failing node never got the MFS placement (nothing to place).
		expect(bad.requestsFor('files/cp').length).toBe(0);
		// The good node was unaffected by the bad node's failure.
		expect(good.requestsFor('files/cp').length).toBe(1);
	});

	it('reports the MFS-placement stage separately from the pin stage', async () => {
		const a = mockNode('https://node-a.test');
		a.on('files/cp', {status: 500, text: 'file already exists'});
		const result = await pinExternal({
			targets: [targetWith(a, 'token-a')],
			cid: EXTERNAL_CID,
			name: 'archive',
		});
		expect(result.success).toBe(false);
		expect(result.failed[0].stage).toBe('place');
		expect(result.failed[0].error.message).toContain('/sites/archive');
		// It DID pin (the failure is downstream of the pin).
		expect(a.requestsFor('pin/add').length).toBe(1);
	});

	it('every node failing is NOT a success', async () => {
		const a = mockNode('https://a.test');
		const b = mockNode('https://b.test');
		a.on('pin/add', {status: 500, text: 'boom'});
		b.on('pin/add', {status: 500, text: 'boom'});
		const result = await pinExternal({
			targets: [targetWith(a, 'token-a'), targetWith(b, 'token-b')],
			cid: EXTERNAL_CID,
			name: 'archive',
		});
		expect(result.success).toBe(false);
		expect(result.ok.length).toBe(0);
		expect(result.failed.length).toBe(2);
	});
});

describe('site remove — the EXISTING verb unpins a pin-added site', () => {
	it('removes the MFS entry AND pin/rm the externally-pinned CID', async () => {
		const a = mockNode('https://node-a.test');
		await pinExternal({
			targets: [targetWith(a, 'token-a')],
			cid: EXTERNAL_CID,
			name: 'archive',
		});

		const client = new KuboRpcClient({
			baseUrl: a.baseUrl,
			token: 'token-a',
			fetchImpl: a.fetchImpl,
		});
		const removed = await removeSite({client, id: 'archive'});

		// The same MFS entry + the same pin the `pin` verb created: one removal
		// verb covers both deployed and pin-added sites.
		expect(removed.cid).toBe(EXTERNAL_CID);
		expect(removed.unpinned).toBe(true);
		const rm = a.requestsFor('files/rm');
		expect(rm[rm.length - 1].query.get('arg')).toBe('/sites/archive');
		const unpin = a.requestsFor('pin/rm');
		expect(unpin.length).toBe(1);
		expect(unpin[0].query.get('arg')).toBe(EXTERNAL_CID);
	});
});

// ---------------------------------------------------------------------------
// `--mode ipns`: the pin ALSO gets the operator's OWN stable IPNS name
// (task `pin-external-cid-ipns-mode`). The mode branch MIRRORS deploy's:
// `ipfs` = pin + MFS only; `ipns` ADDS key import + key/list + name/publish, on
// the PUBLISHER target only (a replica never signs).
// ---------------------------------------------------------------------------

/**
 * The FROZEN golden vector from `test/derive/ipns-key-derivation.test.ts`: the
 * same (master, id) MUST yield the same `k51...` id here as `derive`/`promote`
 * print, so an operator can pre-set the name before ever pinning.
 */
const GOLDEN_MASTER = 'test-master-secret';
const GOLDEN_NAME = 'mysite';
const GOLDEN_IPNS_ID =
	'k51qzi5uqu5dkkob0ou1d9xbkr1yskaj07trqc5czn58kvkos6n7y2yid3u4n5';

/** The derived per-site key the CLI resolves from the env-only master. */
function derivedForGoldenName() {
	return deriveIpnsKey({master: GOLDEN_MASTER, keyId: GOLDEN_NAME});
}

/** A publisher whose keystore is EMPTY (the FIRST pin: the key must be imported). */
function keylessPublisher(baseUrl: string, cid = EXTERNAL_CID): MockKuboApi {
	const mock = mockNode(baseUrl, cid);
	mock.on('key/list', {json: {Keys: []}});
	return mock;
}

/** A publisher that ALREADY holds the same-named key (the re-pin path). */
function keyedPublisher(
	baseUrl: string,
	ipnsId = GOLDEN_IPNS_ID,
	cid = EXTERNAL_CID,
): MockKuboApi {
	const mock = mockNode(baseUrl, cid);
	mock.on('key/list', {json: {Keys: [{Name: GOLDEN_NAME, Id: ipnsId}]}});
	return mock;
}

describe('pinExternal — mode ipfs (the DEFAULT) is pin + MFS ONLY', () => {
	it('issues no key/list, no key/import and no name/publish (mode omitted)', async () => {
		const a = keylessPublisher('https://publisher.test');
		const result = await pinExternal({
			targets: [targetWith(a, 'token-a', {role: 'publisher'})],
			cid: EXTERNAL_CID,
			name: GOLDEN_NAME,
		});

		expect(a.requests.map((r) => r.path)).toEqual([
			'pin/add',
			'files/read',
			'files/mkdir',
			'files/rm',
			'files/cp',
			'files/write',
		]);
		expect(result.mode).toBe('ipfs');
		expect(result.ipns).toBeUndefined();
		expect(result.ok[0].published).toBe(false);
		expect(result.ok[0].ipns).toBeUndefined();
	});

	it('is identical when ipfs is passed EXPLICITLY (no key, no publish)', async () => {
		const a = keylessPublisher('https://publisher.test');
		await pinExternal({
			targets: [targetWith(a, 'token-a', {role: 'publisher'})],
			cid: EXTERNAL_CID,
			name: GOLDEN_NAME,
			mode: 'ipfs',
			// Even WITH a derived key in hand, ipfs mode must not publish.
			derived: derivedForGoldenName(),
		});
		expect(a.requestsFor('key/list').length).toBe(0);
		expect(a.requestsFor('key/import').length).toBe(0);
		expect(a.requestsFor('name/publish').length).toBe(0);
	});
});

describe('pinExternal — mode ipns ADDS the publish path (publisher only)', () => {
	it('pins, places, imports the derived key, then name/publishes /ipfs/<cid>', async () => {
		const a = keylessPublisher('https://publisher.test');
		const derived = derivedForGoldenName();
		const result = await pinExternal({
			targets: [targetWith(a, 'token-a', {role: 'publisher'})],
			cid: EXTERNAL_CID,
			name: GOLDEN_NAME,
			mode: 'ipns',
			derived,
		});

		// The FULL sequence: the pin + MFS placement FIRST (unchanged), THEN the
		// key lookup, the import of the missing key, and the publish.
		expect(a.requests.map((r) => r.path)).toEqual([
			'pin/add',
			'files/read',
			'files/mkdir',
			'files/rm',
			'files/cp',
			'files/write',
			'key/list',
			'key/import',
			'name/publish',
		]);

		// The wrapper metadata records the ipns mode this pin ran in.
		expect(metadataOf(a)).toEqual({mode: 'ipns'});

		// The key was imported under the site name (the `--as <name>` id) as the
		// MATERIAL Kubo signs with — the exact bytes the key-import seam produces.
		const imported = a.requestsFor('key/import')[0];
		expect(imported.query.get('arg')).toBe(GOLDEN_NAME);
		expect(imported.contentType).toBe('multipart/form-data');
		expect(
			Buffer.from(imported.fileParts?.[0].bytes ?? []).toString('hex'),
		).toBe(Buffer.from(serializeIpnsKeyForImport(derived)).toString('hex'));

		// The node (never the client) signs: name/publish points the name at the
		// PINNED cid, with the frozen record lifetime/ttl.
		const published = a.requestsFor('name/publish');
		expect(published.length).toBe(1);
		expect(published[0].query.get('arg')).toBe(`/ipfs/${EXTERNAL_CID}`);
		expect(published[0].query.get('key')).toBe(GOLDEN_NAME);
		expect(published[0].query.get('lifetime')).toBe('72h');
		expect(published[0].query.get('ttl')).toBe('1h');
		expect(published[0].headers['authorization']).toBe('Bearer token-a');

		expect(result.mode).toBe('ipns');
		expect(result.success).toBe(true);
		expect(result.ok[0].published).toBe(true);
	});

	it('reports the operator OWN name: the golden derived id for that <name>', async () => {
		const a = keylessPublisher('https://publisher.test');
		const result = await pinExternal({
			targets: [targetWith(a, 'token-a', {role: 'publisher'})],
			cid: EXTERNAL_CID,
			name: GOLDEN_NAME,
			mode: 'ipns',
			derived: derivedForGoldenName(),
		});
		// Same (master, id) -> same k51... as `derive`/`promote` print.
		expect(result.ipns).toBe(GOLDEN_IPNS_ID);
		expect(result.ok[0].ipns).toBe(GOLDEN_IPNS_ID);
	});

	it('prefers the id the node reports for the key when it gives one', async () => {
		const a = keyedPublisher('https://publisher.test', GOLDEN_IPNS_ID);
		const result = await pinExternal({
			targets: [targetWith(a, 'token-a', {role: 'publisher'})],
			cid: EXTERNAL_CID,
			name: GOLDEN_NAME,
			mode: 'ipns',
			derived: derivedForGoldenName(),
		});
		expect(result.ipns).toBe(GOLDEN_IPNS_ID);
	});

	it('does NOT re-import a key the publisher already holds (still publishes)', async () => {
		const a = keyedPublisher('https://publisher.test');
		await pinExternal({
			targets: [targetWith(a, 'token-a', {role: 'publisher'})],
			cid: EXTERNAL_CID,
			name: GOLDEN_NAME,
			mode: 'ipns',
			derived: derivedForGoldenName(),
		});
		expect(a.requestsFor('key/list').length).toBe(1);
		expect(a.requestsFor('key/import').length).toBe(0);
		expect(a.requestsFor('name/publish').length).toBe(1);
	});

	it('re-pinning a NEWER cid under the same name re-publishes: the name updates', async () => {
		const a = keyedPublisher('https://publisher.test');
		const derived = derivedForGoldenName();
		const first = await pinExternal({
			targets: [targetWith(a, 'token-a', {role: 'publisher'})],
			cid: 'bafyoldsnapshot',
			name: GOLDEN_NAME,
			mode: 'ipns',
			derived,
		});
		const second = await pinExternal({
			targets: [targetWith(a, 'token-a', {role: 'publisher'})],
			cid: 'bafynewsnapshot',
			name: GOLDEN_NAME,
			mode: 'ipns',
			derived,
		});

		const published = a.requestsFor('name/publish');
		expect(published.length).toBe(2);
		expect(published[0].query.get('arg')).toBe('/ipfs/bafyoldsnapshot');
		expect(published[1].query.get('arg')).toBe('/ipfs/bafynewsnapshot');
		// The NAME is stable across the re-pin; only the cid it points at moved.
		expect(published[1].query.get('key')).toBe(GOLDEN_NAME);
		expect(second.ipns).toBe(first.ipns);
		expect(second.cid).toBe('bafynewsnapshot');
	});

	it('publishes on the publisher ONLY: a replica pins + places but NEVER signs', async () => {
		const publisher = keylessPublisher('https://publisher.test');
		const replica = keylessPublisher('https://replica.test');
		const result = await pinExternal({
			targets: [
				targetWith(publisher, 'token-pub', {role: 'publisher'}),
				targetWith(replica, 'token-rep', {role: 'replica'}),
			],
			cid: EXTERNAL_CID,
			name: GOLDEN_NAME,
			mode: 'ipns',
			derived: derivedForGoldenName(),
		});

		// The pin still fans out to EVERY node (redundancy is unchanged)...
		expect(result.ok.length).toBe(2);
		expect(replica.requestsFor('pin/add').length).toBe(1);
		expect(replica.requestsFor('files/cp').length).toBe(1);
		// ...but ONLY the publisher holds a key and signs.
		expect(publisher.requestsFor('name/publish').length).toBe(1);
		expect(replica.requestsFor('name/publish').length).toBe(0);
		expect(replica.requestsFor('key/import').length).toBe(0);
		expect(replica.requestsFor('key/list').length).toBe(0);

		const byUrl = new Map(result.ok.map((o) => [o.baseUrl, o]));
		expect(byUrl.get('https://publisher.test')?.published).toBe(true);
		expect(byUrl.get('https://replica.test')?.published).toBe(false);
		expect(byUrl.get('https://replica.test')?.ipns).toBeUndefined();
	});
});

describe('pinExternal — a failed publish is reported as its OWN stage', () => {
	it('reports stage `publish` (the content IS pinned; only the name did not move)', async () => {
		const a = keyedPublisher('https://publisher.test');
		a.on('name/publish', {status: 500, text: 'no key'});
		const result = await pinExternal({
			targets: [targetWith(a, 'token-a', {role: 'publisher'})],
			cid: EXTERNAL_CID,
			name: GOLDEN_NAME,
			mode: 'ipns',
			derived: derivedForGoldenName(),
		});
		expect(result.failed[0].stage).toBe('publish');
		expect(result.failed[0].error).toBeInstanceOf(PinStageError);
		expect(result.failed[0].error.message).toContain('ipns');
		// It DID pin + place (the failure is downstream of both).
		expect(a.requestsFor('pin/add').length).toBe(1);
		expect(a.requestsFor('files/cp').length).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// `--from-ipns <source>`: MIGRATE from an existing IPNS name (task
// `pin-from-ipns-migrate`). The source name is resolved to the CID it CURRENTLY
// points at on one reachable target, and everything after that is the EXISTING
// pin flow with that resolved CID. The SOURCE name is never the operator's name:
// in `ipns` mode the publish still happens under the `--as <name>` derived key.
// ---------------------------------------------------------------------------

const SOURCE_NAME = 'k51sourcename';
const RESOLVED_CID = 'bafycurrentsnapshot';

/** A node that resolves the source name to {@link RESOLVED_CID}. */
function resolvingNode(baseUrl: string, cid = RESOLVED_CID): MockKuboApi {
	const mock = mockNode(baseUrl, cid);
	mock.on('name/resolve', {json: {Path: `/ipfs/${cid}`}});
	return mock;
}

describe('pinExternal: fromIpns resolves the SOURCE name, then pins that cid', () => {
	it('resolves on ONE target, then pins the RESOLVED cid on EVERY node', async () => {
		const a = resolvingNode('https://node-a.test');
		const b = resolvingNode('https://node-b.test');
		const result = await pinExternal({
			targets: [targetWith(a, 'token-a'), targetWith(b, 'token-b')],
			fromIpns: SOURCE_NAME,
			name: 'archive',
		});

		// The resolve is ONE read on the first reachable node (not per-node).
		expect(a.requestsFor('name/resolve').length).toBe(1);
		expect(a.requestsFor('name/resolve')[0].query.get('arg')).toBe(
			`/ipns/${SOURCE_NAME}`,
		);
		expect(b.requestsFor('name/resolve').length).toBe(0);

		// ...and it happens BEFORE the pin, whose arg is the RESOLVED CID, never
		// the name.
		expect(a.requests.map((r) => r.path)).toEqual([
			'name/resolve',
			'pin/add',
			'files/read',
			'files/mkdir',
			'files/rm',
			'files/cp',
			'files/write',
		]);
		for (const mock of [a, b]) {
			const pin = mock.requestsFor('pin/add');
			expect(pin.length).toBe(1);
			expect(pin[0].query.get('arg')).toBe(RESOLVED_CID);
			expect(mock.requestsFor('files/cp')[0].query.getAll('arg')).toEqual([
				`/ipfs/${RESOLVED_CID}`,
				'/sites/archive/content',
			]);
		}

		// The operator is told WHAT was pinned, and where the source resolved.
		expect(result.cid).toBe(RESOLVED_CID);
		expect(result.fromIpns).toBe(SOURCE_NAME);
		expect(result.resolvedBy).toBe('https://node-a.test');
		expect(result.success).toBe(true);
		expect(result.ok.map((r) => r.cid)).toEqual([RESOLVED_CID, RESOLVED_CID]);
	});

	it('falls back to the NEXT target when the first cannot resolve (reachability)', async () => {
		const unreachable = resolvingNode('https://down.test');
		unreachable.on('name/resolve', {status: 500, text: 'routing: not found'});
		const up = resolvingNode('https://up.test');
		const result = await pinExternal({
			targets: [
				targetWith(unreachable, 'token-down'),
				targetWith(up, 'token-up'),
			],
			fromIpns: SOURCE_NAME,
			name: 'archive',
		});
		expect(result.resolvedBy).toBe('https://up.test');
		expect(result.cid).toBe(RESOLVED_CID);
		// The node that could not resolve still PINS (the fan-out is unchanged).
		expect(unreachable.requestsFor('pin/add')[0].query.get('arg')).toBe(
			RESOLVED_CID,
		);
	});

	it('ipns mode publishes the RESOLVED cid under the operator OWN derived key', async () => {
		const a = resolvingNode('https://publisher.test');
		a.on('key/list', {json: {Keys: []}});
		const result = await pinExternal({
			targets: [targetWith(a, 'token-a', {role: 'publisher'})],
			fromIpns: SOURCE_NAME,
			name: GOLDEN_NAME,
			mode: 'ipns',
			derived: derivedForGoldenName(),
		});

		const published = a.requestsFor('name/publish');
		expect(published.length).toBe(1);
		// The RESOLVED snapshot, published under the operator's OWN name: the
		// source name is NOT the key (migrating never hands over the source's key).
		expect(published[0].query.get('arg')).toBe(`/ipfs/${RESOLVED_CID}`);
		expect(published[0].query.get('key')).toBe(GOLDEN_NAME);
		expect(a.requestsFor('key/import')[0].query.get('arg')).toBe(GOLDEN_NAME);
		expect(result.ipns).toBe(GOLDEN_IPNS_ID);
		expect(result.fromIpns).toBe(SOURCE_NAME);
		expect(result.cid).toBe(RESOLVED_CID);
	});

	it('re-running RE-RESOLVES the source (a manual re-migrate, never an auto-follow)', async () => {
		const a = resolvingNode('https://publisher.test', 'bafyoldsnapshot');
		a.on('key/list', {json: {Keys: [{Name: GOLDEN_NAME, Id: GOLDEN_IPNS_ID}]}});
		const first = await pinExternal({
			targets: [targetWith(a, 'token-a', {role: 'publisher'})],
			fromIpns: SOURCE_NAME,
			name: GOLDEN_NAME,
			mode: 'ipns',
			derived: derivedForGoldenName(),
		});
		// The source moved on; a SECOND run picks up the newer snapshot.
		a.on('name/resolve', {json: {Path: '/ipfs/bafynewsnapshot'}});
		const second = await pinExternal({
			targets: [targetWith(a, 'token-a', {role: 'publisher'})],
			fromIpns: SOURCE_NAME,
			name: GOLDEN_NAME,
			mode: 'ipns',
			derived: derivedForGoldenName(),
		});

		expect(first.cid).toBe('bafyoldsnapshot');
		expect(second.cid).toBe('bafynewsnapshot');
		// Each run re-resolves (nothing tracks the source between runs)...
		expect(a.requestsFor('name/resolve').length).toBe(2);
		// ...and the operator's OWN name is stable across both.
		expect(second.ipns).toBe(first.ipns);
		expect(
			a.requestsFor('name/publish').map((r) => r.query.get('arg')),
		).toEqual(['/ipfs/bafyoldsnapshot', '/ipfs/bafynewsnapshot']);
	});
});

describe('pinExternal: exactly ONE source: a cid XOR fromIpns', () => {
	it('refuses BOTH a cid and a fromIpns, touching no node', async () => {
		const a = resolvingNode('https://node-a.test');
		await expect(
			pinExternal({
				targets: [targetWith(a, 'token-a')],
				cid: EXTERNAL_CID,
				fromIpns: SOURCE_NAME,
				name: 'archive',
			}),
		).rejects.toThrow(/one source/i);
		expect(a.requests.length).toBe(0);
	});

	it('refuses NEITHER a cid nor a fromIpns, touching no node', async () => {
		const a = resolvingNode('https://node-a.test');
		await expect(
			pinExternal({targets: [targetWith(a, 'token-a')], name: 'archive'}),
		).rejects.toThrow(/source/i);
		expect(a.requests.length).toBe(0);
	});
});

describe('pinExternal: a source name that does not resolve fails loud', () => {
	it('throws PinSourceResolveError carrying Kubo message, pinning nothing', async () => {
		const a = resolvingNode('https://node-a.test');
		const b = resolvingNode('https://node-b.test');
		a.on('name/resolve', {status: 500, text: 'routing: not found'});
		b.on('name/resolve', {status: 500, text: 'routing: not found'});
		const promise = pinExternal({
			targets: [targetWith(a, 'token-a'), targetWith(b, 'token-b')],
			fromIpns: SOURCE_NAME,
			name: 'archive',
		});
		await expect(promise).rejects.toThrow(PinSourceResolveError);
		try {
			await promise;
		} catch (e) {
			const error = e as PinSourceResolveError;
			expect(error.fromIpns).toBe(SOURCE_NAME);
			// Kubo's own words, per node it tried.
			expect(error.message).toContain('routing: not found');
			expect(error.message).toContain('https://node-b.test');
			expect(error.failures.length).toBe(2);
		}
		// Nothing was pinned under a name whose content we never found.
		expect(a.requestsFor('pin/add').length).toBe(0);
		expect(b.requestsFor('pin/add').length).toBe(0);
	});

	it('checks the ipns-mode preconditions BEFORE resolving the source', async () => {
		const replica = resolvingNode('https://replica.test');
		await expect(
			pinExternal({
				targets: [targetWith(replica, 'token-rep', {role: 'replica'})],
				fromIpns: SOURCE_NAME,
				name: GOLDEN_NAME,
				mode: 'ipns',
				derived: derivedForGoldenName(),
			}),
		).rejects.toThrow(PinPublisherRequiredError);
		// A refusal never even asks the network to resolve the source.
		expect(replica.requests.length).toBe(0);
	});
});

describe('pinExternal — mode ipns REFUSES loudly without a publisher to sign', () => {
	it('throws when no target is a publisher, touching NO node', async () => {
		const replica = keylessPublisher('https://replica.test');
		await expect(
			pinExternal({
				targets: [targetWith(replica, 'token-rep', {role: 'replica'})],
				cid: EXTERNAL_CID,
				name: GOLDEN_NAME,
				mode: 'ipns',
				derived: derivedForGoldenName(),
			}),
		).rejects.toThrow(PinPublisherRequiredError);
		// It refuses BEFORE pinning anything (no half-done state to reason about).
		expect(replica.requests.length).toBe(0);
	});

	it('treats a role-less target as unable to sign (ipfs-mode targets)', async () => {
		const a = keylessPublisher('https://node-a.test');
		await expect(
			pinExternal({
				targets: [targetWith(a, 'token-a')],
				cid: EXTERNAL_CID,
				name: GOLDEN_NAME,
				mode: 'ipns',
				derived: derivedForGoldenName(),
			}),
		).rejects.toThrow(PinPublisherRequiredError);
		expect(a.requests.length).toBe(0);
	});

	it('throws when the derived key is missing (the master is env-only, upstream)', async () => {
		const a = keylessPublisher('https://publisher.test');
		await expect(
			pinExternal({
				targets: [targetWith(a, 'token-a', {role: 'publisher'})],
				cid: EXTERNAL_CID,
				name: GOLDEN_NAME,
				mode: 'ipns',
			}),
		).rejects.toThrow(/derived/i);
		expect(a.requests.length).toBe(0);
	});
});

/**
 * The per-site metadata `pin` WRITES (task `deploy-pin-write-site-metadata`),
 * across BOTH entry points — `pin <cid>` and `pin --from-ipns <source>` (they
 * share one placement path, so both must carry the same metadata).
 *
 * A pin records the `mode` it ran in; the `ensName` field is reached through
 * the operator's two verb-flags, and OMITTING them never authors a name: a
 * first pin leaves the field ABSENT (a `.eth` id then infers via the on-box
 * warm rule) and a re-pin carries the existing value forward.
 */
describe('pinExternal — writes the per-site metadata {ensName?, mode}', () => {
	/** A pinned-site node that already carries `metadata.json` (the re-pin case). */
	function nodeHolding(metadataJson: string): MockKuboApi {
		const mock = mockNode('https://node-a.test');
		mock.on('files/read', {text: metadataJson});
		return mock;
	}

	/** A node with NO metadata for the name yet (the FIRST pin). */
	function freshNode(): MockKuboApi {
		const mock = mockNode('https://node-a.test');
		mock.on('files/read', {status: 500, text: 'file does not exist'});
		return mock;
	}

	it('--set-ens-name <name>: writes that name (no `.eth` requirement)', async () => {
		const a = freshNode();
		await pinExternal({
			targets: [targetWith(a, 'token-a')],
			cid: EXTERNAL_CID,
			name: 'archive',
			ensName: {kind: 'set', name: 'archive.eth'},
		});
		expect(metadataOf(a)).toEqual({ensName: 'archive.eth', mode: 'ipfs'});
	});

	it('bare --set-ens-name on a `.eth` name: writes NO ensName key (infer)', async () => {
		const a = nodeHolding('{"ensName":"stale.eth","mode":"ipfs"}');
		await pinExternal({
			targets: [targetWith(a, 'token-a')],
			cid: EXTERNAL_CID,
			name: 'archive.eth',
			ensName: {kind: 'infer'},
		});
		expect(metadataTextOf(a)).not.toContain('ensName');
		expect(metadataOf(a)).toEqual({mode: 'ipfs'});
	});

	it('bare --set-ens-name on a NON-`.eth` name: FAILS LOUD, touching no node', async () => {
		const a = freshNode();
		await expect(
			pinExternal({
				targets: [targetWith(a, 'token-a')],
				cid: EXTERNAL_CID,
				name: 'archive',
				ensName: {kind: 'infer'},
			}),
		).rejects.toBeInstanceOf(EnsNameInferenceError);
		// The refusal precedes the fan-out (and the source resolve): nothing pinned.
		expect(a.requests.length).toBe(0);
	});

	it('--unset-ens-name: writes the `""` opt-out', async () => {
		const a = nodeHolding('{"ensName":"archive.eth","mode":"ipfs"}');
		await pinExternal({
			targets: [targetWith(a, 'token-a')],
			cid: EXTERNAL_CID,
			name: 'archive.eth',
			ensName: {kind: 'unset'},
		});
		expect(metadataOf(a)).toEqual({ensName: '', mode: 'ipfs'});
	});

	it('FIRST pin with no ens flag: the ensName key is ABSENT', async () => {
		const a = freshNode();
		await pinExternal({
			targets: [targetWith(a, 'token-a')],
			cid: EXTERNAL_CID,
			name: 'archive.eth',
		});
		expect(metadataTextOf(a)).not.toContain('ensName');
		expect(metadataOf(a)).toEqual({mode: 'ipfs'});
	});

	it('RE-pin with no ens flag: PRESERVES the existing ensName (and a `""` opt-out)', async () => {
		const named = nodeHolding('{"ensName":"custom.example","mode":"ipfs"}');
		await pinExternal({
			targets: [targetWith(named, 'token-a')],
			cid: EXTERNAL_CID,
			name: 'archive',
		});
		expect(metadataOf(named)).toEqual({
			ensName: 'custom.example',
			mode: 'ipfs',
		});
		expect(named.requestsFor('files/read')[0].query.get('arg')).toBe(
			'/sites/archive/metadata.json',
		);

		const optedOut = nodeHolding('{"ensName":"","mode":"ipfs"}');
		await pinExternal({
			targets: [targetWith(optedOut, 'token-a')],
			cid: EXTERNAL_CID,
			name: 'archive.eth',
		});
		expect(metadataOf(optedOut).ensName).toBe('');
	});

	it('the --from-ipns entry point writes the SAME metadata', async () => {
		const set = resolvingNode('https://node-a.test');
		await pinExternal({
			targets: [targetWith(set, 'token-a')],
			fromIpns: SOURCE_NAME,
			name: 'archive',
			ensName: {kind: 'set', name: 'migrated.eth'},
		});
		expect(metadataOf(set)).toEqual({ensName: 'migrated.eth', mode: 'ipfs'});

		const preserving = resolvingNode('https://node-b.test');
		preserving.on('files/read', {text: '{"ensName":"kept.eth","mode":"ipfs"}'});
		await pinExternal({
			targets: [targetWith(preserving, 'token-b', {role: 'publisher'})],
			fromIpns: SOURCE_NAME,
			name: GOLDEN_NAME,
			mode: 'ipns',
			derived: derivedForGoldenName(),
		});
		expect(metadataOf(preserving)).toEqual({
			ensName: 'kept.eth',
			mode: 'ipns',
		});

		const refusing = resolvingNode('https://node-c.test');
		await expect(
			pinExternal({
				targets: [targetWith(refusing, 'token-c')],
				fromIpns: SOURCE_NAME,
				name: 'archive',
				ensName: {kind: 'infer'},
			}),
		).rejects.toBeInstanceOf(EnsNameInferenceError);
		expect(refusing.requests.length).toBe(0);
	});
});
