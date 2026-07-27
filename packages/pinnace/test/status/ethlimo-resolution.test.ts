import {describe, it, expect} from 'vitest';
import {
	classifyEthLimoResolution,
	unknownEthLimoResolution,
} from '../../src/status/ethlimo-resolution.js';

/**
 * The two eth.limo resolution AXES, tested as the pure leaf they are: headers
 * in, two verdicts out. No network, no Kubo, no clock.
 *
 * The regression that motivated them is a LIVE box: eth.limo answered
 *
 *   x-ipfs-path:  /ipns/k51qzi5uqu5dlu1ien9spji7pu49mfw97mn0qv4azugqcvenj0dvzq9bgwp1zc/
 *   x-ipfs-roots: bafybeiepw4aijr4dtlhth2xkzskxaxcjvtk6neqsd6zua7rfv6m5nbkesu
 *
 * for a site whose OWN pinnace name is a DIFFERENT `k51...`: the ENS record
 * still points at the publisher the content was pinned FROM, so pinnace
 * republishes an orphaned name and the site dies the day that publisher stops.
 * Every other indicator was green.
 */

/** The live box's headers, verbatim (the exact pair the regression showed). */
const LIVE_SOURCE_NAME =
	'k51qzi5uqu5dlu1ien9spji7pu49mfw97mn0qv4azugqcvenj0dvzq9bgwp1zc';
/** That site's OWN pinnace-published name — nothing references it. */
const LIVE_OWN_NAME =
	'k51qzi5uqu5diifcue0h8g3dxnd0vjaaft5h8ocqcfit2th2ulcg4mdjdtjmo5';
const LIVE_CID = 'bafybeiepw4aijr4dtlhth2xkzskxaxcjvtk6neqsd6zua7rfv6m5nbkesu';
const LIVE_HEADERS = {
	'x-ipfs-path': `/ipns/${LIVE_SOURCE_NAME}/`,
	'x-ipfs-roots': LIVE_CID,
};

describe('eth.limo origin — is the name resolving through THIS site identity?', () => {
	it('reports FOREIGN naming what it points at (the live green-but-orphaned box)', () => {
		const {origin} = classifyEthLimoResolution({
			cid: LIVE_CID,
			ipns: LIVE_OWN_NAME,
			mode: 'ipns',
			ensName: 'example.eth',
			headers: LIVE_HEADERS,
		});
		// The ACTIONABLE detail is WHICH name it points at: the operator has to see
		// the wrong name to fix their ENS record.
		expect(origin).toEqual({
			state: 'foreign',
			path: `/ipns/${LIVE_SOURCE_NAME}`,
		});
	});

	it('reports OURS when the path names the site own ipns id (ipns mode)', () => {
		const {origin} = classifyEthLimoResolution({
			cid: LIVE_CID,
			ipns: LIVE_OWN_NAME,
			mode: 'ipns',
			// A trailing slash and a sub-path are both normal gateway spellings.
			headers: {'x-ipfs-path': `/ipns/${LIVE_OWN_NAME}/index.html`},
		});
		expect(origin).toEqual({state: 'ours'});
	});

	it('reports OURS when an ipfs-mode site path names its own cid', () => {
		const {origin} = classifyEthLimoResolution({
			cid: 'bafyours',
			mode: 'ipfs',
			headers: {'x-ipfs-path': '/ipfs/bafyours/'},
		});
		expect(origin).toEqual({state: 'ours'});
	});

	it('reports FOREIGN when an ipfs-mode site path names some OTHER cid', () => {
		const {origin} = classifyEthLimoResolution({
			cid: 'bafyours',
			mode: 'ipfs',
			headers: {'x-ipfs-path': '/ipfs/bafyother'},
		});
		expect(origin).toEqual({state: 'foreign', path: '/ipfs/bafyother'});
	});

	it('reports FROZEN for an ipns-mode site whose ENS holds an immutable cid — even the CURRENT one', () => {
		const {origin, freshness} = classifyEthLimoResolution({
			cid: 'bafycurrent',
			ipns: LIVE_OWN_NAME,
			mode: 'ipns',
			headers: {
				'x-ipfs-path': '/ipfs/bafycurrent/',
				'x-ipfs-roots': 'bafycurrent',
			},
		});
		// The cid served IS ours and IS current, so freshness is green...
		expect(freshness).toEqual({state: 'current'});
		// ...but the ENS record is pinned to an immutable cid, so it will never
		// follow a future deploy. That is the whole point of surfacing it.
		expect(origin).toEqual({state: 'frozen', path: '/ipfs/bafycurrent'});
	});

	it('reports FROZEN for a mode-less site the node holds a key for (republish signs it)', () => {
		// A site placed before metadata existed stores no mode; the box decides by
		// key presence (record-sequence), so origin reads it the same way.
		const {origin} = classifyEthLimoResolution({
			cid: 'bafycurrent',
			ipns: LIVE_OWN_NAME,
			headers: {'x-ipfs-path': '/ipfs/bafycurrent'},
		});
		expect(origin).toEqual({state: 'frozen', path: '/ipfs/bafycurrent'});
	});

	it('reports UNKNOWN with a reason when the site publishes a name this node has no id for', () => {
		// A replica (or a publisher missing the key) cannot know the site's ipns
		// id, so it cannot compare — and must not guess `foreign`.
		const {origin} = classifyEthLimoResolution({
			cid: LIVE_CID,
			mode: 'ipns',
			headers: LIVE_HEADERS,
		});
		expect(origin.state).toBe('unknown');
		expect(origin).toHaveProperty('reason', expect.stringContaining('ipns id'));
	});

	it('reports UNKNOWN with a reason when the gateway ECHOES the ens name back', () => {
		// Some gateways answer `/ipns/<dnslink-or-ens-name>` rather than the
		// resolved key. That tells us nothing about the origin, so it is a check we
		// could not make — never a confident `foreign`.
		const {origin} = classifyEthLimoResolution({
			cid: LIVE_CID,
			ipns: LIVE_OWN_NAME,
			mode: 'ipns',
			ensName: 'alice.eth',
			headers: {'x-ipfs-path': '/ipns/alice.eth/'},
		});
		expect(origin.state).toBe('unknown');
		expect(origin).toHaveProperty(
			'reason',
			expect.stringContaining('echoed the ens name'),
		);
	});

	it('reports UNKNOWN with a reason when the header is ABSENT or unreadable', () => {
		const absent = classifyEthLimoResolution({cid: 'bafyours', headers: {}});
		expect(absent.origin).toEqual({
			state: 'unknown',
			reason: 'no x-ipfs-path header',
		});
		const garbled = classifyEthLimoResolution({
			cid: 'bafyours',
			headers: {'x-ipfs-path': 'not-a-path'},
		});
		expect(garbled.origin.state).toBe('unknown');
		expect(garbled.origin).toHaveProperty(
			'reason',
			expect.stringContaining('x-ipfs-path'),
		);
	});

	it('reads header names case-insensitively (a gateway may Title-Case them)', () => {
		const {origin, freshness} = classifyEthLimoResolution({
			cid: 'bafyours',
			mode: 'ipfs',
			headers: {'X-Ipfs-Path': '/ipfs/bafyours', 'X-Ipfs-Roots': 'bafyours'},
		});
		expect(origin).toEqual({state: 'ours'});
		expect(freshness).toEqual({state: 'current'});
	});
});

describe('eth.limo freshness — is the served root OUR current cid?', () => {
	it('reports CURRENT when x-ipfs-roots is the site cid', () => {
		const {freshness} = classifyEthLimoResolution({
			cid: LIVE_CID,
			ipns: LIVE_OWN_NAME,
			mode: 'ipns',
			headers: LIVE_HEADERS,
		});
		expect(freshness).toEqual({state: 'current'});
	});

	it('reports STALE NAMING the served cid when it differs', () => {
		const {freshness} = classifyEthLimoResolution({
			cid: 'bafynew',
			ipns: LIVE_OWN_NAME,
			mode: 'ipns',
			headers: {
				'x-ipfs-path': `/ipns/${LIVE_OWN_NAME}/`,
				// The gateway lists a root per path segment; the FIRST is the root the
				// name resolved to, which is what "is it our cid?" asks about.
				'x-ipfs-roots': 'bafyold,bafychild',
			},
		});
		expect(freshness).toEqual({state: 'stale', servedCid: 'bafyold'});
	});

	it('reports UNKNOWN with a reason when x-ipfs-roots is absent or empty', () => {
		const absent = classifyEthLimoResolution({
			cid: 'bafynew',
			headers: {'x-ipfs-path': '/ipfs/bafynew'},
		});
		expect(absent.freshness).toEqual({
			state: 'unknown',
			reason: 'no x-ipfs-roots header',
		});
		const empty = classifyEthLimoResolution({
			cid: 'bafynew',
			headers: {'x-ipfs-path': '/ipfs/bafynew', 'x-ipfs-roots': '  '},
		});
		expect(empty.freshness.state).toBe('unknown');
	});

	it('is INDEPENDENT of origin: a foreign origin can serve our current cid', () => {
		// Exactly the live box: the name is someone else's, the bytes are ours.
		const {origin, freshness} = classifyEthLimoResolution({
			cid: LIVE_CID,
			ipns: LIVE_OWN_NAME,
			mode: 'ipns',
			headers: LIVE_HEADERS,
		});
		expect(origin.state).toBe('foreign');
		expect(freshness.state).toBe('current');
	});
});

describe('eth.limo axes — a probe that could not be made', () => {
	it('reports UNKNOWN with the probe reason on BOTH axes, never a negative', () => {
		const {origin, freshness} = unknownEthLimoResolution('fetch failed');
		expect(origin).toEqual({state: 'unknown', reason: 'fetch failed'});
		expect(freshness).toEqual({state: 'unknown', reason: 'fetch failed'});
	});

	it('normalises an empty reason rather than reporting a blank unknown', () => {
		const {origin} = unknownEthLimoResolution('   ');
		expect(origin.state).toBe('unknown');
		expect(origin).toHaveProperty('reason', expect.stringMatching(/\S/));
	});
});
