import {describe, it, expect} from 'vitest';
import {MockKuboApi, type RecordedRequest} from '../../src/rpc/mock-kubo.js';
import {
	updateSite,
	UpdateSiteMissingError,
	UpdatePublisherRequiredError,
	UpdateDerivedKeyRequiredError,
	type UpdateSiteTarget,
} from '../../src/update/update-site.js';
import {deriveIpnsKey} from '../../src/derive/ipns-key-derivation.js';
import {
	parseSiteMetadata,
	EnsNameInferenceError,
	SiteMetadataUnreadableError,
	SiteContentUnreadableError,
	type SiteMetadata,
} from '../../src/site/site-wrapper.js';

/**
 * `update` core tests: the verb that changes a LIVE site's metadata WITHOUT
 * rebuilding or re-placing its content.
 *
 * Driven at the Kubo RPC boundary through the recording {@link MockKuboApi}
 * (spec Testing Decisions: no live daemon), each node getting its OWN mock so
 * the fan-out and per-token isolation are observable.
 *
 * The load-bearing properties, each of which had a real defect before it was
 * tested:
 *  - NO CONTENT ROUND-TRIP: the verb's whole premise. It publishes the cid the
 *    node ALREADY holds and must never dag/import, files/cp or files/rm.
 *  - A preserved `mode` is resolved from a node that PROVABLY holds the site,
 *    never defaulted from a publisher that does not (which would STATE `ipfs`
 *    to the nodes that do, silently unpublishing a live name).
 *  - An OUTAGE is never reported as "this node does not have the site".
 *  - `--set-keep` is APPLIED, not merely recorded (as `placeInMfs` applies it
 *    for the verbs that do place content).
 *  - The reported cid is the AUTHORITY's (the one a resolved ipns mode just
 *    published), with divergent nodes named rather than averaged away.
 */

const SITES = '/sites';
const ID = 'mysite';
const CID = 'bafyCurrentBuild';
const IPNS = 'k51publishedid';

/** The metadata a recorded `files/write` carried. */
function metadataOf(req: RecordedRequest): SiteMetadata {
	const part = req.fileParts?.find((p) => p.field === 'file');
	if (!part) throw new Error('files/write carried no `file` part');
	return parseSiteMetadata(part.bytes);
}

/** The single `metadata.json` write a node received (asserts exactly one). */
function soleMetadataWrite(mock: MockKuboApi): SiteMetadata {
	const writes = mock.requestsFor('files/write');
	expect(writes.length).toBe(1);
	return metadataOf(writes[0]);
}

/**
 * A node that HOLDS the site: `/sites` lists it, the wrapper lists `content`
 * and `metadata.json`, and `files/stat` answers with the cid.
 *
 * The `files/ls` tree is modelled per-arg because the strict readers walk UP
 * the path and need `/sites` and `/sites/<id>` to answer differently.
 */
function nodeHolding(
	baseUrl: string,
	stored: SiteMetadata,
	options: {cid?: string; keys?: Array<{Name: string; Id: string}>} = {},
): MockKuboApi {
	const cid = options.cid ?? CID;
	const mock = new MockKuboApi(baseUrl);
	mock.onArg('files/ls', SITES, {json: {Entries: [{Name: ID}]}});
	mock.onArg('files/ls', `${SITES}/${ID}`, {
		json: {Entries: [{Name: 'content'}, {Name: 'metadata.json'}]},
	});
	mock.onArg('files/stat', `${SITES}/${ID}/content`, {json: {Hash: cid}});
	mock.onArg('files/read', `${SITES}/${ID}/metadata.json`, {
		text: `${JSON.stringify(stored)}\n`,
	});
	mock.on('files/write', {json: {}});
	mock.on('key/list', {json: {Keys: options.keys ?? [{Name: ID, Id: IPNS}]}});
	mock.on('name/publish', {json: {Name: IPNS, Value: `/ipfs/${cid}`}});
	mock.on('pin/rm', {json: {Pins: []}});
	return mock;
}

/** A node whose `/sites` exists but does NOT list this site (POSITIVE absence). */
function nodeWithoutSite(baseUrl: string): MockKuboApi {
	const mock = new MockKuboApi(baseUrl);
	mock.onArg('files/ls', SITES, {json: {Entries: [{Name: 'someone-else'}]}});
	mock.on('files/write', {json: {}});
	mock.on('key/list', {json: {Keys: []}});
	return mock;
}

/** A node that answers NOTHING (down, or a stale token): every call 500s. */
function nodeDown(baseUrl: string): MockKuboApi {
	const mock = new MockKuboApi(baseUrl);
	mock.on('files/ls', {status: 500, text: 'node is down'});
	mock.on('files/stat', {status: 500, text: 'node is down'});
	mock.on('files/read', {status: 500, text: 'node is down'});
	mock.on('files/write', {status: 500, text: 'node is down'});
	mock.on('key/list', {status: 500, text: 'node is down'});
	return mock;
}

function targetWith(
	mock: MockKuboApi,
	token: string,
	role: 'publisher' | 'replica' = 'publisher',
): UpdateSiteTarget {
	return {baseUrl: mock.baseUrl, token, role, fetchImpl: mock.fetchImpl};
}

const derived = deriveIpnsKey({master: 'test-master', keyId: ID});

// ---------------------------------------------------------------------------

describe('the premise: metadata changes, content is never touched', () => {
	it('promotes an ipfs-mode site to ipns and publishes the EXISTING cid', async () => {
		const pub = nodeHolding('https://pub.test', {mode: 'ipfs'});
		const result = await updateSite({
			id: ID,
			mode: 'ipns',
			targets: [targetWith(pub, 'tok-pub')],
			derived,
		});

		expect(result.success).toBe(true);
		expect(result.mode).toBe('ipns');
		expect(result.cid).toBe(CID);

		// The record points at the cid the node ALREADY held.
		const publishes = pub.requestsFor('name/publish');
		expect(publishes.length).toBe(1);
		expect(publishes[0].query.get('arg')).toBe(`/ipfs/${CID}`);
		expect(publishes[0].query.get('key')).toBe(ID);

		// And the stored mode now says so.
		expect(soleMetadataWrite(pub).mode).toBe('ipns');
	});

	it('NEVER imports, copies or removes content (the whole point of the verb)', async () => {
		const pub = nodeHolding('https://pub.test', {mode: 'ipfs'});
		await updateSite({
			id: ID,
			mode: 'ipns',
			targets: [targetWith(pub, 'tok-pub')],
			derived,
		});

		expect(pub.requestsFor('dag/import')).toHaveLength(0);
		expect(pub.requestsFor('files/cp')).toHaveLength(0);
		expect(pub.requestsFor('files/rm')).toHaveLength(0);
		expect(pub.requestsFor('files/mkdir')).toHaveLength(0);
		expect(pub.requestsFor('pin/add')).toHaveLength(0);
	});

	it('writes the ensName without disturbing mode or content', async () => {
		const pub = nodeHolding('https://pub.test', {mode: 'ipns'});
		await updateSite({
			id: ID,
			ensName: {kind: 'set', name: 'mysite.eth'},
			targets: [targetWith(pub, 'tok-pub')],
			derived,
		});

		const written = soleMetadataWrite(pub);
		expect(written.ensName).toBe('mysite.eth');
		// Omitted --set-mode PRESERVED the stored ipns (it did not demote).
		expect(written.mode).toBe('ipns');
		expect(pub.requestsFor('dag/import')).toHaveLength(0);
	});
});

describe('B1: a preserved mode is never resolved from a node that lacks the site', () => {
	it('REFUSES when the publisher does not hold the site, and writes nothing anywhere', async () => {
		// The drift case: A (publisher) missed the last deploy, B (replica) holds
		// the site stored as `ipns`. Before the fix this defaulted to `ipfs` and
		// STATED that demotion to B, silently unpublishing a live name.
		const pub = nodeWithoutSite('https://pub.test');
		const replica = nodeHolding('https://replica.test', {
			mode: 'ipns',
			ensName: 'mysite.eth',
		});

		await expect(
			updateSite({
				id: ID,
				// No `mode`: PRESERVE, which is exactly the dangerous path.
				keep: {kind: 'set', keep: 3},
				targets: [
					targetWith(pub, 'tok-pub', 'publisher'),
					targetWith(replica, 'tok-rep', 'replica'),
				],
				derived,
			}),
		).rejects.toBeInstanceOf(UpdateSiteMissingError);

		// Pre-flight: NOTHING was written to any node.
		expect(pub.requestsFor('files/write')).toHaveLength(0);
		expect(replica.requestsFor('files/write')).toHaveLength(0);
		expect(replica.requestsFor('name/publish')).toHaveLength(0);
	});

	it('the refusal names the site and the node, and points at a way forward', async () => {
		const pub = nodeWithoutSite('https://pub.test');
		const error = await updateSite({
			id: ID,
			targets: [targetWith(pub, 'tok-pub')],
			derived,
		}).catch((e: unknown) => e as UpdateSiteMissingError);

		expect(error).toBeInstanceOf(UpdateSiteMissingError);
		expect(error.message).toContain(ID);
		expect(error.message).toContain('https://pub.test');
		expect(error.message).toContain('pinnace deploy');
	});
});

describe('B2: an outage is never reported as an absence', () => {
	it('a down authority raises SiteContentUnreadableError, NOT "not deployed"', async () => {
		const pub = nodeDown('https://pub.test');
		const error = await updateSite({
			id: ID,
			targets: [targetWith(pub, 'tok-pub')],
			derived,
		}).catch((e: unknown) => e as Error);

		expect(error).toBeInstanceOf(SiteContentUnreadableError);
		expect(error).not.toBeInstanceOf(UpdateSiteMissingError);
		// It must say the node did not answer, not that the site is absent.
		expect(error.message).toContain('NOT the same as the site being absent');
		expect(pub.requestsFor('files/write')).toHaveLength(0);
	});

	it('a down NON-authority node fails only itself; the rest still update', async () => {
		const pub = nodeHolding('https://pub.test', {mode: 'ipns'});
		const replica = nodeDown('https://replica.test');

		const result = await updateSite({
			id: ID,
			ensName: {kind: 'set', name: 'mysite.eth'},
			targets: [
				targetWith(pub, 'tok-pub', 'publisher'),
				targetWith(replica, 'tok-rep', 'replica'),
			],
			derived,
		});

		// A non-empty success subset is still an overall success.
		expect(result.success).toBe(true);
		expect(result.ok.map((n) => n.baseUrl)).toEqual(['https://pub.test']);
		expect(result.failed).toHaveLength(1);
		expect(result.failed[0].baseUrl).toBe('https://replica.test');
		expect(result.failed[0].error).toBeInstanceOf(SiteContentUnreadableError);
	});
});

describe('S1: --set-keep is APPLIED, not merely recorded', () => {
	it('unpins the superseded builds beyond the keep count', async () => {
		const pub = nodeHolding('https://pub.test', {
			mode: 'ipfs',
			history: ['bafyOld1', 'bafyOld2', 'bafyOld3'],
		});

		const result = await updateSite({
			id: ID,
			keep: {kind: 'set', keep: 1},
			targets: [targetWith(pub, 'tok-pub')],
			derived,
		});

		// The two oldest are unpinned; the newest superseded build is kept.
		const unpinned = pub.requestsFor('pin/rm').map((r) => r.query.get('arg'));
		expect(unpinned).toEqual(['bafyOld2', 'bafyOld3']);

		// And the stored history is the one that SURVIVED.
		const written = soleMetadataWrite(pub);
		expect(written.history).toEqual(['bafyOld1']);
		expect(written.keep).toBe(1);
		expect(result.ok[0].pruned.map((p) => p.cid)).toEqual([
			'bafyOld2',
			'bafyOld3',
		]);
	});

	it('a site with no keep policy unpins nothing and keeps its whole history', async () => {
		const history = ['bafyOld1', 'bafyOld2', 'bafyOld3'];
		const pub = nodeHolding('https://pub.test', {mode: 'ipfs', history});

		await updateSite({
			id: ID,
			ensName: {kind: 'set', name: 'mysite.eth'},
			targets: [targetWith(pub, 'tok-pub')],
			derived,
		});

		expect(pub.requestsFor('pin/rm')).toHaveLength(0);
		expect(soleMetadataWrite(pub).history).toEqual(history);
	});

	it('never unpins a cid another site currently resolves to', async () => {
		// `other` resolves to bafyOld2, which is also in this site's history.
		const pub = nodeHolding('https://pub.test', {
			mode: 'ipfs',
			history: ['bafyOld1', 'bafyOld2'],
		});
		pub.onArg('files/ls', SITES, {
			json: {Entries: [{Name: ID}, {Name: 'other'}]},
		});
		pub.onArg('files/stat', `${SITES}/other/content`, {
			json: {Hash: 'bafyOld2'},
		});

		await updateSite({
			id: ID,
			keep: {kind: 'set', keep: 0},
			targets: [targetWith(pub, 'tok-pub')],
			derived,
		});

		const unpinned = pub.requestsFor('pin/rm').map((r) => r.query.get('arg'));
		expect(unpinned).toEqual(['bafyOld1']);
		// The protected cid stays listed, because it is still held.
		expect(soleMetadataWrite(pub).history).toContain('bafyOld2');
	});
});

describe('the fan-out resolves ONE mode and states it to every node', () => {
	it("a replica's stored mode never decides the run; the publisher's does", async () => {
		const pub = nodeHolding('https://pub.test', {mode: 'ipns'});
		const replica = nodeHolding('https://replica.test', {mode: 'ipfs'});

		const result = await updateSite({
			id: ID,
			targets: [
				targetWith(pub, 'tok-pub', 'publisher'),
				targetWith(replica, 'tok-rep', 'replica'),
			],
			derived,
		});

		expect(result.mode).toBe('ipns');
		// The replica is STATED the resolved mode, overwriting its stale `ipfs`.
		expect(soleMetadataWrite(replica).mode).toBe('ipns');
		expect(soleMetadataWrite(pub).mode).toBe('ipns');
	});

	it('the replica writes metadata but NEVER signs', async () => {
		const pub = nodeHolding('https://pub.test', {mode: 'ipns'});
		const replica = nodeHolding('https://replica.test', {mode: 'ipns'});

		const result = await updateSite({
			id: ID,
			mode: 'ipns',
			targets: [
				targetWith(pub, 'tok-pub', 'publisher'),
				targetWith(replica, 'tok-rep', 'replica'),
			],
			derived,
		});

		expect(replica.requestsFor('name/publish')).toHaveLength(0);
		expect(replica.requestsFor('key/import')).toHaveLength(0);
		expect(pub.requestsFor('name/publish')).toHaveLength(1);
		expect(
			result.ok.find((n) => n.baseUrl === replica.baseUrl)?.published,
		).toBe(false);
	});

	it('each node is reached with its OWN bearer token', async () => {
		const pub = nodeHolding('https://pub.test', {mode: 'ipfs'});
		const replica = nodeHolding('https://replica.test', {mode: 'ipfs'});

		await updateSite({
			id: ID,
			targets: [
				targetWith(pub, 'tok-pub', 'publisher'),
				targetWith(replica, 'tok-rep', 'replica'),
			],
			derived,
		});

		expect(pub.requestsFor('files/write')[0].headers['authorization']).toBe(
			'Bearer tok-pub',
		);
		expect(replica.requestsFor('files/write')[0].headers['authorization']).toBe(
			'Bearer tok-rep',
		);
	});
});

describe('B3: the reported cid is the one the name resolves to', () => {
	it('reports the AUTHORITY cid and NAMES the nodes holding another build', async () => {
		// The replica sorts first in `targets` but holds a stale build.
		const replica = nodeHolding(
			'https://replica.test',
			{mode: 'ipns'},
			{cid: 'bafyStaleBuild'},
		);
		const pub = nodeHolding('https://pub.test', {mode: 'ipns'});

		const result = await updateSite({
			id: ID,
			mode: 'ipns',
			targets: [
				targetWith(replica, 'tok-rep', 'replica'),
				targetWith(pub, 'tok-pub', 'publisher'),
			],
			derived,
		});

		// NOT ok[0].cid (which would be the stale replica's).
		expect(result.cid).toBe(CID);
		expect(pub.requestsFor('name/publish')[0].query.get('arg')).toBe(
			`/ipfs/${CID}`,
		);
		expect(result.diverged).toEqual([
			{baseUrl: 'https://replica.test', cid: 'bafyStaleBuild'},
		]);
	});

	it('reports no divergence when the fan-out agrees', async () => {
		const pub = nodeHolding('https://pub.test', {mode: 'ipfs'});
		const replica = nodeHolding('https://replica.test', {mode: 'ipfs'});

		const result = await updateSite({
			id: ID,
			targets: [
				targetWith(pub, 'tok-pub', 'publisher'),
				targetWith(replica, 'tok-rep', 'replica'),
			],
			derived,
		});

		expect(result.diverged).toEqual([]);
	});
});

describe('the ipns pre-flight refusals, all before anything is written', () => {
	it('refuses a resolved ipns mode with no publisher among the targets', async () => {
		const replica = nodeHolding('https://replica.test', {mode: 'ipns'});

		await expect(
			updateSite({
				id: ID,
				mode: 'ipns',
				targets: [targetWith(replica, 'tok-rep', 'replica')],
				derived,
			}),
		).rejects.toBeInstanceOf(UpdatePublisherRequiredError);

		expect(replica.requestsFor('files/write')).toHaveLength(0);
	});

	it('refuses when the publisher holds no key and no derived key was given', async () => {
		const pub = nodeHolding('https://pub.test', {mode: 'ipfs'}, {keys: []});

		await expect(
			updateSite({
				id: ID,
				mode: 'ipns',
				targets: [targetWith(pub, 'tok-pub')],
				// no `derived`
			}),
		).rejects.toBeInstanceOf(UpdateDerivedKeyRequiredError);

		expect(pub.requestsFor('files/write')).toHaveLength(0);
		expect(pub.requestsFor('name/publish')).toHaveLength(0);
	});

	it('refuses a bare --set-ens-name on a non-.eth id before touching a node', async () => {
		const pub = nodeHolding('https://pub.test', {mode: 'ipfs'});

		await expect(
			updateSite({
				id: ID, // 'mysite', not '.eth'
				ensName: {kind: 'infer'},
				targets: [targetWith(pub, 'tok-pub')],
				derived,
			}),
		).rejects.toBeInstanceOf(EnsNameInferenceError);

		expect(pub.requests).toHaveLength(0);
	});

	it('refuses when a PRESERVED mode cannot be read from a reachable authority', async () => {
		// The wrapper lists metadata.json, but reading it fails: an OUTAGE, not an
		// absence, so the write is refused rather than resolved from an error.
		const pub = nodeHolding('https://pub.test', {mode: 'ipns'});
		pub.onArg('files/read', `${SITES}/${ID}/metadata.json`, {
			status: 500,
			text: 'boom',
		});

		await expect(
			updateSite({
				id: ID,
				targets: [targetWith(pub, 'tok-pub')],
				derived,
			}),
		).rejects.toBeInstanceOf(SiteMetadataUnreadableError);

		expect(pub.requestsFor('files/write')).toHaveLength(0);
	});
});

describe('key provisioning on the publisher', () => {
	it('imports the derived key when the publisher holds none, then publishes', async () => {
		const pub = nodeHolding('https://pub.test', {mode: 'ipfs'}, {keys: []});
		pub.on('key/import', {json: {Name: ID, Id: IPNS}});

		const result = await updateSite({
			id: ID,
			mode: 'ipns',
			targets: [targetWith(pub, 'tok-pub')],
			derived,
		});

		expect(pub.requestsFor('key/import')).toHaveLength(1);
		expect(pub.requestsFor('name/publish')).toHaveLength(1);
		// The key is DERIVED, never invented.
		expect(pub.requestsFor('key/gen')).toHaveLength(0);
		expect(result.ok[0].ipns).toBe(IPNS);
	});

	it('does not re-import a key the publisher already holds (the CI path)', async () => {
		const pub = nodeHolding('https://pub.test', {mode: 'ipns'});

		// No `derived` at all: a publisher that already holds the key needs none.
		const result = await updateSite({
			id: ID,
			mode: 'ipns',
			targets: [targetWith(pub, 'tok-pub')],
		});

		expect(pub.requestsFor('key/import')).toHaveLength(0);
		// Probed ONCE in the pre-flight and reused by the publish path.
		expect(pub.requestsFor('key/list')).toHaveLength(1);
		expect(result.ok[0].ipns).toBe(IPNS);
		expect(result.success).toBe(true);
	});
});

describe('partial failure and the honest empty report', () => {
	it('a site missing on one of two nodes still succeeds overall', async () => {
		const pub = nodeHolding('https://pub.test', {mode: 'ipfs'});
		const replica = nodeWithoutSite('https://replica.test');

		const result = await updateSite({
			id: ID,
			targets: [
				targetWith(pub, 'tok-pub', 'publisher'),
				targetWith(replica, 'tok-rep', 'replica'),
			],
			derived,
		});

		expect(result.success).toBe(true);
		expect(result.ok).toHaveLength(1);
		expect(result.failed).toHaveLength(1);
		expect(result.failed[0].error.message).toContain('has no content on');
		// The node that lacks the site was not written to.
		expect(replica.requestsFor('files/write')).toHaveLength(0);
	});

	it('preserves each node\u2019s OWN ensName when the intent is preserve', async () => {
		const pub = nodeHolding('https://pub.test', {
			mode: 'ipfs',
			ensName: 'pub.eth',
		});
		const replica = nodeHolding('https://replica.test', {
			mode: 'ipfs',
			ensName: '', // the opt-out, which must survive verbatim
		});

		await updateSite({
			id: ID,
			mode: 'ipns',
			targets: [
				targetWith(pub, 'tok-pub', 'publisher'),
				targetWith(replica, 'tok-rep', 'replica'),
			],
			derived,
		});

		expect(soleMetadataWrite(pub).ensName).toBe('pub.eth');
		// `""` is NOT coerced to absent: it is the three-valued opt-out.
		expect(soleMetadataWrite(replica).ensName).toBe('');
	});
});
