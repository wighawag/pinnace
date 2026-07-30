/**
 * The dashboard RENDERER: the human view of the `status` report.
 *
 * `pinnace node status` already produces a machine-readable report and the
 * command layer writes it as `status.json` into the node's dashboard dir (a
 * Caddy `file_server` vhost). This module turns the SAME data into an
 * `index.html` so `https://<dashboard-domain>/` shows a readable per-site table
 * instead of raw JSON. It re-gathers NOTHING: the report is passed in.
 *
 * The renderer is a PURE function ({@link renderStatusHtml}): report in, HTML
 * string out. No clock, no filesystem, no network, so it is unit-testable on a
 * fixture, and the command layer (`../node/node-commands.ts`) owns the write
 * (dashboard dir ONLY, never a global path).
 *
 * The page is a SINGLE self-contained static file: inline CSS, no external
 * assets, and NO client-side JS (the data is baked in at render time). Its only
 * outbound URLs are the per-site public-gateway links.
 *
 * Its imports are two sibling LEAVES that resolve nothing — {@link ensNameDisplay}
 * (which only reads the two report fields this row already holds) and the
 * three-valued {@link ./check-outcome.js} vocabulary; the view stays free of the
 * report/warm cores it must not depend on.
 *
 * HONESTY: a health cell shows THREE states, never two. A check that could not
 * RUN renders as a NEUTRAL `unknown (<reason>)`, never as the red negative —
 * the standing repo rule (`CONTEXT.md` `## Conventions`). An ABSENT verdict is
 * read the same way: a report that carries no answer did not check.
 *
 * FRESHNESS: the page cannot push, so it pulls: a
 * `<meta http-equiv="refresh" content="<seconds>">` makes the browser
 * re-request it periodically and pick up whatever the on-box `status` timer last
 * rendered. Meta-refresh (an HTML mechanism), NOT JS, so the "no required client
 * JS" property holds. The default {@link DEFAULT_STATUS_REFRESH_SECONDS} is
 * chosen RELATIVE to that timer's ~15min cadence (see the `status` timer's
 * `onUnitActiveSec` in ../provision/cloud-init.ts): a much faster reload would
 * just re-fetch identical bytes. The rendered `generated` timestamp is shown
 * prominently so a viewer sees the real data age regardless of reload timing.
 */
import {ensNameDisplay, type EnsNameDisplay} from './ens-name-display.js';
import {
	checkState,
	printedSequence,
	type CheckOutcome,
	type RecordSequence,
} from './check-outcome.js';
import type {EthLimoFreshness, EthLimoOrigin} from './ethlimo-resolution.js';

/**
 * How often the rendered page tells the browser to re-request it, in seconds.
 * 300s (5min) against the ~15min `status`-timer cadence: fresh within a third
 * of a regeneration cycle, without hammering the vhost for identical bytes. A
 * NAMED knob (never a bare literal) and overridable per render via
 * {@link RenderStatusHtmlOptions.refreshSeconds}.
 */
export const DEFAULT_STATUS_REFRESH_SECONDS = 300;

/** The public gateway subdomain host used for CID links (`<cid>.ipfs.<host>`). */
const IPFS_GATEWAY_HOST = 'ipfs.dweb.link';

/** The public gateway subdomain host used for IPNS links (`<id>.ipns.<host>`). */
const IPNS_GATEWAY_HOST = 'ipns.dweb.link';

/** The eth.limo gateway host a resolved `ensName` is warmed (and linked) at. */
const ETH_LIMO_HOST = 'limo';

/**
 * One site row's data. Deliberately WIDER than
 * {@link ../status/status-report.js#SiteStatus}: every field but `id` is
 * optional so BOTH shapes the box has at hand render: a `SiteStatus` from the
 * `status` core and a `SiteOutcome` from the command layer's uniform result
 * (whose `cid`/`announced`/`gatewayServes` are optional and whose `ipns` may be
 * the empty string for an ipfs-mode site).
 */
export interface StatusPageSite {
	/** The site's single `id` (its MFS entry under `/sites/`). */
	id: string;
	/** The current content root CID, linked to a public gateway. */
	cid?: string;
	/** The IPNS id when the site has a key (absent/empty for ipfs-mode sites). */
	ipns?: string;
	/**
	 * The sequence of the record THIS node holds for {@link ipns} — which record
	 * wins. ABSENT means not applicable (no key here, so no name of ours to ask
	 * about) and renders as `none`, never as a fault; `unknown` renders neutrally
	 * WITH its reason, and is never shown as a number.
	 *
	 * Its value is in COMPARING it across each node's own dashboard: a new
	 * publisher stuck at a lower sequence than the box it replaced has not taken
	 * over the name, however green everything else looks.
	 */
	sequence?: RecordSequence;
	/**
	 * The `mode` the site stores in its MFS metadata (`ipfs`/`ipns`), or absent
	 * for a site that stores none. Rendered AS STORED, never resolved to a
	 * default, so the page shows what the box will read.
	 */
	mode?: string;
	/**
	 * The `ensName` the site stores, three-valued: a name, `""` (the opt-out) or
	 * absent (infer from a `.eth` id). The three render DIFFERENTLY — an opt-out
	 * must not look like a site that simply never set one. An ABSENT one is read
	 * TOGETHER with {@link ensNameToWarm}, so a `.eth` site with no stored name
	 * shows the INFERRED name it warms instead of `none` (see
	 * {@link ./ens-name-display.js#ensNameDisplay}).
	 */
	ensName?: string;
	/**
	 * The ENS name eth.limo warming actually targets, already resolved by the
	 * report (the on-box `resolveEnsNameToWarm` rule); absent means not warmed.
	 * The renderer resolves NOTHING itself — it stays a pure view.
	 */
	ensNameToWarm?: string;
	/**
	 * Whether `https://<ensNameToWarm>.limo/` — the URL a HUMAN visits — served
	 * when the report probed it. FOUR display states, which is why this is not
	 * just another indicator column: `yes` served, `no` it answered and did not,
	 * `unknown` the probe could not be MADE (rendered neutrally, with its reason),
	 * and ABSENT nothing was probed at all (the site resolves no name, or the
	 * report came from a path that does no probing). An absent verdict renders as
	 * NO verdict rather than `no`, so "nothing to probe" never looks like
	 * "eth.limo is broken", and `unknown` keeps "could not check" apart from it.
	 */
	ethLimoServes?: CheckOutcome;
	/**
	 * Whether the ENS name resolves through THIS site's identity, or through some
	 * other name/cid ({@link ./ethlimo-resolution.js#EthLimoOrigin}). ABSENT means
	 * the report asked nothing (no ENS name to resolve, or a path that does no
	 * probing), and renders as no verdict rather than a negative.
	 */
	ethLimoOrigin?: EthLimoOrigin;
	/**
	 * Whether the root eth.limo served is this site's CURRENT cid
	 * ({@link ./ethlimo-resolution.js#EthLimoFreshness}). `stale` is an ATTENTION
	 * state, deliberately NOT the red negative: a gateway lagging a fresh deploy
	 * is normal propagation, not a fault. ABSENT again means nothing was asked.
	 */
	ethLimoFreshness?: EthLimoFreshness;
	/**
	 * Whether the network announces this node for the CID: `yes`/`no`/`unknown`
	 * with its reason. Absent means the report ran no such check, which renders
	 * as `unknown` too — never as a negative.
	 */
	announced?: CheckOutcome;
	/** Whether a cold public gateway served the CID (same three states). */
	gatewayServes?: CheckOutcome;
}

/**
 * What the page renders: the node identity, WHEN the data was gathered, and one
 * row per site. A {@link ../status/status-report.js#StatusReport} plus the
 * `generated` stamp the command layer writes into `status.json` satisfies this.
 */
export interface StatusPageReport {
	/** This node's PeerID (rendered as `unknown` when the node did not report one). */
	peerId?: string;
	/** ISO-8601 timestamp of when the report was produced (the freshness signal). */
	generated: string;
	/** One row per site discovered under MFS `/sites/*`. */
	sites: readonly StatusPageSite[];
}

/** Knobs for {@link renderStatusHtml}. */
export interface RenderStatusHtmlOptions {
	/**
	 * The meta-refresh interval in seconds. Defaults to
	 * {@link DEFAULT_STATUS_REFRESH_SECONDS}; normalised to a whole second >= 1
	 * (a meta-refresh takes an integer).
	 */
	refreshSeconds?: number;
}

/**
 * Render a status report as a single self-contained HTML page (inline CSS, no
 * external assets, no client JS, meta-refresh auto-reload). PURE: same report
 * in, same bytes out. Every report-supplied string is HTML-escaped, and the
 * gateway links are URL-component-encoded, so an odd site `id`/`cid`/`ipns` can
 * neither break the markup nor escape an attribute.
 */
export function renderStatusHtml(
	report: StatusPageReport,
	options: RenderStatusHtmlOptions = {},
): string {
	const refresh = Math.max(
		1,
		Math.round(options.refreshSeconds ?? DEFAULT_STATUS_REFRESH_SECONDS),
	);
	const peerId = report.peerId ? escapeHtml(report.peerId) : 'unknown';
	const generated = escapeHtml(report.generated);
	const rows =
		report.sites.length > 0
			? report.sites.map(renderSiteRow).join('\n')
			: `\t\t\t<tr><td class="empty" colspan="10">no sites yet (nothing under the node's MFS sites dir)</td></tr>`;

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="refresh" content="${refresh}" />
<title>pinnace node status</title>
<style>
${PAGE_CSS}
</style>
</head>
<body>
	<h1>pinnace node status</h1>
	<p class="meta">node <code>${peerId}</code></p>
	<p class="meta">generated <time datetime="${generated}">${generated}</time>, reloading every ${refresh}s</p>
	<table>
		<thead>
			<tr><th>site</th><th>cid</th><th>ipns</th><th>seq</th><th>mode</th><th>ens name</th><th>eth.limo</th><th>origin</th><th>freshness</th><th>announced</th><th>gateway</th></tr>
		</thead>
		<tbody>
${rows}
		</tbody>
	</table>
	<p class="foot">Static page written by <code>pinnace node status</code> on this node. It shows only this node's own sites. The <em>origin</em> and <em>freshness</em> columns report what eth.limo resolved and served through its own cache, not a read of the ENS record: a <em>stale</em> cid shortly after a deploy is normal propagation lag.</p>
</body>
</html>
`;
}

/**
 * Render one site's table row: id, gateway-linked cid + ipns, the `mode` its
 * MFS metadata stores, its ENS name (stored or inferred, see
 * {@link renderEnsName}), the eth.limo name that resolves to AND whether it
 * serves, the two eth.limo resolution axes (origin + freshness), then the two
 * CID health indicators.
 */
function renderSiteRow(site: StatusPageSite): string {
	const cid = site.cid
		? gatewayLink(
				site.cid,
				`https://${uriPart(site.cid)}.${IPFS_GATEWAY_HOST}/`,
			)
		: '<span class="none">none</span>';
	const ipns = site.ipns
		? gatewayLink(
				site.ipns,
				`https://${uriPart(site.ipns)}.${IPNS_GATEWAY_HOST}/`,
			)
		: '<span class="none">none</span>';
	// The record sequence: a plain number when known, the reason when not, and
	// `none` when this node holds no key for the site. Never a bare 0 for an
	// unread sequence (that IS the failure this column exposes).
	const sequence =
		site.sequence === undefined
			? '<span class="none">none</span>'
			: site.sequence.state === 'known'
				? `<code>${escapeHtml(printedSequence(site.sequence))}</code>`
				: `<span class="unknown">${escapeHtml(printedSequence(site.sequence))}</span>`;
	const mode = site.mode
		? `<code>${escapeHtml(site.mode)}</code>`
		: '<span class="none">none</span>';
	// The FOUR ensName states read differently on the page (ensNameDisplay): a
	// stored name, an INFERRED one (the name the box warms, marked so it is not
	// mistaken for an override the site stores), the explicit opt-out, and a site
	// with no name at all.
	const ensName = renderEnsName(ensNameDisplay(site));
	// The eth.limo cell answers BOTH questions: which name would be warmed, and
	// does it actually serve? The verdict is appended only when the report HAS
	// one (see StatusPageSite.ethLimoServes) — a site with no name to probe shows
	// `none` and no red flag.
	const ethLimo = site.ensNameToWarm
		? gatewayLink(
				`${site.ensNameToWarm}.${ETH_LIMO_HOST}`,
				`https://${uriPart(site.ensNameToWarm)}.${ETH_LIMO_HOST}/`,
			) +
			(site.ethLimoServes === undefined
				? ''
				: ` ${indicator(site.ethLimoServes)}`)
		: '<span class="none">none</span>';
	return (
		`\t\t\t<tr><th scope="row">${escapeHtml(site.id)}</th>` +
		`<td>${cid}</td><td>${ipns}</td><td>${sequence}</td>` +
		`<td>${mode}</td><td>${ensName}</td><td>${ethLimo}</td>` +
		`<td>${renderOrigin(site.ethLimoOrigin)}</td>` +
		`<td>${renderFreshness(site.ethLimoFreshness)}</td>` +
		`<td>${indicator(site.announced)}</td><td>${indicator(site.gatewayServes)}</td></tr>`
	);
}

/**
 * The `origin` cell: is the ENS name resolving through THIS site?
 *
 *  - `ours`    — green, like any other answered-yes,
 *  - `foreign` — the RED negative, NAMING what it points at instead: this is
 *    the one state that is a genuine "we asked, and the answer is no", and the
 *    whole reason the column exists (a live box was green everywhere while
 *    eth.limo served through another publisher's name),
 *  - `frozen`  — ATTENTION (not red): the record is a valid immutable cid, it
 *    just will not follow the next deploy,
 *  - `unknown` — NEUTRAL, with its reason,
 *  - ABSENT    — nothing was asked (the site resolves no ENS name), so no
 *    verdict at all.
 *
 * It reports what ETH.LIMO RESOLVED (through its cache), never a read of the
 * ENS record — the column header stays `origin` for that reason, and the page's
 * footer note says so.
 */
function renderOrigin(origin: EthLimoOrigin | undefined): string {
	if (origin === undefined) return '<span class="none">none</span>';
	switch (origin.state) {
		case 'ours':
			return '<span class="ok">ours</span>';
		case 'foreign':
			return (
				'<span class="no">foreign</span> ' +
				`<code>${escapeHtml(origin.path)}</code>`
			);
		case 'frozen':
			return (
				'<span class="warn">frozen</span> ' +
				`<code>${escapeHtml(origin.path)}</code>`
			);
		case 'unknown':
			return `<span class="unknown">unknown (${escapeHtml(origin.reason)})</span>`;
	}
}

/**
 * The `freshness` cell: is the served root this site's CURRENT cid? `current`
 * is green; `stale` NAMES the served cid in a NEUTRAL attention style, never
 * the red negative (a gateway lagging a fresh deploy is normal propagation, and
 * cids that differ only in encoding read as stale too); `unknown` carries its
 * reason; ABSENT means nothing was asked.
 */
function renderFreshness(freshness: EthLimoFreshness | undefined): string {
	if (freshness === undefined) return '<span class="none">none</span>';
	switch (freshness.state) {
		case 'current':
			return '<span class="ok">current</span>';
		case 'stale':
			return (
				'<span class="warn">stale</span> ' +
				`<code>${escapeHtml(freshness.servedCid)}</code>`
			);
		case 'unknown':
			return `<span class="unknown">unknown (${escapeHtml(freshness.reason)})</span>`;
	}
}

/**
 * Render the `ens name` cell from its display state: the NAME in `<code>` when
 * there is one, with an inferred name carrying a muted `(inferred)` hint so it
 * stays visually distinct from a stored one (an inferred name FOLLOWS the
 * `.eth` id, a stored one OVERRIDES it — not the same thing). The two nameless
 * states keep the muted `.none` styling that already tells an opt-out apart
 * from a site that simply has none.
 */
function renderEnsName(display: EnsNameDisplay): string {
	switch (display.kind) {
		case 'stored':
			return `<code>${escapeHtml(display.name)}</code>`;
		case 'inferred':
			return (
				`<code>${escapeHtml(display.name)}</code> ` +
				'<span class="inferred">(inferred)</span>'
			);
		case 'opted-out':
			return '<span class="none">opted out</span>';
		case 'none':
			return '<span class="none">none</span>';
	}
}

/** A gateway link: escaped label, escaped href (already URI-encoded). */
function gatewayLink(label: string, href: string): string {
	return `<a href="${escapeHtml(href)}"><code>${escapeHtml(label)}</code></a>`;
}

/**
 * A health cell, in THREE states: `ok` (green), `no` (red — the check RAN and
 * answered no) and a NEUTRAL `unknown (<reason>)` for a check that could not
 * run. An ABSENT verdict renders as `unknown` too: a report that carries no
 * answer did not check, and the red cross would claim a negative nobody
 * measured (the live-box bug: a rate-limited providers lookup painted `no` for
 * a site the router WAS listing).
 */
function indicator(outcome: CheckOutcome | undefined): string {
	switch (checkState(outcome)) {
		case 'yes':
			return '<span class="ok">ok</span>';
		case 'no':
			return '<span class="no">no</span>';
		case 'unknown': {
			// The reason is report-supplied, so it is escaped like every other string.
			const reason =
				outcome?.state === 'unknown' ? ` (${escapeHtml(outcome.reason)})` : '';
			return `<span class="unknown">unknown${reason}</span>`;
		}
	}
}

/**
 * Encode a report string for use as a URL component (a subdomain label here).
 * Valid CIDs/IPNS ids pass through unchanged; anything unexpected is encoded
 * rather than injected into the link.
 */
function uriPart(value: string): string {
	return encodeURIComponent(value);
}

/** Escape the five HTML-significant characters (text AND attribute contexts). */
function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

/** The page's INLINE stylesheet (no external asset may be required). */
const PAGE_CSS = `	:root { color-scheme: light dark; }
	body {
		margin: 2rem auto; max-width: 60rem; padding: 0 1rem;
		font: 16px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
	}
	h1 { font-size: 1.4rem; margin-bottom: 0.25rem; }
	.meta { margin: 0.25rem 0; color: #666; font-size: 0.9rem; }
	.foot { margin-top: 1.5rem; color: #666; font-size: 0.8rem; }
	table { border-collapse: collapse; width: 100%; margin-top: 1.5rem; }
	th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid #8883; }
	thead th { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; color: #666; }
	code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85rem; word-break: break-all; }
	.ok { color: #157f3d; font-weight: 600; }
	.no { color: #b3261e; font-weight: 600; }
	/* ATTENTION, deliberately NOT the .no red: a stale cid or a frozen ENS record
	   is something to look at, not a failed check. */
	.warn { color: #8a6100; font-weight: 600; }
	.none, .empty, .inferred, .unknown { color: #666; }`;
