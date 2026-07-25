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
	resolveSiteMetadataToWrite,
	assertEnsNameIntent,
	EnsNameInferenceError,
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

/** A mock whose `/sites/<id>/metadata.json` reads back as `text`. */
function mockHolding(text: string): MockKuboApi {
	const mock = new MockKuboApi();
	mock.on('files/read', {text});
	return mock;
}

/** A mock with NO metadata for the site (Kubo's loud non-2xx for a missing path). */
function mockWithoutMetadata(): MockKuboApi {
	const mock = new MockKuboApi();
	mock.on('files/read', {status: 500, text: 'file does not exist'});
	return mock;
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
		mode: 'ipfs',
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
			// The MODE is the one this operation runs in, never the stored one.
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
				mode: 'ipns',
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
