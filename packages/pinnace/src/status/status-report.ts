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
 *   6. eth.limo ORIGIN +  — and is what it serves OURS, and CURRENT? Read from
 *      FRESHNESS            that same probe's `x-ipfs-path` / `x-ipfs-roots`
 *                           headers ({@link ./ethlimo-resolution.js}), because
 *                           "it responds" was green on a live box whose ENS
 *                           pointed at somebody else's name entirely.
 *
 * Each of (3), (4) and (5) answers in THREE values — yes / no / unknown-with-a-
 * reason ({@link ./check-outcome.js}) — because a check that could not RUN must
 * never report a definitive negative (see the closing note below). (6) is two
 * INDEPENDENT axes with their own small vocabularies, on the same principle.
 *
 * What (6) does NOT do: it does not read the ENS record. It observes what
 * eth.limo RESOLVED AND SERVED through its own cache, so it cannot tell a wrong
 * contenthash from a stale gateway cache — see the honesty note in
 * {@link ./ethlimo-resolution.js}, which every operator-facing wording of these
 * two axes must respect.
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
 * A failed external check is a REPORTED outcome, never a throw: one cold
 * gateway, one eth.limo outage or one flaky routing endpoint must not fail the
 * whole report. But it is reported HONESTLY: each of the three checks is
 * THREE-valued ({@link ./check-outcome.js}), so a check that could not RUN
 * reports `unknown` WITH its reason and never a confident negative. That is the
 * repo convention (`CONTEXT.md` `## Conventions`) and this module is its worked
 * example: a live box once reported `announced=false` for a site the delegated
 * router was, at that moment, listing correctly.
 */
import {discoverSites, type DiscoveredSite} from '../node/node-commands.js';
import {
	checkAnswer,
	checkUnknown,
	CheckUnavailableError,
	isYes,
	unavailableReason,
	type CheckOutcome,
} from './check-outcome.js';
import type {KuboRpcClient} from '../rpc/kubo-rpc-client.js';
import type {NodeCommandContext, NodeOpResult} from '../node/node-commands.js';
import type {SiteMode} from '../config/config-resolution.js';
import {
	classifyEthLimoResolution,
	unknownEthLimoResolution,
	type EthLimoFreshness,
	type EthLimoOrigin,
	type EthLimoResolution,
} from './ethlimo-resolution.js';
import {ethLimoUrl, resolveEnsNameToWarm} from '../site/site-wrapper.js';
import {
	readRecordSequence,
	type RecordSequence,
} from '../publisher/ipns-sequence.js';

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
 * inject a fake; production uses {@link defaultProvidersLookup}.
 *
 * A lookup RESOLVES only when the router actually answered — an empty
 * `Providers` list then means "the router answered, and your peer is not in
 * it", a real negative. A lookup that could NOT be made must THROW (ideally a
 * {@link CheckUnavailableError} carrying a short reason such as `http 429`):
 * the throw is caught and reported as `unknown`, never propagated, and never
 * flattened into an empty list.
 */
export type ProvidersLookup = (cid: string) => Promise<ProvidersResponse>;

/**
 * What ONE gateway probe answered: the HTTP status, plus the response headers
 * it came with. The headers are part of the SAME answer (an IPFS gateway states
 * what it resolved and what it served in `x-ipfs-path` / `x-ipfs-roots`), so
 * they ride on the one result object rather than justifying a second probe.
 */
export interface GatewayProbeResult {
	/** The HTTP status the gateway answered with (a 2xx/206 means it served). */
	status: number;
	/**
	 * The response headers, keyed by header name. `fetch` yields them LOWER-CASE
	 * and {@link defaultGatewayProbe} passes them through as such; readers look
	 * them up case-insensitively anyway. Absent from a fake that has nothing to
	 * say about headers, which reads as "no such header" — an `unknown` on the
	 * axes that need them, never a negative.
	 */
	headers?: Readonly<Record<string, string>>;
}

/**
 * An injectable cold-gateway probe: given a full URL, return what that gateway
 * answered ({@link GatewayProbeResult}: the status, and the headers it came
 * with). Tests inject a fake; production uses {@link defaultGatewayProbe}. A
 * RETURNED non-2xx is the gateway answering that it did not serve (a real
 * negative); THROWING means the probe could not be made at all, which is
 * reported as `unknown` and never propagated.
 *
 * It takes a URL rather than a CID because there are TWO things worth probing —
 * the CID's public gateway ({@link cidGatewayUrl}) and the site's eth.limo name
 * ({@link ../site/site-wrapper.js#ethLimoUrl}) — and ONE probe seam is the whole
 * point: a second probe type would be a second thing to inject, fake and keep
 * honest. That is also why the ORIGIN/FRESHNESS axes widened THIS result rather
 * than adding a header-reading probe beside it. The URL is built by this module
 * (the only place a gateway host is named), so the probe stays a dumb
 * `url -> answer` HTTP call that interprets nothing.
 */
export type GatewayProbe = (url: string) => Promise<GatewayProbeResult>;

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
	 * The SEQUENCE number of the record this node currently holds/sees for
	 * {@link ipns} — the number that decides which record WINS (highest unexpired
	 * sequence), and therefore the one fact that tells an operator whether a
	 * failover actually took or whether two boxes are racing one name.
	 *
	 * ABSENT means NOT APPLICABLE (this node has no key for the site, so there is
	 * no name of ours to ask about), exactly as {@link ethLimoServes} uses
	 * absence. When present it is {@link RecordSequence}: `known` with the number,
	 * or `unknown` WITH THE REASON — never a fallback 0, because a spurious 0 is
	 * precisely the failure this field exists to expose.
	 *
	 * Meaningful mainly when COMPARED ACROSS NODES: one node's number proves
	 * nothing on its own about who is winning in the DHT.
	 */
	sequence?: RecordSequence;
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
	/**
	 * Does the NETWORK announce this node for the CID? THREE-valued
	 * ({@link CheckOutcome}): `yes` the delegated-routing providers list contains
	 * our PeerID, `no` it ANSWERED and does not, `unknown` the lookup could not be
	 * made at all (rate-limited, unreachable, unparsable, or no PeerID to compare)
	 * — with the reason. A failed lookup is NOT a negative.
	 */
	announced: CheckOutcome;
	/**
	 * The HTTP status the cold public gateway ANSWERED with; absent when the probe
	 * could not be made at all (then {@link gatewayServes} is `unknown`).
	 */
	gatewayHttp?: number;
	/**
	 * Did a cold public gateway serve the CID? THREE-valued: `yes` (2xx/206),
	 * `no` (it answered something else — a real negative), `unknown` (the probe
	 * could not be made, with the reason).
	 */
	gatewayServes: CheckOutcome;
	/**
	 * The HTTP status `https://<ensNameToWarm>.limo/` ANSWERED with. Absent when
	 * the probe could not be made (eth.limo unreachable) OR when there was nothing
	 * to probe — {@link ethLimoServes} is what tells those apart.
	 */
	ethLimoHttp?: number;
	/**
	 * Whether the site's eth.limo URL SERVED — FOUR display states, because the
	 * three-valued {@link CheckOutcome} sits inside an OPTIONAL field:
	 *
	 *  - `{state: 'yes'}`     — probed, and it served (2xx),
	 *  - `{state: 'no'}`      — probed, it ANSWERED, and it did not serve,
	 *  - `{state: 'unknown'}` — probed, but the probe could not be MADE (with the
	 *    reason): eth.limo being unreachable is not eth.limo refusing to serve,
	 *  - ABSENT               — NOT APPLICABLE: the site resolves no ENS name
	 *    ({@link ensNameToWarm} is undefined), so there is no such URL. A `""`
	 *    opt-out and a non-`.eth` id are not eth.limo failures and must never read
	 *    as one.
	 *
	 * "Nothing to check" and "could not check" are DIFFERENT answers, so they stay
	 * apart: the absent-means-not-applicable shape mirrors `ensNameToWarm` itself
	 * (and the three-valued `ensName` behind it), so the JSON payload simply
	 * carries no key for a site with nothing to probe.
	 */
	ethLimoServes?: CheckOutcome;
	/**
	 * Does the ENS name resolve through THIS site's identity — or is eth.limo
	 * serving through some OTHER name/cid? ({@link EthLimoOrigin}: `ours`,
	 * `foreign` naming what it points at, `frozen` for an immutable ENS
	 * contenthash under a name-publishing site, `unknown` with a reason.) ABSENT
	 * means NOT APPLICABLE — the site resolves no ENS name, so there was nothing
	 * to ask — exactly as {@link ethLimoServes} uses absence.
	 *
	 * Read from the probe's `x-ipfs-path` header: this is what eth.limo RESOLVED,
	 * through its cache, NOT a read of the ENS record.
	 */
	ethLimoOrigin?: EthLimoOrigin;
	/**
	 * Is the root eth.limo served this site's CURRENT cid?
	 * ({@link EthLimoFreshness}: `current`, `stale` naming the served cid,
	 * `unknown` with a reason; ABSENT = not applicable.) INDEPENDENT of
	 * {@link ethLimoOrigin} — the live regression is a foreign origin serving a
	 * current cid — and `stale` is an ATTENTION state, not a fault: post-deploy
	 * propagation/cache lag is normal.
	 */
	ethLimoFreshness?: EthLimoFreshness;
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
 * this node's PeerID and its keystore once, then for each site runs the three
 * external checks (through the injected/default implementations) to fill the
 * report fields — including the two eth.limo resolution axes, which read the
 * headers the eth.limo probe already answered with rather than probing again.
 * A failed external check is recorded as `unknown` (with its reason), never as
 * a negative and never thrown.
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
		const gateway = await probeServes(gatewayProbe, cidGatewayUrl(site.cid));
		// The eth.limo probe is driven by the SAME rule `warm` warms by: a site that
		// resolves no name has no such URL, so it is not probed at all (no wasted
		// request, and nothing that could read as a failure).
		const ensNameToWarm = resolveEnsNameToWarm(site.id, site.metadata);
		const ethLimo =
			ensNameToWarm === undefined
				? undefined
				: await probeServes(gatewayProbe, ethLimoUrl(ensNameToWarm));
		// The two mismatch axes come out of the SAME answer the probe just gave —
		// no second request, no second seam. A site with nothing to probe gets no
		// verdict at all (not applicable), which is not the same as `unknown`.
		// Only a site this node holds a key for has a name of OURS to ask about; for
		// anything else there is no question to answer (absent, not `unknown`).
		const ipns = keys.get(site.id);
		const sequence =
			ipns === undefined
				? undefined
				: await readRecordSequence(input.client, ipns);
		const resolution =
			ethLimo === undefined
				? undefined
				: ethLimoResolutionOf(ethLimo, {
						cid: site.cid,
						ipns,
						mode: site.metadata.mode,
						ensName: ensNameToWarm,
					});
		statuses.push({
			id: site.id,
			cid: site.cid,
			ipns,
			// Absent when there is no key here (nothing to ask); otherwise the
			// three-valued read, whose `unknown` never collapses to a number.
			sequence,
			// Reported AS STORED (`undefined` stays `undefined`), then the resolved
			// warm target through the loop's own rule.
			mode: site.metadata.mode,
			ensName: site.metadata.ensName,
			ensNameToWarm,
			announced,
			gatewayHttp: gateway.http,
			gatewayServes: gateway.serves,
			ethLimoHttp: ethLimo?.http,
			// NOT APPLICABLE stays absent; a probe that was MADE carries its
			// three-valued outcome (served / did not / could not be made).
			ethLimoServes: ethLimo?.serves,
			ethLimoOrigin: resolution?.origin,
			ethLimoFreshness: resolution?.freshness,
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
				// Absent-means-not-applicable survives into the payload, and an
				// `unknown` travels WITH its reason rather than as a bare number.
				sequence: s.sequence,
				announced: s.announced,
				gatewayServes: s.gatewayServes,
				gatewayHttp: s.gatewayHttp,
				// Absent (not applicable) survives as absent: JSON.stringify drops an
				// undefined value, so a site with no ENS name carries no key at all.
				ethLimoServes: s.ethLimoServes,
				ethLimoHttp: s.ethLimoHttp,
				// The two mismatch axes travel with it, absent-means-not-applicable and
				// all: a site with no name to probe carries no key for either.
				ethLimoOrigin: s.ethLimoOrigin,
				ethLimoFreshness: s.ethLimoFreshness,
				// The ok/unverified token stays about the CID (is it announced AND
				// served?), deliberately unchanged: the eth.limo verdict is reported in
				// its own fields so an existing consumer's `status` keeps meaning what
				// it meant. See
				// work/notes/observations/ethlimo-probe-and-warm-outcome-decisions.md.
				// Only a definite YES on both counts is `ok`: an UNKNOWN check verifies
				// nothing, so it rolls up as `unverified` — which is exactly what that
				// token means — and never as a failure of its own.
				status:
					isYes(s.gatewayServes) && isYes(s.announced) ? 'ok' : 'unverified',
			})),
		};
	};
}

// ---------------------------------------------------------------------------
// Per-site checks (fail-soft).
// ---------------------------------------------------------------------------

/**
 * Ask delegated routing who provides the CID and answer: is OUR PeerID among
 * them? THREE-valued, and never thrown (one flaky routing endpoint must not
 * fail the report):
 *
 *  - the lookup ANSWERED and lists us            -> `yes`,
 *  - the lookup ANSWERED and does not list us    -> `no` (the true negative),
 *  - the lookup could not be MADE (it threw: a non-2xx, a network/DNS error, an
 *    unparsable body) or we have no PeerID to compare -> `unknown` + reason.
 *
 * The `unknown` branch is the whole point: a rate-limited (429) lookup says
 * NOTHING about whether the network announces us, and reporting `false` there
 * is a confident negative we did not earn. Ports the shell's
 * `jq '.Providers[]|select(.ID==$p)'`.
 */
async function checkAnnounced(
	lookup: ProvidersLookup,
	cid: string,
	peerId: string,
): Promise<CheckOutcome> {
	// We could not even identify this node, so there is nothing to look for: that
	// is a check we could not run, not a site that is unannounced.
	if (!peerId) return checkUnknown('no peer id');
	try {
		const res = await lookup(cid);
		return checkAnswer((res.Providers ?? []).some((p) => p?.ID === peerId));
	} catch (error) {
		return checkUnknown(unavailableReason(error));
	}
}

/** What one gateway probe produced: the status it ANSWERED with, and the verdict. */
interface ProbeOutcome {
	/** The HTTP status the gateway answered with; absent if it never answered. */
	http?: number;
	/** yes (2xx), no (answered otherwise), unknown (the probe could not be made). */
	serves: CheckOutcome;
	/** The headers it answered with; absent if it never answered (or said none). */
	headers?: Readonly<Record<string, string>>;
}

/**
 * Probe one gateway URL and report whether it SERVED — fail-soft, never thrown.
 * Ports the shell's `curl -r 0-0 -w %{http_code}`. Used for BOTH probed URLs
 * (the CID gateway and the site's eth.limo name) — one wrapper, one seam.
 *
 * The distinction that matters: a gateway that ANSWERS a non-2xx (a cold 504, a
 * 404) has told us it does not serve the content, so that is a real `no`; a
 * probe that could not be MADE at all (network down, DNS, TLS) tells us nothing
 * about the gateway, so it is `unknown` with its reason.
 */
async function probeServes(
	probe: GatewayProbe,
	url: string,
): Promise<ProbeOutcome> {
	try {
		const {status, headers} = await probe(url);
		return {http: status, headers, serves: checkAnswer(servesStatus(status))};
	} catch (error) {
		return {serves: checkUnknown(unavailableReason(error))};
	}
}

/**
 * The two eth.limo axes for one site, from the probe that ALREADY ran.
 *
 * A probe that could not be MADE tells us nothing about either question, so
 * both axes report `unknown` carrying that probe's own reason. A probe that
 * ANSWERED is classified from its headers — including a non-2xx answer, whose
 * missing headers simply read as `unknown` per axis. Nothing here re-probes,
 * and nothing here reads ENS: see {@link ./ethlimo-resolution.js}.
 */
function ethLimoResolutionOf(
	probed: ProbeOutcome,
	site: {cid: string; ipns?: string; mode?: SiteMode; ensName?: string},
): EthLimoResolution {
	if (probed.serves.state === 'unknown') {
		return unknownEthLimoResolution(probed.serves.reason);
	}
	return classifyEthLimoResolution({...site, headers: probed.headers});
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
	// A non-2xx is the router NOT ANSWERING the question (a 429 rate-limit is the
	// expected case), so it must not be flattened into an empty provider list —
	// that read as "you are not announced" and produced a false negative on a
	// live box. It throws with the status, and the caller records `unknown`.
	if (!res.ok) throw new CheckUnavailableError(`http ${res.status}`);
	return (await res.json()) as ProvidersResponse;
};

/**
 * The default cold-gateway probe: a single-byte range request to the given URL
 * (the CID's `https://<cid>.ipfs.dweb.link/`, or the site's
 * `https://<name>.limo/`) returning the HTTP status AND the response headers.
 * It is the ONLY place a live HTTP request is made for the report; injected
 * fakes replace it in tests.
 *
 * The headers are handed over WHOLE (lower-cased by `fetch`) rather than
 * filtered here: which headers mean something is the reader's business
 * ({@link ./ethlimo-resolution.js}), so this stays a dumb HTTP call and the
 * header names are spelled in exactly one place.
 */
export const defaultGatewayProbe: GatewayProbe = async (url) => {
	const res = await fetch(url, {headers: {range: 'bytes=0-0'}});
	const headers: Record<string, string> = {};
	// `forEach` rather than spreading the iterator: `Headers` is not typed as
	// iterable under this project's lib set, and the names are lower-cased here
	// so every reader sees one spelling.
	res.headers.forEach((value, key) => {
		headers[key.toLowerCase()] = value;
	});
	return {status: res.status, headers};
};
