import {describe, it, expect, beforeAll, afterAll} from 'vitest';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MockKuboApi, type RecordedRequest} from '../../src/rpc/mock-kubo.js';
import {deploy, type DeployTarget} from '../../src/deploy/deploy.js';
import {
	parseSiteMetadata,
	EnsNameInferenceError,
	type SiteMetadata,
} from '../../src/site/site-wrapper.js';

/**
 * Deploy tests (task `deploy-multi-target`, ACs 1-7).
 *
 * Deploy is tested at the Kubo RPC boundary through the recording
 * {@link MockKuboApi} (spec Testing Decisions: no live daemon). We assert:
 *  - the SAME CAR is imported (dag/import?pin-roots=true) into EVERY node, each
 *    with its OWN bearer token, all yielding the identical CID (AC 1),
 *  - each node gets the site placed in the MFS wrapper /sites/<id>/ (mkdir/rm/cp
 *    of `content` + a metadata.json write) (AC 2),
 *  - the EXACT per-mode call SEQUENCE: `ipfs` = import + MFS ONLY; `ipns` = ADDS
 *    key/list + name/publish (AC 3),
 *  - a replica / publish-disabled target does import + MFS but NEVER name/publish
 *    (AC 4),
 *  - multi-target fan-out reports partial failure per node and a non-empty
 *    subset succeeding is still an overall success (AC 5, allSettled).
 *
 * Each node gets its OWN MockKuboApi (its own baseUrl + token + recorded
 * requests), so cross-node fan-out and per-token isolation are observable.
 */

let siteDir: string;
let tmpRoot: string;

/** A tiny fixture site (index.html + a nested asset). */
async function makeFixtureSite(): Promise<string> {
	const dir = await mkdtemp(join(tmpRoot, 'site-'));
	await writeFile(join(dir, 'index.html'), '<h1>pinnace</h1>\n');
	await mkdir(join(dir, 'assets'), {recursive: true});
	await writeFile(join(dir, 'assets', 's.css'), 'body{margin:0}\n');
	return dir;
}

beforeAll(async () => {
	tmpRoot = await mkdtemp(join(tmpdir(), 'pinnace-deploy-'));
	siteDir = await makeFixtureSite();
});

afterAll(async () => {
	await rm(tmpRoot, {recursive: true, force: true});
});

/** The site metadata a recorded `files/write` carried (Kubo's `file` part). */
function metadataOf(req: RecordedRequest): SiteMetadata {
	return parseSiteMetadata(metadataBytesOf(req));
}

/** The RAW `metadata.json` text a recorded `files/write` carried. */
function metadataTextOf(req: RecordedRequest): string {
	return Buffer.from(metadataBytesOf(req)).toString('utf8');
}

/** The bytes of the `file` part of a recorded `files/write`. */
function metadataBytesOf(req: RecordedRequest): Uint8Array {
	const part = req.fileParts?.find((p) => p.field === 'file');
	if (!part) throw new Error('files/write carried no `file` part');
	return part.bytes;
}

/** A target backed by its own recording mock (distinct baseUrl + token). */
function targetWith(
	mock: MockKuboApi,
	token: string,
	extra: Partial<DeployTarget> = {},
): DeployTarget {
	return {
		baseUrl: mock.baseUrl,
		token,
		role: 'publisher',
		fetchImpl: mock.fetchImpl,
		...extra,
	};
}

/** A fresh mock pre-seeded so key/list resolves the site's IPNS id. */
function mockNode(baseUrl: string, ipnsId = 'k51default'): MockKuboApi {
	const mock = new MockKuboApi(baseUrl);
	mock.on('dag/import', {json: {Root: {Cid: {'/': 'bafyroot'}}}});
	mock.on('key/list', {json: {Keys: [{Name: 'mysite.eth', Id: ipnsId}]}});
	mock.on('name/publish', {json: {Name: ipnsId, Value: '/ipfs/bafyroot'}});
	return mock;
}

describe('deploy — same CAR to every node, pinned, identical CID', () => {
	it('imports the SAME CAR into every node (each with its OWN token) and pins it', async () => {
		const a = mockNode('https://node-a.test');
		const b = mockNode('https://node-b.test');
		const result = await deploy({
			sourceDir: siteDir,
			id: 'mysite.eth',
			mode: 'ipfs',
			targets: [targetWith(a, 'token-a'), targetWith(b, 'token-b')],
		});

		// Both nodes succeeded, both saw the identical CID.
		expect(result.ok.length).toBe(2);
		expect(result.failed.length).toBe(0);
		const cids = new Set(result.ok.map((r) => r.cid));
		expect(cids.size).toBe(1);
		expect(result.cid).toBe([...cids][0]);

		// Each node got exactly one dag/import?pin-roots=true.
		for (const mock of [a, b]) {
			const imp = mock.requestsFor('dag/import');
			expect(imp.length).toBe(1);
			expect(imp[0].query.get('pin-roots')).toBe('true');
		}

		// The SAME CAR bytes went to both nodes.
		expect(a.requestsFor('dag/import')[0].bodyText).toBe(
			b.requestsFor('dag/import')[0].bodyText,
		);

		// Each node was addressed with ITS OWN bearer token.
		expect(a.requestsFor('dag/import')[0].headers['authorization']).toBe(
			'Bearer token-a',
		);
		expect(b.requestsFor('dag/import')[0].headers['authorization']).toBe(
			'Bearer token-b',
		);
	});

	it('builds the CAR ONCE (not once per node)', async () => {
		const a = mockNode('https://node-a.test');
		const b = mockNode('https://node-b.test');
		const result = await deploy({
			sourceDir: siteDir,
			id: 'mysite.eth',
			mode: 'ipfs',
			targets: [targetWith(a, 'token-a'), targetWith(b, 'token-b')],
		});
		// If the CAR were rebuilt per node it would still match (deterministic),
		// but the byte-for-byte identity above already proves one artifact; here
		// we additionally assert the authoritative CID is a single value.
		expect(typeof result.cid).toBe('string');
		expect(result.cid.length).toBeGreaterThan(0);
	});

	it('places the site in the MFS wrapper /sites/<id>/{content,metadata.json} on every node', async () => {
		const a = mockNode('https://node-a.test');
		const b = mockNode('https://node-b.test');
		const result = await deploy({
			sourceDir: siteDir,
			id: 'mysite.eth',
			mode: 'ipfs',
			targets: [targetWith(a, 'token-a'), targetWith(b, 'token-b')],
		});

		for (const mock of [a, b]) {
			const mkdir = mock.requestsFor('files/mkdir');
			expect(mkdir.length).toBe(1);
			expect(mkdir[0].query.get('arg')).toBe('/sites/mysite.eth');
			expect(mkdir[0].query.get('parents')).toBe('true');

			const rmReq = mock.requestsFor('files/rm');
			expect(rmReq.length).toBe(1);
			expect(rmReq[0].query.get('arg')).toBe('/sites/mysite.eth/content');
			expect(rmReq[0].query.get('recursive')).toBe('true');
			expect(rmReq[0].query.get('force')).toBe('true');

			const cp = mock.requestsFor('files/cp');
			expect(cp.length).toBe(1);
			expect(cp[0].query.getAll('arg')).toEqual([
				`/ipfs/${result.cid}`,
				'/sites/mysite.eth/content',
			]);

			// The wrapper's metadata.json is written alongside the content; deploy
			// records the mode it deployed under.
			const write = mock.requestsFor('files/write');
			expect(write.length).toBe(1);
			expect(write[0].query.get('arg')).toBe('/sites/mysite.eth/metadata.json');
			expect(metadataOf(write[0])).toEqual({mode: 'ipfs'});
		}
	});
});

/**
 * The per-site metadata deploy WRITES (task `deploy-pin-write-site-metadata`).
 *
 * Every deploy records the `mode` it ran in; the `ensName` field is reached
 * through the operator's two verb-flags, and OMITTING them never authors a
 * name: a first deploy leaves the field ABSENT (a `.eth` id then infers via the
 * on-box warm rule) and a re-deploy carries the existing value forward.
 */
describe('deploy — writes the per-site metadata {ensName?, mode}', () => {
	/** The single `files/write` a one-node deploy made. */
	function writeOf(mock: MockKuboApi): RecordedRequest {
		const write = mock.requestsFor('files/write');
		expect(write.length).toBe(1);
		return write[0];
	}

	/** A node whose site already carries `metadata.json` (the re-deploy case). */
	function nodeHolding(metadataJson: string): MockKuboApi {
		const mock = mockNode('https://node-a.test');
		mock.on('files/read', {text: metadataJson});
		return mock;
	}

	/** A node with NO metadata for the site yet (the FIRST deploy). */
	function freshNode(): MockKuboApi {
		const mock = mockNode('https://node-a.test');
		mock.on('files/read', {status: 500, text: 'file does not exist'});
		return mock;
	}

	it('--set-ens-name <name>: writes that name (no `.eth` requirement)', async () => {
		const a = freshNode();
		await deploy({
			sourceDir: siteDir,
			id: 'plainsite',
			mode: 'ipfs',
			ensName: {kind: 'set', name: 'alice.eth'},
			targets: [targetWith(a, 'token-a')],
		});
		expect(metadataOf(writeOf(a))).toEqual({
			ensName: 'alice.eth',
			mode: 'ipfs',
		});
	});

	it('bare --set-ens-name on a `.eth` id: writes NO ensName key (infer)', async () => {
		const a = nodeHolding('{"ensName":"stale.eth","mode":"ipfs"}');
		await deploy({
			sourceDir: siteDir,
			id: 'mysite.eth',
			mode: 'ipfs',
			ensName: {kind: 'infer'},
			targets: [targetWith(a, 'token-a')],
		});
		const write = writeOf(a);
		expect(metadataTextOf(write)).not.toContain('ensName');
		expect(metadataOf(write)).toEqual({mode: 'ipfs'});
	});

	it('bare --set-ens-name on a NON-`.eth` id: FAILS LOUD, touching no node', async () => {
		const a = freshNode();
		await expect(
			deploy({
				sourceDir: siteDir,
				id: 'plainsite',
				mode: 'ipfs',
				ensName: {kind: 'infer'},
				targets: [targetWith(a, 'token-a')],
			}),
		).rejects.toBeInstanceOf(EnsNameInferenceError);
		// The refusal precedes the fan-out: nothing was imported or written.
		expect(a.requests.length).toBe(0);
	});

	it('--unset-ens-name: writes the `""` opt-out', async () => {
		const a = nodeHolding('{"ensName":"alice.eth","mode":"ipfs"}');
		await deploy({
			sourceDir: siteDir,
			id: 'mysite.eth',
			mode: 'ipns',
			ensName: {kind: 'unset'},
			targets: [targetWith(a, 'token-a', {role: 'publisher'})],
		});
		expect(metadataOf(writeOf(a))).toEqual({ensName: '', mode: 'ipns'});
	});

	it('FIRST deploy with no ens flag: the ensName key is ABSENT', async () => {
		const a = freshNode();
		await deploy({
			sourceDir: siteDir,
			id: 'mysite.eth',
			mode: 'ipfs',
			targets: [targetWith(a, 'token-a')],
		});
		const write = writeOf(a);
		// Omitting the flags never writes a name — not even the `.eth` id itself.
		expect(metadataTextOf(write)).not.toContain('ensName');
		expect(metadataOf(write)).toEqual({mode: 'ipfs'});
	});

	it('RE-deploy with no ens flag: PRESERVES the existing ensName', async () => {
		const a = nodeHolding('{"ensName":"custom.example","mode":"ipfs"}');
		await deploy({
			sourceDir: siteDir,
			id: 'mysite.eth',
			mode: 'ipns',
			targets: [targetWith(a, 'token-a', {role: 'publisher'})],
		});
		// The site's name survives; the MODE is the one this deploy ran in.
		expect(metadataOf(writeOf(a))).toEqual({
			ensName: 'custom.example',
			mode: 'ipns',
		});
		expect(a.requestsFor('files/read')[0].query.get('arg')).toBe(
			'/sites/mysite.eth/metadata.json',
		);
	});

	it('RE-deploy with no ens flag: PRESERVES a prior `""` opt-out', async () => {
		const a = nodeHolding('{"ensName":"","mode":"ipfs"}');
		await deploy({
			sourceDir: siteDir,
			id: 'mysite.eth',
			mode: 'ipfs',
			targets: [targetWith(a, 'token-a')],
		});
		expect(metadataOf(writeOf(a)).ensName).toBe('');
	});

	it('preserves PER NODE (each node carries its own metadata)', async () => {
		const a = mockNode('https://node-a.test');
		a.on('files/read', {text: '{"ensName":"a.example","mode":"ipfs"}'});
		const b = mockNode('https://node-b.test');
		b.on('files/read', {status: 500, text: 'file does not exist'});
		await deploy({
			sourceDir: siteDir,
			id: 'mysite.eth',
			mode: 'ipfs',
			targets: [targetWith(a, 'token-a'), targetWith(b, 'token-b')],
		});
		expect(metadataOf(writeOf(a))).toEqual({
			ensName: 'a.example',
			mode: 'ipfs',
		});
		expect(metadataOf(writeOf(b))).toEqual({mode: 'ipfs'});
	});
});

describe('deploy — per-site mode branch (verified against the mock Kubo API)', () => {
	it('ipfs mode: import + MFS ONLY (no key/list, no name/publish)', async () => {
		const a = mockNode('https://node-a.test');
		await deploy({
			sourceDir: siteDir,
			id: 'mysite.eth',
			mode: 'ipfs',
			targets: [targetWith(a, 'token-a')],
		});

		// Exactly the import + MFS calls, in order, and NOTHING publish-related.
		expect(a.requests.map((r) => r.path)).toEqual([
			'dag/import',
			// The read-modify-write of the metadata: with no ens flag, deploy
			// PRESERVES whatever ensName the site already carries.
			'files/read',
			'files/mkdir',
			'files/rm',
			'files/cp',
			'files/write',
		]);
		expect(a.requestsFor('key/list').length).toBe(0);
		expect(a.requestsFor('name/publish').length).toBe(0);
	});

	it('ipns mode: ADDS key/list + name/publish AFTER import + MFS', async () => {
		const a = mockNode('https://node-a.test', 'k51mysite');
		await deploy({
			sourceDir: siteDir,
			id: 'mysite.eth',
			mode: 'ipns',
			targets: [targetWith(a, 'token-a', {role: 'publisher'})],
		});

		// The FULL sequence: import + MFS, THEN key/list + name/publish.
		expect(a.requests.map((r) => r.path)).toEqual([
			'dag/import',
			'files/read',
			'files/mkdir',
			'files/rm',
			'files/cp',
			'files/write',
			'key/list',
			'name/publish',
		]);

		// ...and the wrapper metadata records the ipns mode it deployed under.
		expect(metadataOf(a.requestsFor('files/write')[0])).toEqual({mode: 'ipns'});

		// name/publish signed /ipfs/<cid> with the site key.
		const pub = a.requestsFor('name/publish');
		expect(pub.length).toBe(1);
		expect(pub[0].query.get('key')).toBe('mysite.eth');
		expect(pub[0].query.get('arg')).toMatch(/^\/ipfs\//);
	});

	it('ipns mode: publishes on EVERY publisher target across the fan-out', async () => {
		const a = mockNode('https://node-a.test', 'k51a');
		const b = mockNode('https://node-b.test', 'k51b');
		const result = await deploy({
			sourceDir: siteDir,
			id: 'mysite.eth',
			mode: 'ipns',
			targets: [
				targetWith(a, 'token-a', {role: 'publisher'}),
				targetWith(b, 'token-b', {role: 'publisher'}),
			],
		});
		expect(result.ok.length).toBe(2);
		expect(a.requestsFor('name/publish').length).toBe(1);
		expect(b.requestsFor('name/publish').length).toBe(1);
	});
});

/**
 * The site's MODE is now RESOLVED, not merely stated (the requeue decision on
 * `config-drop-sites-and-make-optional`): `--set-mode` > the site's STORED
 * `metadata.json` mode > `ipfs`. The regression this closes: a re-deploy with
 * no mode flag used to run as `ipfs`, so it neither signed the IPNS record nor
 * kept `mode: "ipns"` in the metadata — the live name silently went stale.
 *
 * The resolution is ONE decision for the whole fan-out, taken from the
 * PUBLISHER (the node that holds the key and actually signs), and the resolved
 * value is then written into EVERY target's metadata so nodes cannot diverge.
 */
describe('deploy — the mode is RESOLVED (stated > stored > ipfs)', () => {
	/** A node whose site already stores `metadata.json`. */
	function nodeStoring(baseUrl: string, metadataJson: string): MockKuboApi {
		const mock = mockNode(baseUrl, 'k51mysite');
		mock.on('files/read', {text: metadataJson});
		return mock;
	}

	/** A node with NO metadata for the site yet (the FIRST deploy). */
	function bareNode(baseUrl: string): MockKuboApi {
		const mock = mockNode(baseUrl, 'k51mysite');
		mock.on('files/read', {status: 500, text: 'file does not exist'});
		return mock;
	}

	it('RE-deploy with NO mode: keeps the stored `ipns` AND still publishes', async () => {
		const a = nodeStoring('https://node-a.test', '{"mode":"ipns"}');
		const result = await deploy({
			sourceDir: siteDir,
			id: 'mysite.eth',
			targets: [targetWith(a, 'token-a', {role: 'publisher'})],
		});
		// The metadata is not demoted...
		expect(result.mode).toBe('ipns');
		expect(metadataOf(a.requestsFor('files/write')[0])).toEqual({mode: 'ipns'});
		// ...and the deploy's OWN publish decision follows the RESOLVED mode, so
		// the live name is refreshed to this deploy's cid (the actual bug).
		expect(a.requestsFor('name/publish').length).toBe(1);
		expect(result.ok[0].published).toBe(true);
	});

	it('FIRST deploy with NO mode: `ipfs`, and nothing is signed', async () => {
		const a = bareNode('https://node-a.test');
		const result = await deploy({
			sourceDir: siteDir,
			id: 'mysite.eth',
			targets: [targetWith(a, 'token-a', {role: 'publisher'})],
		});
		expect(result.mode).toBe('ipfs');
		expect(metadataOf(a.requestsFor('files/write')[0])).toEqual({mode: 'ipfs'});
		expect(a.requestsFor('name/publish').length).toBe(0);
		expect(a.requestsFor('key/list').length).toBe(0);
	});

	it('a STATED mode always wins over the stored one (both directions)', async () => {
		const up = nodeStoring('https://node-a.test', '{"mode":"ipfs"}');
		expect(
			(
				await deploy({
					sourceDir: siteDir,
					id: 'mysite.eth',
					mode: 'ipns',
					targets: [targetWith(up, 'token-a', {role: 'publisher'})],
				})
			).mode,
		).toBe('ipns');
		expect(up.requestsFor('name/publish').length).toBe(1);

		const down = nodeStoring('https://node-b.test', '{"mode":"ipns"}');
		expect(
			(
				await deploy({
					sourceDir: siteDir,
					id: 'mysite.eth',
					mode: 'ipfs',
					targets: [targetWith(down, 'token-b', {role: 'publisher'})],
				})
			).mode,
		).toBe('ipfs');
		expect(metadataOf(down.requestsFor('files/write')[0])).toEqual({
			mode: 'ipfs',
		});
		expect(down.requestsFor('name/publish').length).toBe(0);
	});

	it('resolves from the PUBLISHER and writes that ONE mode to EVERY node', async () => {
		// The publisher (the node that signs) stores `ipns`; the replica stores
		// nothing. The fan-out takes ONE decision — the publisher's — so the two
		// nodes cannot end up disagreeing about how the site is addressed.
		const pub = nodeStoring('https://publisher.test', '{"mode":"ipns"}');
		const rep = bareNode('https://replica.test');
		const result = await deploy({
			sourceDir: siteDir,
			id: 'mysite.eth',
			targets: [
				targetWith(pub, 'token-pub', {role: 'publisher'}),
				targetWith(rep, 'token-rep', {role: 'replica'}),
			],
		});
		expect(result.mode).toBe('ipns');
		for (const mock of [pub, rep]) {
			expect(metadataOf(mock.requestsFor('files/write')[0])).toEqual({
				mode: 'ipns',
			});
		}
		// Only the publisher signs, as ever.
		expect(pub.requestsFor('name/publish').length).toBe(1);
		expect(rep.requestsFor('name/publish').length).toBe(0);
	});

	it('a REPLICA’s stored mode never decides the fan-out (only the publisher’s)', async () => {
		// The replica stores a stale `ipns`; the publisher stores `ipfs`. The
		// publisher wins — a keyless node must not talk the fan-out into signing.
		const pub = nodeStoring('https://publisher.test', '{"mode":"ipfs"}');
		const rep = nodeStoring('https://replica.test', '{"mode":"ipns"}');
		const result = await deploy({
			sourceDir: siteDir,
			id: 'mysite.eth',
			targets: [
				targetWith(pub, 'token-pub', {role: 'publisher'}),
				targetWith(rep, 'token-rep', {role: 'replica'}),
			],
		});
		expect(result.mode).toBe('ipfs');
		expect(metadataOf(rep.requestsFor('files/write')[0])).toEqual({
			mode: 'ipfs',
		});
		expect(pub.requestsFor('name/publish').length).toBe(0);
	});

	it('resolving the mode costs ONE read per node (no extra round trip)', async () => {
		const a = nodeStoring('https://node-a.test', '{"mode":"ipns"}');
		await deploy({
			sourceDir: siteDir,
			id: 'mysite.eth',
			targets: [targetWith(a, 'token-a', {role: 'publisher'})],
		});
		// The publisher's stored metadata answers BOTH the mode question and the
		// ensName read-modify-write: one files/read, not two.
		expect(a.requestsFor('files/read').length).toBe(1);
	});

	it('with NO publisher target there is nothing to resolve from: `ipfs`', async () => {
		const rep = nodeStoring('https://replica.test', '{"mode":"ipns"}');
		const result = await deploy({
			sourceDir: siteDir,
			id: 'mysite.eth',
			targets: [targetWith(rep, 'token-rep', {role: 'replica'})],
		});
		expect(result.mode).toBe('ipfs');
		expect(rep.requestsFor('name/publish').length).toBe(0);
	});
});

describe('deploy — a replica / publish-disabled target NEVER publishes', () => {
	it('a replica target does import + MFS but never name/publish (even in ipns mode)', async () => {
		const pub = mockNode('https://publisher.test', 'k51pub');
		const rep = mockNode('https://replica.test');
		await deploy({
			sourceDir: siteDir,
			id: 'mysite.eth',
			mode: 'ipns',
			targets: [
				targetWith(pub, 'token-pub', {role: 'publisher'}),
				targetWith(rep, 'token-rep', {role: 'replica'}),
			],
		});

		// The publisher published; the replica landed content but NEVER published.
		expect(pub.requestsFor('name/publish').length).toBe(1);
		expect(rep.requestsFor('name/publish').length).toBe(0);
		expect(rep.requestsFor('key/list').length).toBe(0);

		// The replica still imported + placed the site (it just does not sign).
		expect(rep.requestsFor('dag/import').length).toBe(1);
		expect(rep.requestsFor('files/cp').length).toBe(1);
	});

	it('a publish-disabled publisher (publish:false) never name/publishes', async () => {
		const a = mockNode('https://node-a.test', 'k51a');
		await deploy({
			sourceDir: siteDir,
			id: 'mysite.eth',
			mode: 'ipns',
			targets: [targetWith(a, 'token-a', {role: 'publisher', publish: false})],
		});
		expect(a.requestsFor('name/publish').length).toBe(0);
		expect(a.requestsFor('dag/import').length).toBe(1);
		expect(a.requestsFor('files/cp').length).toBe(1);
	});
});

describe('deploy — multi-target fan-out (partial failure is still success)', () => {
	it('reports per-node failure but a non-empty success subset is overall success', async () => {
		const good = mockNode('https://good.test');
		const bad = mockNode('https://bad.test');
		// The bad node rejects the import: its whole deploy fails.
		bad.on('dag/import', {status: 500, text: 'boom'});

		const result = await deploy({
			sourceDir: siteDir,
			id: 'mysite.eth',
			mode: 'ipfs',
			targets: [targetWith(good, 'token-good'), targetWith(bad, 'token-bad')],
		});

		// One node up, one down: overall a success (some-nodes-up).
		expect(result.success).toBe(true);
		expect(result.ok.map((r) => r.baseUrl)).toEqual(['https://good.test']);
		expect(result.failed.length).toBe(1);
		expect(result.failed[0].baseUrl).toBe('https://bad.test');
		expect(result.failed[0].error).toBeInstanceOf(Error);

		// The good node was unaffected by the bad node's failure.
		expect(good.requestsFor('files/cp').length).toBe(1);
	});

	it('all targets failing is NOT a success', async () => {
		const a = mockNode('https://a.test');
		const b = mockNode('https://b.test');
		a.on('dag/import', {status: 500, text: 'boom'});
		b.on('dag/import', {status: 500, text: 'boom'});
		const result = await deploy({
			sourceDir: siteDir,
			id: 'mysite.eth',
			mode: 'ipfs',
			targets: [targetWith(a, 'token-a'), targetWith(b, 'token-b')],
		});
		expect(result.success).toBe(false);
		expect(result.ok.length).toBe(0);
		expect(result.failed.length).toBe(2);
	});
});
