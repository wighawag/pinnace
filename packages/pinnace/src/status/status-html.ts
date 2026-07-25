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
	/** Whether the network announces this node for the CID. */
	announced?: boolean;
	/** Whether a cold public gateway served the CID. */
	gatewayServes?: boolean;
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
			: `\t\t\t<tr><td class="empty" colspan="5">no sites yet (nothing under the node's MFS sites dir)</td></tr>`;

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
			<tr><th>site</th><th>cid</th><th>ipns</th><th>announced</th><th>gateway</th></tr>
		</thead>
		<tbody>
${rows}
		</tbody>
	</table>
	<p class="foot">Static page written by <code>pinnace node status</code> on this node. It shows only this node's own sites.</p>
</body>
</html>
`;
}

/** Render one site's table row: id, gateway-linked cid + ipns, two indicators. */
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
	return (
		`\t\t\t<tr><th scope="row">${escapeHtml(site.id)}</th>` +
		`<td>${cid}</td><td>${ipns}</td>` +
		`<td>${indicator(site.announced)}</td><td>${indicator(site.gatewayServes)}</td></tr>`
	);
}

/** A gateway link: escaped label, escaped href (already URI-encoded). */
function gatewayLink(label: string, href: string): string {
	return `<a href="${escapeHtml(href)}"><code>${escapeHtml(label)}</code></a>`;
}

/** An `ok` / `no` health cell (an absent check renders as `no`, never blank). */
function indicator(value: boolean | undefined): string {
	return value ? '<span class="ok">ok</span>' : '<span class="no">no</span>';
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
	.none, .empty { color: #666; }`;
