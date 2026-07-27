/**
 * The `status` core operation — pinnace's discoverability VERIFICATION surface
 * (CONTEXT.md `gateway warming`; spec user story 18).
 *
 * For every site auto-discovered from MFS `/sites/*` (over the Kubo RPC seam) it
 * reports FOUR fields so an operator can confirm a deploy actually landed
 * everywhere:
 *
 *   1. current CID        — `files/stat --hash` (via {@link discoverSites}).
 *   2. IPNS id            — from `key/list -l` IF a key of the SAME name exists
 *                           (ipfs-mode sites have none).
 *   3. network-announce   — does the NETWORK announce THIS node for the CID? The
 *                           external delegated-routing providers list for the
 *                           CID contains this node's PeerID (`id`).
 *   4. gateway-serves     — does a COLD public gateway serve it? An HTTP
 *                           range/HEAD result from a public gateway.
 *   5. eth.limo-serves    — does the URL a HUMAN visits, `https://<name>.limo/`,
 *                           serve? Probed only for a site that RESOLVES an ENS
 *                           name; a site that resolves none has nothing to
 *                           probe and reports NOT APPLICABLE, never a failure.
 *
 * It ALSO reports what the site's MFS **metadata** says about itself — its
 * stored `mode` and `ensName`, plus the eth.limo name the on-box `warm` rule
 * resolves from them ({@link SiteStatus}) — so the operator can see what the box
 * will DO with a site, not only what it currently holds. That metadata is read
 * once by {@link discoverSites} and carried here; this module resolves nothing
 * of its own beyond calling the warm rule.
 *
 * The checks in (3), (4) and (5) reach OUTSIDE the node. They are INJECTABLE
 * ({@link ProvidersLookup}, {@link GatewayProbe}) so tests run against a fake
 * HTTP layer and never the live network; production supplies the default
 * `fetch`-backed implementations below. (4) and (5) share ONE probe seam — the
 * probe takes a URL, not a cid — so there is a single HTTP surface to fake.
 *
 * Behaviour ported (NOT copied) from the reference prototype
 * `~/searches/ipfs-hetzner/status.sh`: the delegated-routing providers lookup at
 * `https://delegated-ipfs.dev/routing/v1/providers/<cid>` (does
 * `.Providers[].ID` include our PeerID?) and the
 * `https://<cid>.ipfs.dweb.link/` range-request cold-gateway probe. The shell's
 * `jq .Providers[].ID == $PEERID` and `curl -r 0-0 -w %{http_code}` shapes
 * become the two TS predicates here.
 *
 * SEAM NOTE: this module OWNS the per-site status checks; the on-box `status`
 * verb (`../node/node-commands.ts`) consumes them via its injectable
 * `NodeCommandOps.status` seam — {@link makeStatusOp} adapts this core into that
 * seam. The dashboard persistence (`status.json`) is the command layer's job,
 * not this module's: this module PRODUCES the report and stops.
 *
 * A failed external check is a REPORTED outcome, never a throw: a
 * delegated-routing lookup that errors reports `announced=false` (not findable
 * right now) and a gateway probe that errors reports the corresponding
 * `...Serves=false`. One cold gateway, one eth.limo outage or one flaky routing
 * endpoint must not fail the whole report.
 */
import {discoverSites, type DiscoveredSite} from '../node/node-commands.js';
import type {KuboRpcClient} from '../rpc/kubo-rpc-client.js';
import type {NodeCommandContext, NodeOpResult} from '../node/node-commands.js';
import type {SiteMode} from '../config/config-resolution.js';
import {ethLimoUrl, resolveEnsNameToWarm} from '../site/site-wrapper.js';

/** The delegated-routing providers endpoint (path takes the CID). */
const DELEGATED_ROUTING_BASE =
	'https://delegated-ipfs.dev/routing/v1/providers';

/** The public gateway used for the cold-serve probe (`<cid>.ipfs.<host>`). */
const DWEB_LINK_HOST = 'ipfs.dweb.link';

/**
 * The subset of the delegated-routing `/routing/v1/providers/<cid>` JSON we
 * read: the `Providers` array, each with an `ID` (a PeerID). Other fields are
 * ignored.
 */
export interface ProvidersResponse {
	Providers?: Array<{ID?: string}> | null;
}

/**
 * An injectable delegated-routing providers lookup: given a CID, return the
 * providers response (whose `.Providers[].ID` we scan for our PeerID). Tests
 * inject a fake; production uses {@link defaultProvidersLookup}. Throwing is
 * treated as "not findable" (announced=false), never propagated.
 */
export type ProvidersLookup = (cid: string) => Promise<ProvidersResponse>;

/**
 * An injectable cold-gateway probe: given a full URL, return the HTTP status
 * that gateway responds with (a 2xx/206 means it served). Tests inject a fake;
 * production uses {@link defaultGatewayProbe}. Throwing is treated as "did not
 * serve", never propagated.
 *
 * It takes a URL rather than a CID because there are TWO things worth probing —
 * the CID's public gateway ({@link cidGatewayUrl}) and the site's eth.limo name
 * ({@link ../site/site-wrapper.js#ethLimoUrl}) — and ONE probe seam is the whole
 * point: a second probe type would be a second thing to inject, fake and keep
 * honest. The URL is built by this module (the only place a gateway host is
 * named), so the probe stays a dumb `url -> status` HTTP call.
 */
export type GatewayProbe = (url: string) => Promise<number>;

/** The cold-gateway URL for a CID: `https://<cid>.ipfs.dweb.link/`. */
export function cidGatewayUrl(cid: string): string {
	return `https://${cid}.${DWEB_LINK_HOST}/`;
}

/**
 * The status of one site: the report fields, its `id`, and what its MFS
 * **metadata** says — so the operator can see not just what the node HAS but
 * what it will DO with the site (its `mode`, its `ensName`, the eth.limo name
 * `warm` resolves from them).
 */
export interface SiteStatus {
	/** The site's single `id` (its MFS entry under `/sites/`). */
	id: string;
	/** The current content root CID (`files/stat --hash`). */
	cid: string;
	/** The IPNS id, if a same-named keystore key exists (else undefined). */
	ipns?: string;
	/**
	 * The `mode` the site STORES in its `metadata.json` — reported as stored, so
	 * ABSENT (a site placed before metadata existed) stays absent rather than
	 * being resolved to the `ipfs` default. That distinction is load-bearing:
	 * `republish` treats a stored `ipfs` and an absent mode differently.
	 */
	mode?: SiteMode;
	/**
	 * The `ensName` the site STORES, with all THREE of its values kept apart: a
	 * name, `""` (the opt-out) and ABSENT (infer from a `.eth` id) mean three
	 * different things to the warm rule, so `""` is never flattened to absent nor
	 * absent to `""`.
	 */
	ensName?: string;
	/**
	 * The ENS name eth.limo warming will actually target, resolved from the two
	 * fields above by the on-box rule itself
	 * ({@link ../site/site-wrapper.js#resolveEnsNameToWarm}) — never a second copy
	 * of it. `undefined` means this site is not eth.limo-warmed at all.
	 */
	ensNameToWarm?: string;
	/** True when the delegated-routing providers list for the CID has our PeerID. */
	announced: boolean;
	/** The HTTP status the cold public gateway probe returned (undefined on error). */
	gatewayHttp?: number;
	/** True when the gateway probe status indicates the CID was served (2xx/206). */
	gatewayServes: boolean;
	/**
	 * The HTTP status `https://<ensNameToWarm>.limo/` returned. Undefined when the
	 * probe itself errored (eth.limo unreachable) OR when there was nothing to
	 * probe — {@link ethLimoServes} is what tells those apart.
	 */
	ethLimoHttp?: number;
	/**
	 * Whether the site's eth.limo URL SERVED — THREE-valued, deliberately, and
	 * unlike {@link gatewayServes} which is always a boolean:
	 *
	 *  - `true`  — probed, and it served (2xx),
	 *  - `false` — probed, and it did NOT (a non-2xx, or the probe threw),
	 *  - ABSENT  — NOT APPLICABLE: the site resolves no ENS name
	 *    ({@link ensNameToWarm} is undefined), so there is no such URL. A `""`
	 *    opt-out and a non-`.eth` id are not eth.limo failures and must never read
	 *    as one.
	 *
	 * The absent-means-not-applicable shape mirrors `ensNameToWarm` itself (and
	 * the three-valued `ensName` behind it), so the JSON payload simply carries no
	 * key for a site with nothing to probe.
	 */
	ethLimoServes?: boolean;
}

/** The full status report: this node's PeerID plus a per-site status line. */
export interface StatusReport {
	/** This node's PeerID (from Kubo `id`); the announce check looks for it. */
	peerId: string;
	/** One {@link SiteStatus} per site discovered under MFS `/sites/*`. */
	sites: SiteStatus[];
}

/** Inputs to {@link statusReport}. */
export interface StatusReportInput {
	/** The Kubo RPC client for THIS node (files/ls, files/stat, key/list, id). */
	client: KuboRpcClient;
	/** The MFS directory sites live under (default `/sites`). */
	sitesDir?: string;
	/**
	 * The delegated-routing providers lookup (injectable; defaults to the live
	 * `delegated-ipfs.dev` fetch via {@link defaultProvidersLookup}).
	 */
	providersLookup?: ProvidersLookup;
	/**
	 * The cold-gateway probe (injectable; defaults to the live `dweb.link`
	 * range-request via {@link defaultGatewayProbe}).
	 */
	gatewayProbe?: GatewayProbe;
	/**
	 * Pre-discovered sites (optional). When set, discovery is SKIPPED and these
	 * are used as-is — the node-command layer already walked MFS, so the adapter
	 * ({@link makeStatusOp}) passes them straight through rather than re-listing.
	 */
	sites?: DiscoveredSite[];
}

/**
 * Build the per-site status report. Discovers sites (unless supplied), reads
 * this node's PeerID and its keystore once, then for each site runs the two
 * external checks (through the injected/default fakes) to fill the four fields.
 * External-check failures degrade to `false`, never throw.
 */
export async function statusReport(
	input: StatusReportInput,
): Promise<StatusReport> {
	const sitesDir = input.sitesDir ?? '/sites';
	const providersLookup = input.providersLookup ?? defaultProvidersLookup;
	const gatewayProbe = input.gatewayProbe ?? defaultGatewayProbe;

	const sites = input.sites ?? (await discoverSites(input.client, sitesDir));
	const peerId = await readPeerId(input.client);
	const keys = await listKeys(input.client);

	const statuses: SiteStatus[] = [];
	for (const site of sites) {
		const announced = await checkAnnounced(providersLookup, site.cid, peerId);
		const gatewayHttp = await probeGateway(
			gatewayProbe,
			cidGatewayUrl(site.cid),
		);
		// The eth.limo probe is driven by the SAME rule `warm` warms by: a site that
		// resolves no name has no such URL, so it is not probed at all (no wasted
		// request, and nothing that could read as a failure).
		const ensNameToWarm = resolveEnsNameToWarm(site.id, site.metadata);
		const ethLimoHttp =
			ensNameToWarm === undefined
				? undefined
				: await probeGateway(gatewayProbe, ethLimoUrl(ensNameToWarm));
		statuses.push({
			id: site.id,
			cid: site.cid,
			ipns: keys.get(site.id),
			// Reported AS STORED (`undefined` stays `undefined`), then the resolved
			// warm target through the loop's own rule.
			mode: site.metadata.mode,
			ensName: site.metadata.ensName,
			ensNameToWarm,
			announced,
			gatewayHttp,
			gatewayServes: gatewayHttp !== undefined && servesStatus(gatewayHttp),
			ethLimoHttp,
			// NOT APPLICABLE stays absent; a probe that ran (or threw) is a boolean.
			ethLimoServes:
				ensNameToWarm === undefined
					? undefined
					: ethLimoHttp !== undefined && servesStatus(ethLimoHttp),
		});
	}

	return {peerId, sites: statuses};
}

/**
 * Adapt {@link statusReport} into a {@link NodeCommandContext} `status` op so
 * the on-box `status` verb can inject it (its `ops.status` seam). The command
 * layer discovers sites and passes them in; this adapter runs the four-field
 * checks over them and flattens the result into a {@link NodeOpResult} (its
 * per-site outcomes carry the announce + gateway outcomes too, and the result
 * carries this node's `peerId` for the dashboard page's header).
 */
export function makeStatusOp(
	checks: {providersLookup?: ProvidersLookup; gatewayProbe?: GatewayProbe} = {},
): (ctx: NodeCommandContext, sites: DiscoveredSite[]) => Promise<NodeOpResult> {
	return async (ctx, sites) => {
		const report = await statusReport({
			client: ctx.client,
			sitesDir: ctx.sitesDir,
			sites,
			providersLookup: checks.providersLookup,
			gatewayProbe: checks.gatewayProbe,
		});
		return {
			// The PeerID this report already read for the announce check, carried
			// through so the command layer's dashboard page can name the node without
			// a second `id` call. It is NOT part of the `status.json` payload.
			peerId: report.peerId,
			sites: report.sites.map((s) => ({
				id: s.id,
				cid: s.cid,
				ipns: s.ipns ?? '',
				// UNLIKE `ipns` just above, the metadata fields are NEVER coerced: an
				// absent `ensName` must stay absent (JSON.stringify drops it) so the
				// payload keeps it distinct from the stored `""` opt-out.
				mode: s.mode,
				ensName: s.ensName,
				ensNameToWarm: s.ensNameToWarm,
				announced: s.announced,
				gatewayServes: s.gatewayServes,
				gatewayHttp: s.gatewayHttp,
				// Absent (not applicable) survives as absent: JSON.stringify drops an
				// undefined value, so a site with no ENS name carries no key at all.
				ethLimoServes: s.ethLimoServes,
				ethLimoHttp: s.ethLimoHttp,
				// The ok/unverified token stays about the CID (is it announced AND
				// served?), deliberately unchanged: the eth.limo verdict is reported in
				// its own fields so an existing consumer's `status` keeps meaning what
				// it meant. See
				// work/notes/observations/ethlimo-probe-and-warm-outcome-decisions.md.
				status: s.gatewayServes && s.announced ? 'ok' : 'unverified',
			})),
		};
	};
}

// ---------------------------------------------------------------------------
// Per-site checks (fail-soft).
// ---------------------------------------------------------------------------

/**
 * Ask delegated routing who provides the CID and answer: is OUR PeerID among
 * them? A lookup error is "not findable right now" -> false, never thrown (one
 * flaky routing endpoint must not fail the report). Ports the shell's
 * `jq '.Providers[]|select(.ID==$p)'`.
 */
async function checkAnnounced(
	lookup: ProvidersLookup,
	cid: string,
	peerId: string,
): Promise<boolean> {
	if (!peerId) return false;
	try {
		const res = await lookup(cid);
		return (res.Providers ?? []).some((p) => p?.ID === peerId);
	} catch {
		return false;
	}
}

/**
 * Probe one gateway URL and return its HTTP status, or undefined if the probe
 * itself errored (network down, DNS, ...). Ports the shell's
 * `curl -r 0-0 -w %{http_code}`. Used for BOTH probed URLs (the CID gateway and
 * the site's eth.limo name) — one fail-soft wrapper, one seam.
 */
async function probeGateway(
	probe: GatewayProbe,
	url: string,
): Promise<number | undefined> {
	try {
		return await probe(url);
	} catch {
		return undefined;
	}
}

/** A gateway HTTP status counts as "served" iff it is 2xx (including 206). */
function servesStatus(status: number): boolean {
	return status >= 200 && status < 300;
}

// ---------------------------------------------------------------------------
// Kubo reads.
// ---------------------------------------------------------------------------

/** Read this node's PeerID from Kubo `id` (empty string if unavailable). */
async function readPeerId(client: KuboRpcClient): Promise<string> {
	try {
		const res = await client.id<{ID?: string}>();
		return res?.ID ?? '';
	} catch {
		return '';
	}
}

/** Map site/key name -> IPNS id from `key/list -l` (same shape as node-commands). */
async function listKeys(client: KuboRpcClient): Promise<Map<string, string>> {
	const res = await client.keyList<{
		Keys?: Array<{Name?: string; Id?: string}> | null;
	}>();
	const map = new Map<string, string>();
	for (const k of res.Keys ?? []) {
		if (k?.Name && k?.Id) map.set(k.Name, k.Id);
	}
	return map;
}

// ---------------------------------------------------------------------------
// Default (LIVE) external checks. Production wiring; tests inject fakes instead.
// ---------------------------------------------------------------------------

/**
 * The default delegated-routing lookup: GET
 * `https://delegated-ipfs.dev/routing/v1/providers/<cid>` and parse its JSON.
 * (Injected fakes replace this in tests; it is the only place the live routing
 * endpoint is named.)
 */
export const defaultProvidersLookup: ProvidersLookup = async (cid) => {
	const res = await fetch(`${DELEGATED_ROUTING_BASE}/${cid}`, {
		headers: {accept: 'application/json'},
	});
	if (!res.ok) return {Providers: []};
	return (await res.json()) as ProvidersResponse;
};

/**
 * The default cold-gateway probe: a single-byte range request to the given URL
 * (the CID's `https://<cid>.ipfs.dweb.link/`, or the site's
 * `https://<name>.limo/`) returning the HTTP status. It is the ONLY place a
 * live HTTP request is made for the report; injected fakes replace it in tests.
 */
export const defaultGatewayProbe: GatewayProbe = async (url) => {
	const res = await fetch(url, {headers: {range: 'bytes=0-0'}});
	return res.status;
};
