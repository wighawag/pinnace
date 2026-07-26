import {describe, it, expect} from 'vitest';
import {KuboRpcClient} from '../../src/rpc/kubo-rpc-client.js';
import {MockKuboApi} from '../../src/rpc/mock-kubo.js';
import {
	siteContentPath,
	siteMetadataPath,
	siteWrapperPath,
	encodeSiteMetadata,
	parseSiteMetadata,
	readSiteMetadata,
	readSiteMetadataForWrite,
	resolveSiteMetadataToWrite,
	resolveEnsNameToWarm,
	assertEnsNameIntent,
	EnsNameInferenceError,
	SiteMetadataUnreadableError,
	DEFAULT_SITE_MODE,
	siteModeIntent,
	type EnsNameIntent,
	type SiteMetadata,
} from '../../src/site/site-wrapper.js';

/**
 * The MFS site WRAPPER layout + its metadata codec — the single place that
 * knows a site is `/sites/<id>/{content, metadata.json}`.
 *
 * The load-bearing assertion here is the THREE-VALUED `ensName`: a name, the
 * EMPTY string `""` (opt out of eth.limo warming), and ABSENT (infer from a
 * `.eth` id) must stay DISTINCT through encode + parse, in both directions —
 * the on-box warm rule resolves all three differently, so a codec that coerced
 * `""` to absent (or materialised an absent field) would silently change
 * behaviour. Absent/malformed metadata parses to `{}` (a site with no metadata
 * yet is normal, never a failure).
 */

function clientWith(mock: MockKuboApi, token = 'wrapper-token') {
	return new KuboRpcClient({
		baseUrl: mock.baseUrl,
		token,
		fetchImpl: mock.fetchImpl,
	});
}

/** The JSON text `encodeSiteMetadata` produced (what lands in MFS). */
function encodedText(metadata: SiteMetadata): string {
	return Buffer.from(encodeSiteMetadata(metadata)).toString('utf8');
}

/** Parse from a JSON string, as if it had been read back out of MFS. */
function parseText(text: string): SiteMetadata {
	return parseSiteMetadata(new Uint8Array(Buffer.from(text, 'utf8')));
}

describe('site wrapper layout — /sites/<id>/{content, metadata.json}', () => {
	it('addresses the content and the metadata INSIDE the wrapper dir', () => {
		expect(siteWrapperPath('/sites', 'alice.eth')).toBe('/sites/alice.eth');
		expect(siteContentPath('/sites', 'alice.eth')).toBe(
			'/sites/alice.eth/content',
		);
		expect(siteMetadataPath('/sites', 'alice.eth')).toBe(
			'/sites/alice.eth/metadata.json',
		);
	});

	it('honours a non-default sites dir', () => {
		expect(siteContentPath('/custom', 'bob')).toBe('/custom/bob/content');
		expect(siteMetadataPath('/custom', 'bob')).toBe(
			'/custom/bob/metadata.json',
		);
	});
});

describe('site metadata codec — {ensName?, mode} round-trip', () => {
	it('round-trips a full metadata record', () => {
		const metadata: SiteMetadata = {ensName: 'alice.eth', mode: 'ipns'};
		expect(parseSiteMetadata(encodeSiteMetadata(metadata))).toEqual(metadata);
	});

	it('writes human-readable JSON (what an operator reads on the box)', () => {
		const text = encodedText({ensName: 'alice.eth', mode: 'ipns'});
		expect(JSON.parse(text)).toEqual({ensName: 'alice.eth', mode: 'ipns'});
		expect(text).toContain('\n');
	});

	it('PRESERVES ensName: "" as distinct from absent (write side)', () => {
		// "" is the OPT-OUT: it must be WRITTEN as an explicit empty string...
		expect(JSON.parse(encodedText({ensName: '', mode: 'ipfs'}))).toEqual({
			ensName: '',
			mode: 'ipfs',
		});
		// ...while an absent (or explicitly undefined) ensName writes NO key, so
		// the on-box rule can still infer from a `.eth` id.
		expect(encodedText({mode: 'ipfs'})).not.toContain('ensName');
		expect(encodedText({ensName: undefined, mode: 'ipfs'})).not.toContain(
			'ensName',
		);
	});

	it('PRESERVES ensName: "" as distinct from absent (read side)', () => {
		const optedOut = parseText('{"ensName":"","mode":"ipfs"}');
		expect(optedOut.ensName).toBe('');
		expect('ensName' in optedOut).toBe(true);

		const inferring = parseText('{"mode":"ipfs"}');
		expect(inferring.ensName).toBeUndefined();
		expect('ensName' in inferring).toBe(false);
	});

	it('round-trips the empty-string opt-out through encode AND parse', () => {
		const optedOut = parseSiteMetadata(
			encodeSiteMetadata({ensName: '', mode: 'ipns'}),
		);
		expect(optedOut).toEqual({ensName: '', mode: 'ipns'});
		const inferring = parseSiteMetadata(encodeSiteMetadata({mode: 'ipns'}));
		expect(inferring).toEqual({mode: 'ipns'});
		expect('ensName' in inferring).toBe(false);
	});

	it('parses malformed / non-object / empty metadata as empty, never throwing', () => {
		for (const text of [
			'',
			'   ',
			'not json',
			'[]',
			'"a string"',
			'42',
			'null',
		])
			expect(parseText(text)).toEqual({});
	});

	it('ignores fields it does not understand and wrongly-typed ones', () => {
		expect(parseText('{"mode":"ipns","future":"whatever"}')).toEqual({
			mode: 'ipns',
		});
		expect(parseText('{"ensName":42,"mode":"sideways"}')).toEqual({});
	});
});

describe('readSiteMetadata — files/read of the wrapper metadata', () => {
	it('reads /sites/<id>/metadata.json and parses it', async () => {
		const mock = new MockKuboApi();
		mock.on('files/read', {text: '{"ensName":"alice.eth","mode":"ipns"}'});
		const metadata = await readSiteMetadata(
			clientWith(mock),
			'/sites',
			'alice.eth',
		);
		expect(metadata).toEqual({ensName: 'alice.eth', mode: 'ipns'});
		const read = mock.requestsFor('files/read');
		expect(read.length).toBe(1);
		expect(read[0].query.get('arg')).toBe('/sites/alice.eth/metadata.json');
	});

	it('yields empty metadata when the file does not exist (never throws)', async () => {
		const mock = new MockKuboApi();
		mock.on('files/read', {status: 500, text: 'file does not exist'});
		expect(await readSiteMetadata(clientWith(mock), '/sites', 'bob')).toEqual(
			{},
		);
	});

	it('absorbs an OUTAGE too — the conflation the DISCOVERY caller accepts', async () => {
		// A down / 401ing node is indistinguishable from a missing file here, and
		// that is DELIBERATE for discovery: one unreadable file must never sink the
		// warm/republish/status pass over the sites around it. The WRITE path does
		// NOT share this read (see the strict resolver below).
		const mock = new MockKuboApi();
		mock.on('files/read', {status: 401, text: 'unauthorized'});
		expect(await readSiteMetadata(clientWith(mock), '/sites', 'bob')).toEqual(
			{},
		);
	});
});

/**
 * The WRITE side of the three-valued `ensName`: what a `deploy`/`pin` actually
 * puts in `metadata.json` for each of the four operator intents (task
 * `deploy-pin-write-site-metadata`).
 *
 * `preserve` (both flags omitted) is the load-bearing one: it never authors a
 * name, so a FIRST write leaves the field absent (a `.eth` id then infers) and
 * a RE-write carries the existing value forward — including a prior `""`
 * opt-out, which a naive "absent means nothing to say" write would silently
 * wipe.
 */

/**
 * A mock whose `/sites/<id>/metadata.json` is LISTED by its wrapper and reads
 * back as `text`. Both halves matter on the write path: the listing is what
 * makes the file's presence (or absence) a POSITIVE fact rather than something
 * inferred from a read error.
 */
function mockHolding(text: string): MockKuboApi {
	const mock = new MockKuboApi();
	mock.on('files/ls', {json: {Entries: [{Name: 'content'}, {Name: METADATA}]}});
	mock.on('files/read', {text});
	return mock;
}

/**
 * A mock with NO metadata for the site: the wrapper lists no `metadata.json`
 * (the mock's default empty listing) and a read of it is Kubo's loud non-2xx.
 */
function mockWithoutMetadata(): MockKuboApi {
	const mock = new MockKuboApi();
	mock.on('files/read', {status: 500, text: 'file does not exist'});
	return mock;
}

/** The wrapper entry the write path looks for in a listing. */
const METADATA = 'metadata.json';

/**
 * A mock MFS: every directory in `dirs` LISTS the entry names given, every file
 * in `files` READS back its text, and any other path answers Kubo's loud
 * non-2xx for a path that is not there (which is what an MFS tree really does).
 */
function mockMfs(mfs: {
	dirs?: Record<string, string[]>;
	files?: Record<string, string>;
}): MockKuboApi {
	const mock = new MockKuboApi();
	mock.on('files/ls', {status: 500, text: 'file does not exist'});
	mock.on('files/read', {status: 500, text: 'file does not exist'});
	for (const [path, names] of Object.entries(mfs.dirs ?? {})) {
		mock.onArg('files/ls', path, {
			json: {Entries: names.map((Name) => ({Name}))},
		});
	}
	for (const [path, text] of Object.entries(mfs.files ?? {})) {
		mock.onArg('files/read', path, {text});
	}
	return mock;
}

/** A node that answers every MFS call with an outage (down, or a stale token). */
function mockOutage(status = 401, text = 'unauthorized'): MockKuboApi {
	const mock = new MockKuboApi();
	mock.on('files/ls', {status, text});
	mock.on('files/read', {status, text});
	return mock;
}

/** The `arg` of each `files/ls` the mock recorded, in order. */
function listedPaths(mock: MockKuboApi): Array<string | null> {
	return mock.requestsFor('files/ls').map((r) => r.query.get('arg'));
}

/** Resolve the metadata a write would carry for `id` under `intent`. */
function resolveFor(
	mock: MockKuboApi,
	id: string,
	ensName: EnsNameIntent,
): Promise<SiteMetadata> {
	return resolveSiteMetadataToWrite({
		client: clientWith(mock),
		sitesDir: '/sites',
		id,
		mode: {kind: 'set', mode: 'ipfs'},
		ensName,
	});
}

describe('resolveSiteMetadataToWrite — the four ensName intents', () => {
	it('set: writes the name verbatim (no .eth requirement on an explicit name)', async () => {
		const mock = mockWithoutMetadata();
		expect(
			await resolveFor(mock, 'blog', {kind: 'set', name: 'alice.eth'}),
		).toEqual({ensName: 'alice.eth', mode: 'ipfs'});
		// An explicit name is the operator NAMING the gateway to warm; neither the
		// id nor the name has to be `.eth`.
		expect(
			await resolveFor(mock, 'blog', {kind: 'set', name: 'alice'}),
		).toEqual({ensName: 'alice', mode: 'ipfs'});
	});

	it('infer (bare set): leaves the key ABSENT on a `.eth` id', async () => {
		const resolved = await resolveFor(
			mockHolding('{"ensName":"old.eth"}'),
			'a.eth',
			{
				kind: 'infer',
			},
		);
		expect(resolved).toEqual({mode: 'ipfs'});
		expect('ensName' in resolved).toBe(false);
	});

	it('infer (bare set): FAILS LOUD on a non-`.eth` id (nothing to infer)', async () => {
		await expect(
			resolveFor(mockWithoutMetadata(), 'blog', {kind: 'infer'}),
		).rejects.toBeInstanceOf(EnsNameInferenceError);
		// ...and the same refusal is available BEFORE any node is touched.
		expect(() => assertEnsNameIntent({kind: 'infer'}, 'blog')).toThrow(
			EnsNameInferenceError,
		);
		expect(() => assertEnsNameIntent({kind: 'infer'}, 'a.eth')).not.toThrow();
		// The other intents never carry the `.eth` requirement.
		expect(() =>
			assertEnsNameIntent({kind: 'set', name: 'alice.eth'}, 'blog'),
		).not.toThrow();
		expect(() => assertEnsNameIntent({kind: 'unset'}, 'blog')).not.toThrow();
		expect(() => assertEnsNameIntent({kind: 'preserve'}, 'blog')).not.toThrow();
	});

	it('unset: writes the `""` opt-out (never warm, even a `.eth` id)', async () => {
		const resolved = await resolveFor(mockWithoutMetadata(), 'a.eth', {
			kind: 'unset',
		});
		expect(resolved).toEqual({ensName: '', mode: 'ipfs'});
		expect(resolved.ensName).toBe('');
	});

	it('preserve: carries an existing name forward (read-modify-write)', async () => {
		const mock = mockHolding('{"ensName":"kept.eth","mode":"ipns"}');
		expect(await resolveFor(mock, 'blog', {kind: 'preserve'})).toEqual({
			ensName: 'kept.eth',
			// A STATED mode wins over the stored one (here `ipfs` was stated).
			mode: 'ipfs',
		});
		expect(mock.requestsFor('files/read')[0].query.get('arg')).toBe(
			'/sites/blog/metadata.json',
		);
	});

	it('preserve: carries a prior `""` opt-out forward (never silently re-warms)', async () => {
		const resolved = await resolveFor(
			mockHolding('{"ensName":"","mode":"ipfs"}'),
			'a.eth',
			{kind: 'preserve'},
		);
		expect(resolved.ensName).toBe('');
	});

	it('preserve: stays ABSENT when the site has no metadata yet (first write)', async () => {
		const resolved = await resolveFor(mockWithoutMetadata(), 'a.eth', {
			kind: 'preserve',
		});
		expect(resolved).toEqual({mode: 'ipfs'});
		// Omitting the flags NEVER writes a name — not even the `.eth` id itself:
		// the on-box warm rule infers it from the absent field.
		expect('ensName' in resolved).toBe(false);
	});

	it('preserve is the DEFAULT when the caller states no intent', async () => {
		const mock = mockHolding('{"ensName":"kept.eth"}');
		expect(
			await resolveSiteMetadataToWrite({
				client: clientWith(mock),
				sitesDir: '/sites',
				id: 'blog',
				mode: {kind: 'set', mode: 'ipns'},
			}),
		).toEqual({ensName: 'kept.eth', mode: 'ipns'});
	});

	it('reads the existing metadata ONLY when preserving (the other intents are total)', async () => {
		for (const intent of [
			{kind: 'set', name: 'alice.eth'},
			{kind: 'unset'},
			{kind: 'infer'},
		] satisfies EnsNameIntent[]) {
			const mock = mockHolding('{"ensName":"kept.eth"}');
			await resolveFor(mock, 'a.eth', intent);
			expect(mock.requestsFor('files/read').length).toBe(0);
		}
	});
});

/**
 * The WRITE side of `mode`, which flows through the SAME resolver as `ensName`
 * (the requeue decision on `config-drop-sites-and-make-optional`): a STATED
 * mode (`--set-mode`) wins, an omitted one PRESERVES what the site already
 * stores, and only a site that stores nothing falls back to `ipfs`. So a
 * re-deploy/re-pin can never silently DEMOTE a live `ipns` site to `ipfs`.
 *
 * The load-bearing detail is that BOTH preserve branches are served by the ONE
 * read the resolver already did for `ensName` — mode is not a second round trip.
 */
describe('resolveSiteMetadataToWrite — the two mode intents', () => {
	/** Resolve the metadata a write would carry under a mode intent alone. */
	function resolveModeFor(
		mock: MockKuboApi,
		mode?: 'ipfs' | 'ipns',
	): Promise<SiteMetadata> {
		return resolveSiteMetadataToWrite({
			client: clientWith(mock),
			sitesDir: '/sites',
			id: 'blog',
			mode: siteModeIntent(mode),
		});
	}

	it('set: the STATED mode wins over whatever the site stores', async () => {
		const stored = mockHolding('{"mode":"ipfs"}');
		expect((await resolveModeFor(stored, 'ipns')).mode).toBe('ipns');
		const other = mockHolding('{"mode":"ipns"}');
		expect((await resolveModeFor(other, 'ipfs')).mode).toBe('ipfs');
	});

	it('preserve: carries the STORED mode forward (never a silent demotion)', async () => {
		const mock = mockHolding('{"ensName":"kept.eth","mode":"ipns"}');
		expect(await resolveModeFor(mock)).toEqual({
			ensName: 'kept.eth',
			mode: 'ipns',
		});
	});

	it('preserve: falls back to `ipfs` when the site stores nothing (first write)', async () => {
		expect(await resolveModeFor(mockWithoutMetadata())).toEqual({
			mode: DEFAULT_SITE_MODE,
		});
		expect(DEFAULT_SITE_MODE).toBe('ipfs');
	});

	it('preserve: BOTH fields come from the ONE read (never a second round trip)', async () => {
		const mock = mockHolding('{"ensName":"kept.eth","mode":"ipns"}');
		expect(
			await resolveSiteMetadataToWrite({
				client: clientWith(mock),
				sitesDir: '/sites',
				id: 'blog',
			}),
		).toEqual({ensName: 'kept.eth', mode: 'ipns'});
		expect(mock.requestsFor('files/read').length).toBe(1);
	});

	it('reads NOTHING when both intents are total (stated mode + stated name)', async () => {
		const mock = mockHolding('{"ensName":"kept.eth","mode":"ipns"}');
		expect(
			await resolveSiteMetadataToWrite({
				client: clientWith(mock),
				sitesDir: '/sites',
				id: 'blog',
				mode: {kind: 'set', mode: 'ipfs'},
				ensName: {kind: 'unset'},
			}),
		).toEqual({ensName: '', mode: 'ipfs'});
		expect(mock.requestsFor('files/read').length).toBe(0);
		expect(mock.requestsFor('files/ls').length).toBe(0);
	});

	it('siteModeIntent: a stated mode is `set`, an omitted one is `preserve`', () => {
		expect(siteModeIntent('ipns')).toEqual({kind: 'set', mode: 'ipns'});
		expect(siteModeIntent(undefined)).toEqual({kind: 'preserve'});
	});
});

/**
 * The WRITE path may only overwrite a site's stored metadata on the strength of
 * an answer it UNDERSTOOD (task `site-metadata-write-path-no-silent-loss`).
 *
 * `preserve` is a READ-MODIFY-write, so "nothing is stored" has to be a POSITIVE
 * fact: a SUCCESSFUL `files/ls` that does not list the file. The tolerant
 * discovery read cannot supply that — it answers `{}` for a missing file, a
 * down node and a 401 alike — and reusing it here made a no-flag re-deploy
 * against a sick node resolve to `ipfs`, wipe the site's `ensName` and exit 0.
 *
 * So the listing walks UP from the file to the first level that ANSWERS: the
 * wrapper, the sites dir, then the MFS root (which always exists). The first
 * successful listing that does not carry the next segment is a real absence;
 * anything else — no level answered, or a level says the path IS there but the
 * step below it failed — is an OUTAGE, and the write is REFUSED. Kubo's error
 * TEXT is never sniffed (brittle across versions).
 */
describe('resolveSiteMetadataToWrite — absence is POSITIVE, an outage REFUSES', () => {
	/** Resolve with BOTH fields preserving (the no-flag deploy/pin/add). */
	function preserveFor(mock: MockKuboApi, id = 'blog'): Promise<SiteMetadata> {
		return resolveSiteMetadataToWrite({
			client: clientWith(mock),
			sitesDir: '/sites',
			id,
		});
	}

	it('reads the stored metadata when the wrapper LISTS metadata.json', async () => {
		const mock = mockMfs({
			dirs: {'/sites/blog': ['content', METADATA]},
			files: {
				'/sites/blog/metadata.json': '{"ensName":"kept.eth","mode":"ipns"}',
			},
		});
		expect(await preserveFor(mock)).toEqual({
			ensName: 'kept.eth',
			mode: 'ipns',
		});
		// One listing (the wrapper) and one read — no walk up, no second read.
		expect(listedPaths(mock)).toEqual(['/sites/blog']);
		expect(mock.requestsFor('files/read').length).toBe(1);
	});

	it('absence: the wrapper lists no metadata.json, so nothing is read', async () => {
		// A site placed by an older pinnace: the wrapper is there, the file is not.
		const mock = mockMfs({dirs: {'/sites/blog': ['content']}});
		expect(await preserveFor(mock)).toEqual({mode: DEFAULT_SITE_MODE});
		expect(mock.requestsFor('files/read').length).toBe(0);
	});

	it('absence: no wrapper yet — the sites dir positively does not list the site', async () => {
		// The FIRST deploy/pin/add of this site onto a node that holds others.
		const mock = mockMfs({dirs: {'/sites': ['other.eth']}});
		expect(await preserveFor(mock)).toEqual({mode: DEFAULT_SITE_MODE});
		expect(listedPaths(mock)).toEqual(['/sites/blog', '/sites']);
	});

	it('absence: a FRESH box with no sites dir — the MFS root answers', async () => {
		const mock = mockMfs({dirs: {'/': []}});
		expect(await preserveFor(mock)).toEqual({mode: DEFAULT_SITE_MODE});
		expect(listedPaths(mock)).toEqual(['/sites/blog', '/sites', '/']);
	});

	it('absence: a nested sites dir walks every level of it', async () => {
		const mock = mockMfs({dirs: {'/': ['other-stuff']}});
		expect(
			await resolveSiteMetadataToWrite({
				client: clientWith(mock),
				sitesDir: '/deep/sites',
				id: 'blog',
			}),
		).toEqual({mode: DEFAULT_SITE_MODE});
		expect(listedPaths(mock)).toEqual([
			'/deep/sites/blog',
			'/deep/sites',
			'/deep',
			'/',
		]);
	});

	it('REFUSES when NOTHING can be listed (a down or 401ing node)', async () => {
		const mock = mockOutage();
		const refusal = await preserveFor(mock).catch((e: unknown) => e);
		expect(refusal).toBeInstanceOf(SiteMetadataUnreadableError);
		const error = refusal as SiteMetadataUnreadableError;
		// It names the SITE, the NODE, and the STEP that could not be completed.
		expect(error.id).toBe('blog');
		expect(error.baseUrl).toBe(mock.baseUrl);
		expect(error.step).toContain('files/ls');
		expect(error.message).toContain('blog');
		expect(error.message).toContain(mock.baseUrl);
		expect(error.message).toContain('files/ls');
		expect(error.message).toContain('401');
		// It never resolved to a mode — that is the silent demotion it exists to stop.
		expect(error.message).not.toMatch(/^Kubo/);
	});

	it('REFUSES when metadata.json IS listed but the read fails', async () => {
		const mock = mockMfs({dirs: {'/sites/blog': ['content', METADATA]}});
		// The file is positively THERE, so an unreadable one is an outage, never an
		// absence — exactly the case the tolerant read used to swallow.
		const error = (await preserveFor(mock).catch(
			(e: unknown) => e,
		)) as SiteMetadataUnreadableError;
		expect(error).toBeInstanceOf(SiteMetadataUnreadableError);
		expect(error.step).toContain('files/read');
		expect(error.step).toContain('/sites/blog/metadata.json');
	});

	it('REFUSES when the wrapper will not list though the sites dir still shows the site', async () => {
		const mock = mockMfs({dirs: {'/sites': ['blog']}});
		const error = (await preserveFor(mock).catch(
			(e: unknown) => e,
		)) as SiteMetadataUnreadableError;
		expect(error).toBeInstanceOf(SiteMetadataUnreadableError);
		// The DEEPEST failure is what it reports (the wrapper listing).
		expect(error.step).toContain('/sites/blog');
	});

	it('REFUSES for a preserved MODE alone (a stated name does not license the guess)', async () => {
		await expect(
			resolveSiteMetadataToWrite({
				client: clientWith(mockOutage()),
				sitesDir: '/sites',
				id: 'blog',
				ensName: {kind: 'set', name: 'alice.eth'},
			}),
		).rejects.toBeInstanceOf(SiteMetadataUnreadableError);
	});

	it('touches NO node when both intents are total (the way past a sick node)', async () => {
		const mock = mockOutage();
		expect(
			await resolveSiteMetadataToWrite({
				client: clientWith(mock),
				sitesDir: '/sites',
				id: 'blog',
				mode: {kind: 'set', mode: 'ipns'},
				ensName: {kind: 'unset'},
			}),
		).toEqual({ensName: '', mode: 'ipns'});
		expect(mock.requests.length).toBe(0);
	});

	it('readSiteMetadataForWrite is the strict counterpart of readSiteMetadata', async () => {
		const mock = mockOutage();
		const client = clientWith(mock);
		// The SAME node, the SAME site: tolerant for discovery, strict for writes.
		expect(await readSiteMetadata(client, '/sites', 'blog')).toEqual({});
		await expect(
			readSiteMetadataForWrite(client, '/sites', 'blog'),
		).rejects.toBeInstanceOf(SiteMetadataUnreadableError);
	});
});

/**
 * The READ side of the same three-valued field: which ENS name (if any) the
 * on-box `warm` loop resolves for a site. This is the rule the WRITE intents
 * above exist to feed, so it is asserted right next to them — the two sides
 * must agree about what `""` and absent mean, or the lever silently inverts.
 */
describe('resolveEnsNameToWarm — the three-way eth.limo rule', () => {
	it('explicit non-empty name wins, whatever the id says', () => {
		expect(resolveEnsNameToWarm('blog', {ensName: 'alice.eth'})).toBe(
			'alice.eth',
		);
		// ...including OVERRIDING a `.eth` id (the name, not the identity, is what
		// gets warmed).
		expect(resolveEnsNameToWarm('a.eth', {ensName: 'other.eth'})).toBe(
			'other.eth',
		);
	});

	it('`""` OPTS OUT — even for a `.eth` id (never falls through to inference)', () => {
		expect(resolveEnsNameToWarm('a.eth', {ensName: ''})).toBeUndefined();
		expect(resolveEnsNameToWarm('blog', {ensName: ''})).toBeUndefined();
	});

	it('ABSENT infers the name from a `.eth` id', () => {
		expect(resolveEnsNameToWarm('a.eth', {})).toBe('a.eth');
		expect(resolveEnsNameToWarm('a.eth', {mode: 'ipns'})).toBe('a.eth');
	});

	it('ABSENT on a non-`.eth` id resolves to nothing', () => {
		expect(resolveEnsNameToWarm('blog', {})).toBeUndefined();
		expect(resolveEnsNameToWarm('eth', {})).toBeUndefined();
	});
});
