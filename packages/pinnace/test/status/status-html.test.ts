import {describe, it, expect} from 'vitest';
import {
	renderStatusHtml,
	DEFAULT_STATUS_REFRESH_SECONDS,
	type StatusPageReport,
} from '../../src/status/status-html.js';
import {checkAnswer, checkUnknown} from '../../src/status/check-outcome.js';

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
				announced: checkAnswer(true),
				gatewayServes: checkAnswer(true),
			},
			{
				id: 'bob',
				cid: 'bafybob',
				mode: 'ipfs',
				announced: checkAnswer(false),
				gatewayServes: checkAnswer(false),
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
		// Exactly the one warmed site: its href, its title tooltip and its label
		// (links carry the FULL value in `title`, so an elided label loses nothing).
		// bob resolves none.
		expect(html.match(/alice\.eth\.limo/g)?.length).toBe(3);
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

	it('shows an INFERRED ensName as the name, marked inferred (never `none`)', () => {
		// The bug this replaces: a `.eth` site with no STORED name showed `none` in
		// the ens-name cell beside a working ronan.eth.limo link in the next one.
		const html = renderStatusHtml({
			generated: '2026-07-25T10:11:12.000Z',
			sites: [
				{
					id: 'ronan.eth',
					cid: 'bafyronan',
					ipns: 'k51ronan',
					mode: 'ipns',
					// A published site whose record this node could read, so the seq cell
					// carries a value like every other cell in this row.
					sequence: {state: 'known', sequence: 3},
					// ensName ABSENT, but the report RESOLVED one from the `.eth` id.
					ensNameToWarm: 'ronan.eth',
					// ...and the probe answered on both resolution axes, so every cell
					// below carries a value.
					ethLimoOrigin: {state: 'ours'},
					ethLimoFreshness: {state: 'current'},
				},
			],
		});
		expect(html).toContain('<code>ronan.eth</code>');
		expect(html).toContain('(inferred)');
		// Every cell of this row has a value, so NOTHING in it reads as absent.
		expect(html).not.toContain('class="none"');
		expect(html).not.toContain('opted out');
	});

	it('keeps a STORED ensName visually distinct from an inferred one', () => {
		const html = renderStatusHtml({
			generated: '2026-07-25T10:11:12.000Z',
			sites: [
				{
					id: 'stored.eth',
					cid: 'bafystored',
					mode: 'ipfs',
					ensName: 'stored.eth',
					ensNameToWarm: 'stored.eth',
				},
				{
					id: 'inferred.eth',
					cid: 'bafyinferred',
					mode: 'ipfs',
					ensNameToWarm: 'inferred.eth',
				},
			],
		});
		const storedRow = html.slice(
			html.indexOf('stored.eth'),
			html.indexOf('inferred.eth'),
		);
		// A STORED name is the site's own override, so it carries no hint at all.
		expect(storedRow).toContain('<code>stored.eth</code>');
		expect(storedRow).not.toContain('inferred');
		const inferredRow = html.slice(html.indexOf('>inferred.eth<'));
		expect(inferredRow).toContain('<code>inferred.eth</code>');
		expect(inferredRow).toContain('(inferred)');
	});

	it('still shows none for a non-`.eth` id that resolves no name at all', () => {
		const html = renderStatusHtml({
			generated: '2026-07-25T10:11:12.000Z',
			sites: [{id: 'blog', cid: 'bafyblog', ipns: 'k51blog', mode: 'ipfs'}],
		});
		// Nothing stored AND nothing resolved: genuinely none, and it keeps the
		// muted `.none` styling rather than borrowing the inferred one.
		expect(html).toContain('<span class="none">none</span>');
		expect(html).not.toContain('(inferred)');
		expect(html).not.toContain('<span class="inferred">');
	});

	it('infers NOTHING itself: a `.eth` id the report did not resolve reads none', () => {
		const html = renderStatusHtml({
			generated: '2026-07-25T10:11:12.000Z',
			// A `.eth` id, no stored ensName, and NO resolved ensNameToWarm (a report
			// from a path that resolves none). The renderer must not apply the
			// `.eth` rule on its own — it renders what the report resolved.
			sites: [{id: 'ronan.eth', cid: 'bafyronan', mode: 'ipns'}],
		});
		// Nothing stored AND nothing resolved: genuinely none, and it keeps the
		// muted `.none` styling rather than borrowing the inferred one.
		expect(html).toContain('<span class="none">none</span>');
		expect(html).not.toContain('(inferred)');
		expect(html).not.toContain('<span class="inferred">');
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
					announced: checkAnswer(false),
					gatewayServes: checkAnswer(false),
					ethLimoServes: checkAnswer(true),
				},
				{
					id: 'cold.eth',
					cid: 'bafycold',
					mode: 'ipns',
					ensNameToWarm: 'cold.eth',
					announced: checkAnswer(false),
					gatewayServes: checkAnswer(false),
					ethLimoServes: checkAnswer(false),
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
					announced: checkAnswer(true),
					gatewayServes: checkAnswer(true),
				},
			],
		});
		// Nothing to probe is NOT a failed probe: the column says `none` and adds no
		// red verdict the operator would read as "eth.limo is broken".
		expect(html).toContain('none');
		expect(html.match(/>no</g) ?? []).toHaveLength(0);
		expect(html.match(/>ok</g)?.length).toBe(2);
	});

	it('renders an UNKNOWN check NEUTRALLY, with its reason, never the red cross', () => {
		// The live-box bug, on the page: a rate-limited providers lookup used to
		// paint a red `no` for a site the router WAS listing.
		const html = renderStatusHtml({
			peerId: '12D3KooWpeerself',
			generated: '2026-07-25T10:11:12.000Z',
			sites: [
				{
					id: 'alice.eth',
					cid: 'bafyalice',
					mode: 'ipns',
					announced: checkUnknown('http 429'),
					gatewayServes: checkAnswer(true),
				},
			],
		});
		// The NEGATIVE indicator (the red one) is never used for a check that could
		// not run — the whole point of the third state.
		expect(html).not.toContain('class="no"');
		expect(html).toContain(
			'<span class="unknown" title="unknown (http 429)">unknown (http 429)</span>',
		);
		// ...and the reason is styled with the MUTED family, never the red one.
		expect(html).toContain('.none, .empty, .inferred, .unknown');
	});

	it('renders a check the report did NOT run as unknown, not as `no`', () => {
		// A report from a path that runs no external checks (the thin on-box
		// stand-in) carries no verdict at all; that is "we did not check", and
		// painting it red would be the same lie.
		const html = renderStatusHtml({
			peerId: '12D3KooWpeerself',
			generated: '2026-07-25T10:11:12.000Z',
			sites: [{id: 'bob', cid: 'bafybob', mode: 'ipfs'}],
		});
		expect(html).not.toContain('class="no"');
		// The two CID health columns, both unrun: `unknown`, with no reason to give.
		expect(html.match(/>unknown</g)?.length).toBe(2);
	});

	it('shows an UNKNOWN eth.limo probe beside the name, distinct from `none`', () => {
		const html = renderStatusHtml({
			generated: '2026-07-25T10:11:12.000Z',
			sites: [
				{
					id: 'alice.eth',
					cid: 'bafyalice',
					mode: 'ipns',
					ensNameToWarm: 'alice.eth',
					announced: checkAnswer(true),
					gatewayServes: checkAnswer(true),
					ethLimoServes: checkUnknown('fetch failed'),
				},
				{
					id: 'optout.eth',
					cid: 'bafyoptout',
					mode: 'ipfs',
					ensName: '',
					announced: checkAnswer(true),
					gatewayServes: checkAnswer(true),
				},
			],
		});
		const aliceRow = html.slice(
			html.indexOf('alice.eth'),
			html.indexOf('optout.eth'),
		);
		// Could not check: the name is still linked, with a muted verdict.
		expect(aliceRow).toContain('href="https://alice.eth.limo/"');
		expect(aliceRow).toContain('unknown (fetch failed)');
		// Nothing to check stays `none` — a different answer, still.
		const optoutRow = html.slice(html.indexOf('optout.eth'));
		expect(optoutRow).toContain('<span class="none">none</span>');
		expect(optoutRow).not.toContain('unknown');
	});

	it('shows the ORIGIN mismatch, naming what the name points at instead', () => {
		const source =
			'k51qzi5uqu5dlu1ien9spji7pu49mfw97mn0qv4azugqcvenj0dvzq9bgwp1zc';
		const html = renderStatusHtml({
			generated: '2026-07-25T10:11:12.000Z',
			sites: [
				{
					id: 'alice.eth',
					cid: 'bafyalice',
					mode: 'ipns',
					ensNameToWarm: 'alice.eth',
					ethLimoServes: checkAnswer(true),
					// The live box: it serves, and it serves our bytes, but through
					// somebody else's name.
					ethLimoOrigin: {state: 'foreign', path: `/ipns/${source}`},
					ethLimoFreshness: {state: 'current'},
					announced: checkAnswer(true),
					gatewayServes: checkAnswer(true),
				},
			],
		});
		// The actionable detail is on the page: WHICH name it points at.
		expect(html).toContain(`/ipns/${source}`);
		expect(html).toContain('foreign');
		expect(html).toContain('current');
	});

	it('renders STALE and UNKNOWN neutrally — never the red negative used for a failure', () => {
		const html = renderStatusHtml({
			generated: '2026-07-25T10:11:12.000Z',
			sites: [
				{
					id: 'alice.eth',
					cid: 'bafynew',
					mode: 'ipns',
					ensNameToWarm: 'alice.eth',
					ethLimoServes: checkAnswer(true),
					ethLimoOrigin: {state: 'ours'},
					// Normal post-deploy propagation lag, not a fault.
					ethLimoFreshness: {state: 'stale', servedCid: 'bafyold'},
					announced: checkAnswer(true),
					gatewayServes: checkAnswer(true),
				},
				{
					id: 'blog.eth',
					cid: 'bafyblog',
					mode: 'ipns',
					ensNameToWarm: 'blog.eth',
					ethLimoServes: checkAnswer(true),
					ethLimoOrigin: {state: 'unknown', reason: 'no x-ipfs-path header'},
					ethLimoFreshness: {
						state: 'unknown',
						reason: 'no x-ipfs-roots header',
					},
					announced: checkAnswer(true),
					gatewayServes: checkAnswer(true),
				},
			],
		});
		const aliceRow = html.slice(
			html.indexOf('alice.eth'),
			html.indexOf('blog.eth'),
		);
		// The served cid is NAMED (that is the actionable bit)...
		expect(aliceRow).toContain('stale');
		expect(aliceRow).toContain('bafyold');
		// ...and nothing on this row is painted as a failure.
		expect(aliceRow).not.toContain('class="no"');
		const blogRow = html.slice(html.indexOf('blog.eth'));
		expect(blogRow).toContain('unknown (no x-ipfs-path header)');
		expect(blogRow).toContain('unknown (no x-ipfs-roots header)');
		expect(blogRow).not.toContain('class="no"');
	});

	it('shows a FROZEN ens record as an attention state, not a green tick', () => {
		const html = renderStatusHtml({
			generated: '2026-07-25T10:11:12.000Z',
			sites: [
				{
					id: 'alice.eth',
					cid: 'bafycurrent',
					mode: 'ipns',
					ensNameToWarm: 'alice.eth',
					ethLimoServes: checkAnswer(true),
					ethLimoOrigin: {state: 'frozen', path: '/ipfs/bafycurrent'},
					ethLimoFreshness: {state: 'current'},
					announced: checkAnswer(true),
					gatewayServes: checkAnswer(true),
				},
			],
		});
		// The cid is current, so freshness is green; the ORIGIN says the record
		// will not follow the next deploy.
		expect(html).toContain('frozen');
		expect(html).toContain('/ipfs/bafycurrent');
	});

	it('leaves BOTH axes blank for a site with no ENS name to ask about', () => {
		const html = renderStatusHtml({
			generated: '2026-07-25T10:11:12.000Z',
			sites: [
				{
					id: 'optout.eth',
					cid: 'bafyoptout',
					mode: 'ipfs',
					ensName: '',
					announced: checkAnswer(true),
					gatewayServes: checkAnswer(true),
				},
			],
		});
		// Nothing to ask -> no verdict at all, never `unknown` and never a cross.
		const row = html.slice(html.indexOf('<tbody>'), html.indexOf('</tbody>'));
		expect(row).not.toContain('unknown');
		expect(row).not.toContain('class="no"');
		expect(row).not.toContain('foreign');
		expect(row).not.toContain('stale');
		// Both axes read as the muted "nothing to report", like the eth.limo cell
		// and, for this keyless ipfs-mode site, the ipns and seq cells: an
		// ipfs-addressed site has no name of ours, so there is no sequence to ask
		// about and the cell must read as not-applicable, never as a failed read.
		expect(row.match(/<span class="none">none<\/span>/g)?.length).toBe(5);
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
					announced: checkAnswer(true),
					gatewayServes: checkUnknown('<script>boom</script>'),
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

describe('renderStatusHtml: the record sequence column', () => {
	function rowFor(site: Parameters<typeof renderStatusHtml>[0]['sites'][0]) {
		const html = renderStatusHtml({
			generated: '2026-07-25T10:11:12.000Z',
			sites: [site],
		});
		return html.slice(html.indexOf('<tbody>'), html.indexOf('</tbody>'));
	}

	it('shows a known sequence as the number', () => {
		const row = rowFor({
			id: 'alice.eth',
			cid: 'bafyalice',
			ipns: 'k51alice',
			sequence: {state: 'known', sequence: 12},
		});
		expect(row).toContain('<code>12</code>');
	});

	it('shows a real sequence of 0 (a first publish is a fact, not a failure)', () => {
		const row = rowFor({
			id: 'alice.eth',
			cid: 'bafyalice',
			ipns: 'k51alice',
			sequence: {state: 'known', sequence: 0},
		});
		// The seq CELL itself carries the number (the announced/gateway cells in
		// this fixture legitimately read `unknown`, so assert the cell, not the row).
		expect(row).toContain('<td><code>0</code></td>');
	});

	it('shows an unreadable sequence NEUTRALLY with its reason, never as a number', () => {
		const row = rowFor({
			id: 'alice.eth',
			cid: 'bafyalice',
			ipns: 'k51alice',
			sequence: {state: 'unknown', reason: 'routing/get failed'},
		});
		expect(row).toContain('unknown (routing/get failed)');
		// The neutral class, NOT the negative indicator: we could not ask.
		expect(row).toContain('class="unknown"');
		expect(row).not.toContain('class="no"');
	});
});

describe('renderStatusHtml: long identifiers stay readable in narrow columns', () => {
	// The live defect (2026-07-30): eleven columns squeezed the cid/ipns cells and
	// `word-break: break-all` shredded a 59-character CIDv1 into a
	// one-character-per-line ribbon, making the whole table unreadable.
	const CID = 'bafybeigbxdgiqmsxwsuocolyhfhlgxf4dgqtfxd4gorw45gcvh5vmdakey';
	const IPNS = 'k51qzi5uqu5dlqzk68fn2fkxlm774pc2qotnpwno7c8lt5d2b3rbqx82lweflz';

	function html() {
		return renderStatusHtml({
			generated: '2026-07-25T10:11:12.000Z',
			sites: [{id: 'ronan.eth', cid: CID, ipns: IPNS}],
		});
	}

	it('middle-elides the cid and ipns in the VISIBLE label', () => {
		const out = html();
		expect(out).toContain('bafybeigbx\u2026mdakey');
		expect(out).toContain('k51qzi5uqu\u2026lweflz');
		// The full opaque string is not rendered as visible text any more.
		expect(out).not.toContain(`<code>${CID}</code>`);
	});

	it('keeps the FULL value in the href and the title, so nothing is lost', () => {
		const out = html();
		expect(out).toContain(`https://${CID}.ipfs.dweb.link/`);
		expect(out).toContain(`title="${CID}"`);
		expect(out).toContain(`https://${IPNS}.ipns.dweb.link/`);
		expect(out).toContain(`title="${IPNS}"`);
	});

	it('no longer breaks identifiers character-by-character', () => {
		expect(html()).not.toContain('word-break: break-all');
	});

	it('leaves a SHORT value untouched (eliding it would cost more than it saves)', () => {
		const out = renderStatusHtml({
			generated: '2026-07-25T10:11:12.000Z',
			sites: [{id: 'x', cid: 'bafyshort', ipns: 'k51short'}],
		});
		expect(out).toContain('<code>bafyshort</code>');
		expect(out).not.toContain('\u2026');
	});

	it('abbreviates a long unknown REASON but keeps the full text in the tooltip', () => {
		// A long reason WITHOUT quotes: escaping is covered elsewhere, and this test
		// is about truncation, so the raw text can be asserted directly.
		const reason =
			'Kubo RPC name/inspect failed with status 500 and a malformed record';
		const out = renderStatusHtml({
			generated: '2026-07-25T10:11:12.000Z',
			sites: [
				{
					id: 'ronan.eth',
					cid: CID,
					ipns: IPNS,
					sequence: {state: 'unknown', reason},
				},
			],
		});
		expect(out).toContain(`title="unknown (${reason})"`);
		// ...but the visible text is one short line, not a wall in a narrow cell.
		const cell = out.slice(out.indexOf('<tbody>'), out.indexOf('</tbody>'));
		const visible = /<span class="unknown"[^>]*>([^<]*)<\/span>/.exec(
			cell,
		)![1]!;
		expect(visible.length).toBeLessThanOrEqual(32);
		expect(visible.endsWith('\u2026')).toBe(true);
	});
});
