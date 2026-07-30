/**
 * The **on-box** command surface of `pinnace` — the `node` namespace.
 *
 * The SAME `pinnace` binary the operator runs as a client also runs the
 * recurring loop ON a Kubo node (invoked by the cloud-init systemd timers).
 * This module is that loop's command surface: `pinnace node <verb>` with
 * `verb` in {`republish`, `mirror`, `warm`, `status`}. Each verb is a THIN
 * wrapper that discovers sites from the LOCAL Kubo RPC and dispatches to a
 * core operation, exactly like the client CLI wraps core operations
 * (CONTEXT.md `core vs cli`). One codebase, two invocation contexts, so the
 * record/warm/mirror/status logic has a single implementation — no bash/TS
 * behaviour drift like the reference prototype had.
 *
 * BOUNDARY (see docs/adr/0002-*): Kubo owns pinning (`dag/import --pin-roots`)
 * and provider-record freshness (`Reprovider.Interval`); this recurring loop
 * owns ONLY IPNS republish/export, replica mirror/fallback, gateway warm, and
 * status. It does nothing recurring for pinning or reprovide.
 *
 * Behaviour ported (not copied as bash) from the reference cloud-init scripts
 * `ipfs-ipns-publish.sh`, `ipfs-ipns-mirror.sh`, `ipfs-warm.sh`,
 * `ipfs-status.sh` (`~/searches/ipfs-hetzner/cloud-init.yaml`).
 *
 * SEAM NOTE: the publisher/replica record SEQUENCE (export -> fetch ->
 * routing/put -> fallback) is OWNED and tested by the `publisher-replica-model`
 * task, and `status`'s per-site checks by the `status-report` task. Both land
 * in parallel with this task. So the four core operations are injectable via
 * {@link NodeCommandOps}: this module's default `republish`/`mirror` DELEGATE to
 * the owned record-sequence core (`../publisher/record-sequence.ts`) so there is
 * a SINGLE implementation (no bash/TS drift, per ADR-0002), and `status`
 * delegates to the `status-report` core injected via `ctx.ops`. This task owns
 * the command surface + role-gating + `warm` + the boundary ADR.
 *
 * DASHBOARD: the `status` verb's on-box persistence lives here (see
 * {@link writeStatusReport}) and writes BOTH views of the report into
 * {@link NodeCommandContext.dashboardDir}: `status.json` (machine) and
 * `index.html` (human, rendered by the pure `../status/status-html.ts`), so the
 * dashboard vhost ROOT is a readable page rather than raw JSON.
 */
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {renderStatusHtml} from '../status/status-html.js';
import type {HostRole, SiteMode} from '../config/config-resolution.js';
import type {KuboRpcClient} from '../rpc/kubo-rpc-client.js';
import {
	republishAndExport,
	mirrorAndReannounce,
} from '../publisher/record-sequence.js';
import type {CheckOutcome, RecordSequence} from '../status/check-outcome.js';
import type {
	EthLimoFreshness,
	EthLimoOrigin,
} from '../status/ethlimo-resolution.js';
import {
	ethLimoUrl,
	readSiteMetadata,
	resolveEnsNameToWarm,
	siteContentPath,
	type SiteMetadata,
} from '../site/site-wrapper.js';

/** The four on-box verbs, under the `node` namespace. */
export type NodeVerb = 'republish' | 'mirror' | 'warm' | 'status';

/** The verbs, in a stable order (for help text / iteration). */
export const NODE_VERBS: readonly NodeVerb[] = [
	'republish',
	'mirror',
	'warm',
	'status',
];

/** Which role each role-gated verb requires; role-agnostic verbs are absent. */
const VERB_ROLE_GATE: Partial<Record<NodeVerb, HostRole>> = {
	republish: 'publisher',
	mirror: 'replica',
};

/**
 * One site as auto-discovered from MFS `/sites/*`: its `id`, current content
 * CID, and the per-site metadata stored beside the content in the wrapper.
 */
export interface DiscoveredSite {
	/** The MFS wrapper `id` under `/sites/` (the site's single identifier). */
	id: string;
	/** The current content root CID (`files/stat --hash` of `<wrapper>/content`). */
	cid: string;
	/**
	 * The site's metadata from `<wrapper>/metadata.json` — the channel per-site
	 * config reaches the box on (it reads what it can SEE, ADR-0002). ALWAYS an
	 * object: a site with no (or unreadable) metadata discovers as `{}`, never
	 * undefined and never a discovery failure.
	 */
	metadata: SiteMetadata;
}

/**
 * What ONE site's `warm` pass actually achieved — the outcome token the `warm`
 * verb records. Warming stays best-effort (a failure is NEVER thrown, ADR-0002),
 * so the token is the only place the truth can live:
 *
 *  - `warmed`          — every warm attempted for the site succeeded,
 *  - `partly-warmed`   — some succeeded and some failed (the interesting case
 *    for a `.eth` site: its CID gateways are hot but `<name>.limo` is not, or
 *    the reverse),
 *  - `warm-failed`     — every attempt failed,
 *  - `nothing-to-warm` — nothing was attempted at all (no gateways configured
 *    and no ENS name resolved), which is not success and must not read as it.
 *
 * A warm counts as SUCCEEDED when the fetch resolves with a 2xx status: a cold
 * gateway usually ANSWERS (504/404) rather than throwing, so a status-only
 * failure is recorded exactly like a thrown one. See
 * work/notes/observations/ethlimo-probe-and-warm-outcome-decisions.md.
 */
export type WarmStatus =
	'warmed' | 'partly-warmed' | 'warm-failed' | 'nothing-to-warm';

/** Per-site outcome line a verb reports (shape is verb-specific but uniform). */
export interface SiteOutcome {
	/** The site's single `id` (its MFS entry / KDF input). */
	id: string;
	cid?: string;
	ipns?: string;
	/** A short machine-readable status token (e.g. `re-announced`, `no-record`). */
	status?: string;
	/**
	 * `status`-verb only: whether the network announces this node for the CID
	 * (the delegated-routing providers list contains our PeerID). THREE-valued
	 * ({@link CheckOutcome}): a lookup that could not be MADE reports `unknown`
	 * with its reason, NEVER a `no` (`CONTEXT.md` `## Conventions`). Owned +
	 * filled by the `status-report` core op; absent for other verbs.
	 */
	announced?: CheckOutcome;
	/**
	 * `status`-verb only: whether a cold public gateway served the CID (2xx/206),
	 * with the same three states — a gateway that ANSWERED a non-2xx is a `no`, a
	 * probe that could not be made is `unknown`.
	 */
	gatewayServes?: CheckOutcome;
	/** `status`-verb only: the raw HTTP status the cold-gateway probe answered with. */
	gatewayHttp?: number;
	/**
	 * `status`-verb only: the sequence of the IPNS record THIS node holds for the
	 * site — the number that decides which record wins. `known` with the number,
	 * or `unknown` WITH its reason; ABSENT means not applicable (this node holds
	 * no key for the site). Never a fallback 0: a spurious 0 is the failure it
	 * exists to expose (see
	 * `work/notes/findings/ipns-sequence-resets-to-zero-on-a-new-signer.md`).
	 *
	 * It travels into BOTH on-box artefacts — `status.json` and the rendered
	 * dashboard — so each box publishes its own number and an operator can compare
	 * them across the fleet, which is the only way the comparison means anything.
	 */
	sequence?: RecordSequence;
	/**
	 * `status`-verb only: the `mode` the site STORES in its `metadata.json`,
	 * reported as stored — ABSENT stays absent rather than being resolved to the
	 * `ipfs` default, because `republish` treats the two differently.
	 */
	mode?: SiteMode;
	/**
	 * `status`-verb only: the `ensName` the site STORES, with `""` (the opt-out)
	 * kept DISTINCT from absent (infer from a `.eth` id). Never coerced — unlike
	 * `ipns`, whose payload flattens undefined to `''`.
	 */
	ensName?: string;
	/**
	 * `status`-verb only: the ENS name eth.limo warming will target, resolved by
	 * the same {@link resolveEnsNameToWarm} rule `warm` uses. Absent when the site
	 * is not eth.limo-warmed.
	 */
	ensNameToWarm?: string;
	/**
	 * `status`-verb only: whether `https://<ensNameToWarm>.limo/` — the URL a
	 * HUMAN visits — served. FOUR states: `yes` served, `no` it answered and did
	 * not, `unknown` the probe could not be MADE, ABSENT there was nothing to
	 * probe (the site resolves no ENS name). A `""` opt-out is not an eth.limo
	 * failure and never reads as one, and neither is an eth.limo outage.
	 */
	ethLimoServes?: CheckOutcome;
	/** `status`-verb only: the raw HTTP status the eth.limo probe answered with. */
	ethLimoHttp?: number;
	/**
	 * `status`-verb only: is the ENS name resolving through THIS site's identity,
	 * or through another name/cid? ({@link EthLimoOrigin}.) ABSENT means the site
	 * resolves no ENS name, so nothing was asked — distinct from `unknown`, which
	 * means the question could not be answered.
	 */
	ethLimoOrigin?: EthLimoOrigin;
	/**
	 * `status`-verb only: is the root eth.limo served this site's CURRENT cid?
	 * ({@link EthLimoFreshness}.) `stale` is an attention state, not a failure:
	 * gateway/IPNS lag shortly after a deploy is normal. Both axes observe what
	 * eth.limo resolved through its own cache, never the ENS record itself.
	 */
	ethLimoFreshness?: EthLimoFreshness;
	/**
	 * `warm`-verb only: whether the site's eth.limo warm SUCCEEDED. A boolean,
	 * unlike {@link ethLimoServes}: warming is an ACTION, not a check — a warm
	 * that could not be made simply did not warm anything, which the outcome
	 * ({@link WarmStatus}) already says. Absent means the site resolves no ENS
	 * name, so no eth.limo warm was attempted.
	 */
	ethLimoWarmed?: boolean;
}

/** The uniform result an op returns: the per-site outcomes it produced. */
export interface NodeOpResult {
	sites: SiteOutcome[];
	/**
	 * `status`-verb only: this node's PeerID, as the `status` core already read it
	 * (`id`) for the announce check. Threaded through this seam PURELY so the
	 * dashboard HTML header can name the node WITHOUT a second `id` call (the
	 * report is reused, never re-gathered). Optional: ops that do not know it (the
	 * thin {@link defaultStatus} stand-in, an injected test fake) simply omit it
	 * and the page renders the PeerID as `unknown`. Deliberately NOT added to the
	 * `status.json` payload, whose shape stays exactly as machine consumers
	 * already know it.
	 */
	peerId?: string;
}

/** The full result {@link runNodeCommand} returns for one verb invocation. */
export interface NodeCommandResult extends NodeOpResult {
	/** The verb that ran. */
	verb: NodeVerb;
	/** True when role-gating (or a missing precondition) skipped the op. */
	skipped?: boolean;
	/** Why it was skipped (e.g. `role publisher required, this box is replica`). */
	skippedReason?: string;
}

/**
 * An injectable HTTP fetch for a single URL, returning the body text. Used for
 * fetching the publisher's exported record on a replica. Tests inject a fake;
 * production passes a `fetch`-backed implementation. Throwing signals the
 * endpoint is unreachable (the replica then falls back to its cache).
 */
export type PublisherFetch = (url: string) => Promise<string>;

/**
 * An injectable HTTP fetch for gateway WARMING: fetch the URL (a small range is
 * enough to seat the cache) and return the HTTP status. Tests inject a fake so
 * no live gateway is hit. The STATUS is read, not discarded: a non-2xx answer
 * is a warm that did not warm, and is recorded as such ({@link WarmStatus}).
 */
export type GatewayFetch = (url: string) => Promise<number>;

/**
 * The four core operations, injectable so the parallel `publisher-replica-model`
 * (republish/mirror) and `status-report` (status) tasks can supply the owned,
 * fully-tested implementations behind this SAME seam. Any op left unset uses
 * this module's thin default (the direct Kubo wiring the reference describes).
 */
export interface NodeCommandOps {
	republish: (
		ctx: NodeCommandContext,
		sites: DiscoveredSite[],
	) => Promise<NodeOpResult>;
	mirror: (
		ctx: NodeCommandContext,
		sites: DiscoveredSite[],
	) => Promise<NodeOpResult>;
	warm: (
		ctx: NodeCommandContext,
		sites: DiscoveredSite[],
	) => Promise<NodeOpResult>;
	status: (
		ctx: NodeCommandContext,
		sites: DiscoveredSite[],
	) => Promise<NodeOpResult>;
}

/**
 * Everything a verb needs to run on the box. On-box PATHS (records/cache/
 * dashboard) are explicit fields so tests isolate them to temp fixtures and
 * production points them at the real box locations (`/var/www/ipfs-dash/...`,
 * `/var/lib/ipfs/records`) — no global default location is baked into the
 * logic.
 */
export interface NodeCommandContext {
	/** The LOCAL Kubo RPC client (this box's daemon). */
	client: KuboRpcClient;
	/** This box's role; gates `republish` (publisher) and `mirror` (replica). */
	role: HostRole;
	/** The MFS directory sites live under (default `/sites`). */
	sitesDir?: string;
	/** Gateway URL templates with a `{cid}` placeholder to warm through. */
	gateways?: string[];
	/** For replicas: base URL to fetch the publisher's exported records from. */
	publisherEndpoint?: string;
	/** Where the publisher EXPORTS signed records (replicas fetch these). */
	recordsDir?: string;
	/** Where a replica CACHES the last good record for fallback. */
	cacheDir?: string;
	/** Where `status` writes its dashboard outputs (`status.json` + `index.html`). */
	dashboardDir?: string;
	/** Injected publisher-record fetch (replica); defaults to a `fetch` call. */
	publisherFetch?: PublisherFetch;
	/** Injected gateway warm fetch; defaults to a `fetch` range request. */
	gatewayFetch?: GatewayFetch;
	/** Override any of the four core ops (parallel tasks supply the owned impl). */
	ops?: Partial<NodeCommandOps>;
}

/**
 * Auto-discover sites from MFS `/sites/*`: list the directory, then for each
 * entry — a site WRAPPER dir (`./site-wrapper.ts`) — stat its `content` subpath
 * for the current CID and read its `metadata.json`. Entries without a
 * resolvable CONTENT cid are skipped (a wrapper that holds no content is not a
 * servable site); metadata that is absent or unreadable is simply empty, since
 * a site without metadata is normal, not a failure.
 * Shared by every verb (the reference scripts all begin with this same walk).
 */
export async function discoverSites(
	client: KuboRpcClient,
	sitesDir = '/sites',
): Promise<DiscoveredSite[]> {
	let listing: {Entries?: Array<{Name?: string}> | null};
	try {
		listing = await client.filesLs<{Entries?: Array<{Name?: string}> | null}>(
			sitesDir,
		);
	} catch {
		// No /sites dir yet (fresh box) — nothing to do, not an error.
		return [];
	}
	const entries = listing.Entries ?? [];
	const sites: DiscoveredSite[] = [];
	for (const entry of entries) {
		const id = entry?.Name;
		if (!id) continue;
		try {
			const stat = await client.filesStat<{Hash?: string}>(
				siteContentPath(sitesDir, id),
			);
			if (!stat?.Hash) continue;
			const metadata = await readSiteMetadata(client, sitesDir, id);
			sites.push({id, cid: stat.Hash, metadata});
		} catch {
			// A site whose stat fails is skipped, not fatal for the others.
		}
	}
	return sites;
}

/**
 * Run one on-box verb. Resolves the role gate first (a wrong-role verb is a
 * SKIP — a clean no-op that touches no Kubo RPC, so scheduling all timers on
 * every box is safe), then discovers sites and dispatches to the (possibly
 * injected) core op. Throws on an unknown verb (loud, never a silent no-op).
 */
export async function runNodeCommand(
	verb: NodeVerb,
	ctx: NodeCommandContext,
): Promise<NodeCommandResult> {
	if (!NODE_VERBS.includes(verb)) {
		throw new Error(
			`unknown node verb '${verb}'; expected one of ${NODE_VERBS.join(', ')}`,
		);
	}

	const requiredRole = VERB_ROLE_GATE[verb];
	if (requiredRole && ctx.role !== requiredRole) {
		return {
			verb,
			sites: [],
			skipped: true,
			skippedReason: `role ${requiredRole} required, this box is ${ctx.role}`,
		};
	}

	const sites = await discoverSites(ctx.client, ctx.sitesDir ?? '/sites');
	const op = ctx.ops?.[verb] ?? DEFAULT_OPS[verb];
	const result = await op(ctx, sites);

	// The dashboard PERSISTENCE is on-box wiring owned by this command layer, so
	// it happens whether `status` used the default op or the injected
	// `status-report` core op — the reused core produces the report, this
	// wrapper writes it where the dashboard reads (and ONLY there).
	if (verb === 'status') {
		await writeStatusReport(ctx, result);
	}

	return {verb, ...result};
}

// ---------------------------------------------------------------------------
// Default (thin) core-op implementations.
//
// The `warm` and `status` defaults are the direct Kubo wiring the reference
// cloud-init scripts describe. The `republish`/`mirror` defaults DELEGATE to the
// owned record-sequence core (`../publisher/record-sequence.ts`) so the record
// SEQUENCE (export -> fetch -> routing/put -> fallback) has a SINGLE
// implementation shared by client and box (ADR-0002); `status` reuses the
// `status-report` core injected via `ctx.ops`.
// ---------------------------------------------------------------------------

/**
 * Default `republish` (publisher): DELEGATE to the owned record-sequence core
 * ({@link republishAndExport}). It refreshes the signed record (`name/publish`,
 * ~72h/1h) and EXPORTS it (`routing/get`) to {@link NodeCommandContext.recordsDir}
 * where replicas fetch it. One implementation, no bash/TS drift (ADR-0002).
 */
async function defaultRepublish(
	ctx: NodeCommandContext,
	sites: DiscoveredSite[],
): Promise<NodeOpResult> {
	return republishAndExport(ctx, sites);
}

/**
 * Default `mirror` (replica): DELEGATE to the owned record-sequence core
 * ({@link mirrorAndReannounce}). It fetches the publisher's exported record,
 * re-announces it (`routing/put`), and FALLS BACK to the last cached record
 * when the publisher endpoint is unreachable — NEVER signing.
 */
async function defaultMirror(
	ctx: NodeCommandContext,
	sites: DiscoveredSite[],
): Promise<NodeOpResult> {
	return mirrorAndReannounce(ctx, sites);
}

/**
 * Default `warm`. Re-fetch each site's current CID through every configured
 * gateway template (`{cid}` substituted), and ALSO warm the site's eth.limo
 * name when it resolves one.
 *
 * Warming failures are RECORDED, never thrown (a cold gateway must not fail the
 * whole run) — but recorded HONESTLY: the per-site outcome is the
 * {@link WarmStatus} the pass actually earned, so a site whose every fetch
 * failed reports `warm-failed`, not `warmed`. The eth.limo half is called out
 * separately ({@link SiteOutcome.ethLimoWarmed}) because for a `.eth` site that
 * is the URL humans use, so "CID gateways hot, eth.limo cold" is the outcome
 * worth seeing rather than averaging away.
 */
async function defaultWarm(
	ctx: NodeCommandContext,
	sites: DiscoveredSite[],
): Promise<NodeOpResult> {
	const warm = ctx.gatewayFetch ?? httpFetchStatus;
	const gateways = ctx.gateways ?? [];
	const outcomes: SiteOutcome[] = [];
	for (const site of sites) {
		let attempted = 0;
		let failed = 0;
		for (const template of gateways) {
			const url = template.replaceAll('{cid}', site.cid);
			attempted++;
			if (!(await safeWarm(warm, url))) failed++;
		}
		// eth.limo warming is driven by the site's MFS METADATA, not its identity:
		// an explicit `ensName` names the gateway, `""` opts out, and only an
		// absent field falls back to inferring from a `.eth` id (the whole rule
		// lives in `resolveEnsNameToWarm`, beside the write side that fills it in).
		const ensName = resolveEnsNameToWarm(site.id, site.metadata);
		let ethLimoWarmed: boolean | undefined;
		if (ensName !== undefined) {
			attempted++;
			ethLimoWarmed = await safeWarm(warm, ethLimoUrl(ensName));
			if (!ethLimoWarmed) failed++;
		}
		const outcome: SiteOutcome = {
			id: site.id,
			cid: site.cid,
			status: warmStatus(attempted, failed),
		};
		// A site with no ENS name carries NO verdict (not `false`): nothing was
		// attempted, which is not an eth.limo failure.
		if (ethLimoWarmed !== undefined) outcome.ethLimoWarmed = ethLimoWarmed;
		outcomes.push(outcome);
	}
	return {sites: outcomes};
}

/** The {@link WarmStatus} a site's pass earned, from what it attempted. */
function warmStatus(attempted: number, failed: number): WarmStatus {
	if (attempted === 0) return 'nothing-to-warm';
	if (failed === 0) return 'warmed';
	return failed === attempted ? 'warm-failed' : 'partly-warmed';
}

/**
 * Default `status` — a thin stand-in used ONLY when no `status` op is injected.
 * The PRODUCTION on-box path (`pinnace node status`, wired in cli/run.ts's
 * `runNodeCli`) injects the OWNED `status` op ({@link makeStatusOp} from
 * status-report) via {@link NodeCommandContext.ops}.status, which is the real
 * per-site CID/IPNS/announce/gateway report. This default remains as the
 * seam's safe fallback (e.g. a direct `runNodeCommand` call that does not want
 * the live external checks / a hermetic test that injects its own op), so a
 * bare call still reports current CID + IPNS id without reaching the network.
 * The dashboard write is done by the command layer ({@link runNodeCommand}).
 */
async function defaultStatus(
	ctx: NodeCommandContext,
	sites: DiscoveredSite[],
): Promise<NodeOpResult> {
	// Thin stand-in report until `status-report` supplies the owned op: current
	// CID from discovery + IPNS id from the keystore. The external announce /
	// gateway-serves checks are that task's concern (injected here). The
	// dashboard write is done by the command layer ({@link runNodeCommand}), not
	// here, so an injected op gets persisted the same way.
	const keys = await listKeys(ctx.client);
	const outcomes: SiteOutcome[] = sites.map((s) => ({
		id: s.id,
		cid: s.cid,
		ipns: keys.get(s.id) ?? '',
		// The site's own metadata, reported as stored (see SiteOutcome), plus the
		// warm rule's resolution of it — the same fields the owned `status` op
		// carries, so both paths render the same dashboard columns.
		mode: s.metadata.mode,
		ensName: s.metadata.ensName,
		ensNameToWarm: resolveEnsNameToWarm(s.id, s.metadata),
	}));
	return {sites: outcomes};
}

/**
 * Persist a status result under the dashboard dir, and ONLY there. TWO views of
 * the SAME report, sharing ONE timestamp (never two clocks):
 *
 *  - `status.json`: the machine payload (`{generated, sites}`), unchanged.
 *  - `index.html`: the human dashboard page, so the vhost ROOT is readable
 *    (rendered by the pure {@link renderStatusHtml}; it re-gathers nothing).
 */
async function writeStatusReport(
	ctx: NodeCommandContext,
	result: NodeOpResult,
): Promise<void> {
	if (!ctx.dashboardDir) return;
	await mkdir(ctx.dashboardDir, {recursive: true});
	const generated = new Date().toISOString();
	const payload = {generated, sites: result.sites};
	await writeFile(
		join(ctx.dashboardDir, 'status.json'),
		JSON.stringify(payload, null, 2),
	);
	await writeFile(
		join(ctx.dashboardDir, 'index.html'),
		renderStatusHtml({peerId: result.peerId, generated, sites: result.sites}),
	);
}

/** The default op table (verb -> thin Kubo wiring). */
const DEFAULT_OPS: NodeCommandOps = {
	republish: defaultRepublish,
	mirror: defaultMirror,
	warm: defaultWarm,
	status: defaultStatus,
};

// ---------------------------------------------------------------------------
// Small shared helpers.
// ---------------------------------------------------------------------------

/** Map site/key name -> IPNS id from `key/list -l`. */
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

/**
 * Warm one URL and REPORT whether it worked — never throwing (a cold gateway
 * must not fail the run). A thrown error and a non-2xx answer are the SAME
 * failure: a 504 from a cold gateway warmed nothing, so it may not be counted
 * as a success just because it answered. (The `status` core's cold-gateway
 * probe applies the same 2xx test, on its own side of the seam.)
 */
async function safeWarm(warm: GatewayFetch, url: string): Promise<boolean> {
	try {
		const status = await warm(url);
		return status >= 200 && status < 300;
	} catch {
		// Recorded as a failure by the caller; warming is best-effort, never fatal.
		return false;
	}
}

/** Production gateway warm: range-request the URL and return the HTTP status. */
async function httpFetchStatus(url: string): Promise<number> {
	const res = await fetch(url, {headers: {range: 'bytes=0-0'}});
	return res.status;
}
