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
 *
 * The two checks in (3) and (4) reach OUTSIDE the node. They are INJECTABLE
 * ({@link ProvidersLookup}, {@link GatewayProbe}) so tests run against a fake
 * HTTP layer and never the live network; production supplies the default
 * `fetch`-backed implementations below.
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
 * right now) and a gateway probe that errors reports `gatewayServes=false`. One
 * cold gateway or one flaky routing endpoint must not fail the whole report.
 */
import {discoverSites, type DiscoveredSite} from '../node/node-commands.js';
import type {KuboRpcClient} from '../rpc/kubo-rpc-client.js';
import type {NodeCommandContext, NodeOpResult} from '../node/node-commands.js';

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
 * An injectable cold-gateway probe: given a CID, return the HTTP status a
 * public gateway responds with (a 2xx/206 means it served). Tests inject a
 * fake; production uses {@link defaultGatewayProbe}. Throwing is treated as
 * "did not serve" (gatewayServes=false), never propagated.
 */
export type GatewayProbe = (cid: string) => Promise<number>;

/** The status of one site: the four report fields plus its name. */
export interface SiteStatus {
	/** The MFS entry name under `/sites/` (often the ENS name). */
	name: string;
	/** The current content root CID (`files/stat --hash`). */
	cid: string;
	/** The IPNS id, if a same-named keystore key exists (else undefined). */
	ipns?: string;
	/** True when the delegated-routing providers list for the CID has our PeerID. */
	announced: boolean;
	/** The HTTP status the cold public gateway probe returned (undefined on error). */
	gatewayHttp?: number;
	/** True when the gateway probe status indicates the CID was served (2xx/206). */
	gatewayServes: boolean;
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
		const gatewayHttp = await probeGateway(gatewayProbe, site.cid);
		statuses.push({
			name: site.name,
			cid: site.cid,
			ipns: keys.get(site.name),
			announced,
			gatewayHttp,
			gatewayServes: gatewayHttp !== undefined && servesStatus(gatewayHttp),
		});
	}

	return {peerId, sites: statuses};
}

/**
 * Adapt {@link statusReport} into a {@link NodeCommandContext} `status` op so
 * the on-box `status` verb can inject it (its `ops.status` seam). The command
 * layer discovers sites and passes them in; this adapter runs the four-field
 * checks over them and flattens the result into a {@link NodeOpResult} (its
 * per-site outcomes carry the announce + gateway outcomes too).
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
			sites: report.sites.map((s) => ({
				name: s.name,
				cid: s.cid,
				ipns: s.ipns ?? '',
				announced: s.announced,
				gatewayServes: s.gatewayServes,
				gatewayHttp: s.gatewayHttp,
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
 * Probe a cold public gateway for the CID and return its HTTP status, or
 * undefined if the probe itself errored (network down, DNS, ...). Ports the
 * shell's `curl -r 0-0 -w %{http_code}`.
 */
async function probeGateway(
	probe: GatewayProbe,
	cid: string,
): Promise<number | undefined> {
	try {
		return await probe(cid);
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
 * The default cold-gateway probe: a single-byte range request to
 * `https://<cid>.ipfs.dweb.link/` returning the HTTP status. (Injected fakes
 * replace this in tests; it is the only place the live gateway is named.)
 */
export const defaultGatewayProbe: GatewayProbe = async (cid) => {
	const res = await fetch(`https://${cid}.${DWEB_LINK_HOST}/`, {
		headers: {range: 'bytes=0-0'},
	});
	return res.status;
};
