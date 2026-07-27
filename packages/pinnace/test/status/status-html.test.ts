import {describe, it, expect} from 'vitest';
import {
	renderStatusHtml,
	DEFAULT_STATUS_REFRESH_SECONDS,
	type StatusPageReport,
} from '../../src/status/status-html.js';

/**
 * The renderer is a PURE `StatusPageReport -> html string` function: these tests
 * touch NO filesystem, NO Kubo daemon and NO network. They assert the rendered
 * page's fields, gateway links, indicators, escaping and self-containment. The
 * command layer's WRITE of this string (index.html next to status.json, only
 * under the dashboard dir) is asserted in test/node/node-commands.test.ts.
 */

/** A two-site report fixture: alice.eth has an IPNS id, bob is an ipfs-mode site. */
function reportFixture(): StatusPageReport {
	return {
		peerId: '12D3KooWpeerself',
		generated: '2026-07-25T10:11:12.000Z',
		sites: [
			{
				id: 'alice.eth',
				cid: 'bafyalice',
				ipns: 'k51alice',
				mode: 'ipns',
				// ensName ABSENT: the on-box rule infers it from the `.eth` id.
				ensNameToWarm: 'alice.eth',
				announced: true,
				gatewayServes: true,
			},
			{
				id: 'bob',
				cid: 'bafybob',
				mode: 'ipfs',
				announced: false,
				gatewayServes: false,
			},
		],
	};
}

describe('renderStatusHtml: header (peerId + generated freshness)', () => {
	it('renders a complete standalone HTML document', () => {
		const html = renderStatusHtml(reportFixture());
		expect(html.startsWith('<!doctype html>')).toBe(true);
		expect(html).toContain('<html lang="en">');
		expect(html.trimEnd().endsWith('</html>')).toBe(true);
	});

	it('shows the node PeerID and the generated timestamp', () => {
		const html = renderStatusHtml(reportFixture());
		expect(html).toContain('12D3KooWpeerself');
		expect(html).toContain('2026-07-25T10:11:12.000Z');
		// The timestamp is machine-readable too, so freshness is unambiguous.
		expect(html).toContain('<time datetime="2026-07-25T10:11:12.000Z">');
	});

	it('reports an unknown PeerID rather than an empty gap when it is absent', () => {
		const html = renderStatusHtml({
			generated: '2026-07-25T10:11:12.000Z',
			sites: [],
		});
		expect(html).toContain('unknown');
	});
});

describe('renderStatusHtml: per-site row', () => {
	it('links the CID to a public gateway and the IPNS id when present', () => {
		const html = renderStatusHtml(reportFixture());
		expect(html).toContain('href="https://bafyalice.ipfs.dweb.link/"');
		expect(html).toContain('href="https://k51alice.ipns.dweb.link/"');
		expect(html).toContain('href="https://bafybob.ipfs.dweb.link/"');
		// Every site id and cid is shown.
		expect(html).toContain('alice.eth');
		expect(html).toContain('>bob<');
		expect(html).toContain('bafybob');
	});

	it('shows no IPNS link for an ipfs-mode site (no key)', () => {
		const html = renderStatusHtml(reportFixture());
		expect(html).not.toContain('ipns.dweb.link/"</');
		// bob has no ipns id at all, so only ONE ipns link exists (alice's).
		expect(html.match(/ipns\.dweb\.link/g)?.length).toBe(1);
		expect(html).toContain('none');
	});

	it('renders announced / gatewayServes as ok / no indicators', () => {
		const html = renderStatusHtml(reportFixture());
		expect(html).toContain('>ok<');
		expect(html).toContain('>no<');
		// alice (both true) precedes bob (both false); alice's row carries two oks.
		const aliceRow = html.slice(
			html.indexOf('alice.eth'),
			html.indexOf('>bob<'),
		);
		expect(aliceRow.match(/>ok</g)?.length).toBe(2);
		const bobRow = html.slice(html.indexOf('>bob<'));
		expect(bobRow.match(/>no</g)?.length).toBe(2);
	});

	it('shows the stored mode and the RESOLVED eth.limo target it will warm', () => {
		const html = renderStatusHtml(reportFixture());
		// The stored mode of each site, so the operator sees how it is addressed.
		expect(html).toContain('>ipns<');
		expect(html).toContain('>ipfs<');
		// The resolved eth.limo target is linked; bob resolves none.
		expect(html).toContain('href="https://alice.eth.limo/"');
		// Exactly the one warmed site: its href + its label. bob resolves none.
		expect(html.match(/alice\.eth\.limo/g)?.length).toBe(2);
		expect(html).not.toContain('bafybob.limo');
	});

	it('distinguishes an ensName opt-out ("") from a site that stores none', () => {
		const html = renderStatusHtml({
			generated: '2026-07-25T10:11:12.000Z',
			sites: [
				{id: 'optout.eth', cid: 'bafyoptout', mode: 'ipfs', ensName: ''},
				{id: 'plain.eth', cid: 'bafyplain', mode: 'ipfs'},
			],
		});
		const optoutRow = html.slice(
			html.indexOf('optout.eth'),
			html.indexOf('plain.eth'),
		);
		expect(optoutRow).toContain('opted out');
		// The site that stores NO ensName is not reported as an opt-out.
		const plainRow = html.slice(html.indexOf('plain.eth'));
		expect(plainRow).not.toContain('opted out');
		// It still warms by inference from its `.eth` id, which the report resolved.
		expect(html).not.toContain('optout.eth.limo');
	});

	it('shows an explicit ensName, and links the name it warms', () => {
		const html = renderStatusHtml({
			generated: '2026-07-25T10:11:12.000Z',
			sites: [
				{
					id: 'blog',
					cid: 'bafyblog',
					mode: 'ipfs',
					ensName: 'named.eth',
					ensNameToWarm: 'named.eth',
				},
			],
		});
		expect(html).toContain('named.eth');
		expect(html).toContain('href="https://named.eth.limo/"');
	});

	it('shows WHETHER the eth.limo name serves, beside the name itself', () => {
		const html = renderStatusHtml({
			peerId: '12D3KooWpeerself',
			generated: '2026-07-25T10:11:12.000Z',
			sites: [
				{
					id: 'alice.eth',
					cid: 'bafyalice',
					mode: 'ipns',
					ensNameToWarm: 'alice.eth',
					announced: false,
					gatewayServes: false,
					ethLimoServes: true,
				},
				{
					id: 'cold.eth',
					cid: 'bafycold',
					mode: 'ipns',
					ensNameToWarm: 'cold.eth',
					announced: false,
					gatewayServes: false,
					ethLimoServes: false,
				},
			],
		});
		const aliceRow = html.slice(
			html.indexOf('alice.eth'),
			html.indexOf('cold.eth'),
		);
		// The column shows the NAME (linked) AND its serving state, so the column
		// answers "does it serve?" rather than only "what would we warm?".
		expect(aliceRow).toContain('href="https://alice.eth.limo/"');
		expect(aliceRow).toContain('>ok<');
		// The two health columns are untouched: alice is announced=false,
		// gatewayServes=false, so its only `ok` is the eth.limo one.
		expect(aliceRow.match(/>ok</g)?.length).toBe(1);
		const coldRow = html.slice(html.indexOf('cold.eth'));
		expect(coldRow).toContain('href="https://cold.eth.limo/"');
		expect(coldRow.match(/>no</g)?.length).toBe(3);
	});

	it('leaves the eth.limo verdict blank for a site with NO name to probe', () => {
		const html = renderStatusHtml({
			peerId: '12D3KooWpeerself',
			generated: '2026-07-25T10:11:12.000Z',
			sites: [
				{
					id: 'optout.eth',
					cid: 'bafyoptout',
					mode: 'ipfs',
					ensName: '',
					announced: true,
					gatewayServes: true,
				},
			],
		});
		// Nothing to probe is NOT a failed probe: the column says `none` and adds no
		// red verdict the operator would read as "eth.limo is broken".
		expect(html).toContain('none');
		expect(html.match(/>no</g) ?? []).toHaveLength(0);
		expect(html.match(/>ok</g)?.length).toBe(2);
	});

	it('says so plainly when the node has no sites yet (fresh box)', () => {
		const html = renderStatusHtml({
			peerId: '12D3KooWpeerself',
			generated: '2026-07-25T10:11:12.000Z',
			sites: [],
		});
		expect(html).toMatch(/no sites/i);
	});
});

describe('renderStatusHtml: auto-reload via meta-refresh (no client JS)', () => {
	it('defaults to the named ~300s constant aligned with the status timer', () => {
		expect(DEFAULT_STATUS_REFRESH_SECONDS).toBe(300);
		const html = renderStatusHtml(reportFixture());
		expect(html).toContain(
			`<meta http-equiv="refresh" content="${DEFAULT_STATUS_REFRESH_SECONDS}" />`,
		);
	});

	it('accepts an explicit refresh interval', () => {
		const html = renderStatusHtml(reportFixture(), {refreshSeconds: 60});
		expect(html).toContain('<meta http-equiv="refresh" content="60" />');
		expect(html).not.toContain('content="300"');
	});
});

describe('renderStatusHtml: self-contained + escaped', () => {
	it('has inline CSS and no external assets or client JS', () => {
		const html = renderStatusHtml(reportFixture());
		expect(html).toContain('<style>');
		expect(html).not.toMatch(/<script/i);
		expect(html).not.toMatch(/<link\b/i);
		expect(html).not.toMatch(/\ssrc=/i);
		// The only outbound URLs are the per-site gateway links.
		const urls = html.match(/https?:\/\/[^"\s]+/g) ?? [];
		expect(
			urls.every((u) => u.includes('dweb.link') || u.endsWith('.limo/')),
		).toBe(true);
	});

	it('HTML-escapes site-controlled strings (id, cid, ipns)', () => {
		const html = renderStatusHtml({
			peerId: 'peer<self>',
			generated: '2026-07-25T10:11:12.000Z',
			sites: [
				{
					id: '<script>alert("x")</script>',
					cid: 'bafy"&<evil>',
					ipns: "k51'&<evil>",
					announced: true,
					gatewayServes: false,
				},
			],
		});
		expect(html).not.toMatch(/<script/i);
		expect(html).not.toContain('<evil>');
		expect(html).toContain('&lt;script&gt;');
		expect(html).toContain('&amp;');
		expect(html).toContain('peer&lt;self&gt;');
		// A quote inside a site string must never break out of an attribute.
		expect(html).not.toContain('href="https://bafy"');
	});

	it('is deterministic for the same report (pure: no clock, no filesystem)', () => {
		expect(renderStatusHtml(reportFixture())).toBe(
			renderStatusHtml(reportFixture()),
		);
	});
});
