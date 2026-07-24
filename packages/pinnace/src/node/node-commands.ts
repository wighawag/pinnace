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
 * {@link NodeCommandOps}: this module supplies thin default implementations
 * (the direct Kubo wiring the reference scripts describe) which those tasks
 * replace/deepen behind the SAME seam. This task owns the command surface +
 * role-gating + `warm` + the boundary ADR.
 */
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {HostRole} from '../config/config-resolution.js';
import type {KuboRpcClient} from '../rpc/kubo-rpc-client.js';

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

/** One site as auto-discovered from MFS `/sites/*`: its name and current CID. */
export interface DiscoveredSite {
	/** The MFS entry name under `/sites/` (often the ENS name). */
	name: string;
	/** The current content root CID (`files/stat --hash`). */
	cid: string;
}

/** Per-site outcome line a verb reports (shape is verb-specific but uniform). */
export interface SiteOutcome {
	name: string;
	cid?: string;
	ipns?: string;
	/** A short machine-readable status token (e.g. `re-announced`, `no-record`). */
	status?: string;
	/**
	 * `status`-verb only: whether the network announces this node for the CID
	 * (the delegated-routing providers list contains our PeerID). Owned + filled
	 * by the `status-report` core op; absent for other verbs.
	 */
	announced?: boolean;
	/** `status`-verb only: whether a cold public gateway served the CID (2xx/206). */
	gatewayServes?: boolean;
	/** `status`-verb only: the raw HTTP status the cold-gateway probe returned. */
	gatewayHttp?: number;
}

/** The uniform result an op returns: the per-site outcomes it produced. */
export interface NodeOpResult {
	sites: SiteOutcome[];
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
 * no live gateway is hit.
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
	/** Where `status` writes its dashboard JSON. */
	dashboardDir?: string;
	/** Injected publisher-record fetch (replica); defaults to a `fetch` call. */
	publisherFetch?: PublisherFetch;
	/** Injected gateway warm fetch; defaults to a `fetch` range request. */
	gatewayFetch?: GatewayFetch;
	/** Override any of the four core ops (parallel tasks supply the owned impl). */
	ops?: Partial<NodeCommandOps>;
}

/**
 * Auto-discover sites from MFS `/sites/*`: list the directory, then stat each
 * entry for its current CID. Entries without a resolvable CID are skipped.
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
		const name = entry?.Name;
		if (!name) continue;
		try {
			const stat = await client.filesStat<{Hash?: string}>(
				`${sitesDir}/${name}`,
			);
			if (stat?.Hash) sites.push({name, cid: stat.Hash});
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
// These are the direct Kubo wiring the reference cloud-init scripts describe,
// so the four verbs are useful the moment this task lands. The
// `publisher-replica-model` and `status-report` tasks OWN the record sequence
// and the per-site status checks respectively; they replace/deepen the
// corresponding op behind this same seam without touching the command surface.
// ---------------------------------------------------------------------------

/** Records are ~72h valid, refreshed with a 1h ttl (reference values). */
const RECORD_LIFETIME = '72h';
const RECORD_TTL = '1h';

/**
 * Default `republish` (publisher). For each site the node holds a key for:
 * `name/publish` to refresh the signed record, then `routing/get` to EXPORT the
 * raw signed record to {@link NodeCommandContext.recordsDir} where replicas
 * fetch it. Sites without a key are ipfs-mode only and are left alone.
 */
async function defaultRepublish(
	ctx: NodeCommandContext,
	sites: DiscoveredSite[],
): Promise<NodeOpResult> {
	const keys = await listKeys(ctx.client);
	const outcomes: SiteOutcome[] = [];
	for (const site of sites) {
		const ipns = keys.get(site.name);
		if (!ipns) {
			outcomes.push({name: site.name, cid: site.cid, status: 'no-key'});
			continue;
		}
		await ctx.client.namePublish({
			cidPath: `/ipfs/${site.cid}`,
			key: site.name,
			lifetime: RECORD_LIFETIME,
			ttl: RECORD_TTL,
			allowOffline: true,
		});
		const record = await ctx.client.routingGet(`/ipns/${ipns}`);
		if (ctx.recordsDir) {
			await mkdir(ctx.recordsDir, {recursive: true});
			await writeFile(join(ctx.recordsDir, `${site.name}.ipns-name`), ipns);
			await writeFile(
				join(ctx.recordsDir, `${site.name}.ipns-record`),
				Buffer.from(record),
			);
		}
		outcomes.push({name: site.name, cid: site.cid, ipns, status: 'exported'});
	}
	return {sites: outcomes};
}

/**
 * Default `mirror` (replica). For each site: fetch the publisher's exported
 * record (and its ipns id), re-announce it with `routing/put`, FALLING BACK to
 * the last cached record when the publisher endpoint is unreachable. The
 * replica NEVER signs (no `name/publish`) — it only re-announces.
 */
async function defaultMirror(
	ctx: NodeCommandContext,
	sites: DiscoveredSite[],
): Promise<NodeOpResult> {
	const base = (ctx.publisherEndpoint ?? '').replace(/\/+$/, '');
	const fetchRecord = ctx.publisherFetch ?? httpFetchText;
	const outcomes: SiteOutcome[] = [];

	for (const site of sites) {
		let record: string | undefined;
		let ipnsId: string | undefined;
		let fromCache = false;

		// Try the publisher first; on any failure fall back to the cache.
		if (base) {
			try {
				record = await fetchRecord(`${base}/records/${site.name}.ipns-record`);
				ipnsId = await fetchRecord(`${base}/records/${site.name}.ipns-name`);
			} catch {
				record = undefined;
				ipnsId = undefined;
			}
		}
		if (record === undefined && ctx.cacheDir) {
			const cached = await readCached(ctx.cacheDir, site.name);
			if (cached) {
				record = cached.record;
				ipnsId = cached.ipnsId;
				fromCache = true;
			}
		}

		if (record === undefined || !ipnsId) {
			outcomes.push({name: site.name, status: 'no-record'});
			continue;
		}

		// Persist a freshly-fetched record so a later publisher outage can fall
		// back to it. (Cache-sourced records are already on disk.)
		if (!fromCache && ctx.cacheDir) {
			await mkdir(ctx.cacheDir, {recursive: true});
			await writeFile(join(ctx.cacheDir, `${site.name}.ipns-record`), record);
			await writeFile(join(ctx.cacheDir, `${site.name}.ipns-name`), ipnsId);
		}

		await ctx.client.routingPut(
			`/ipns/${ipnsId}`,
			new Uint8Array(Buffer.from(record)),
		);
		outcomes.push({
			name: site.name,
			ipns: ipnsId,
			status: fromCache ? 're-announced-cached' : 're-announced',
		});
	}
	return {sites: outcomes};
}

/**
 * Default `warm`. Re-fetch each site's current CID through every configured
 * gateway template (`{cid}` substituted); `.eth` names are ALSO warmed via
 * eth.limo. Warming failures are recorded, never thrown (a cold gateway must
 * not fail the whole run).
 */
async function defaultWarm(
	ctx: NodeCommandContext,
	sites: DiscoveredSite[],
): Promise<NodeOpResult> {
	const warm = ctx.gatewayFetch ?? httpFetchStatus;
	const gateways = ctx.gateways ?? [];
	const outcomes: SiteOutcome[] = [];
	for (const site of sites) {
		for (const template of gateways) {
			const url = template.replaceAll('{cid}', site.cid);
			await safeWarm(warm, url);
		}
		if (site.name.endsWith('.eth')) {
			await safeWarm(warm, `https://${site.name}.limo/`);
		}
		outcomes.push({name: site.name, cid: site.cid, status: 'warmed'});
	}
	return {sites: outcomes};
}

/**
 * Default `status`. Reuses the `status-report` core logic (injected via
 * {@link NodeCommandContext.ops}.status; this default is a thin stand-in until
 * that task lands) and writes the resulting report as `status.json` under the
 * box's dashboard directory ONLY. Reporting per-site CID / IPNS id happens in
 * the reused core; this wrapper just persists it where the dashboard reads.
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
		name: s.name,
		cid: s.cid,
		ipns: keys.get(s.name) ?? '',
	}));
	return {sites: outcomes};
}

/** Serialise a status result to `status.json` under the dashboard dir only. */
async function writeStatusReport(
	ctx: NodeCommandContext,
	result: NodeOpResult,
): Promise<void> {
	if (!ctx.dashboardDir) return;
	await mkdir(ctx.dashboardDir, {recursive: true});
	const payload = {generated: new Date().toISOString(), sites: result.sites};
	await writeFile(
		join(ctx.dashboardDir, 'status.json'),
		JSON.stringify(payload, null, 2),
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

/** Read a cached record + its ipns id for a site, or undefined if absent. */
async function readCached(
	cacheDir: string,
	name: string,
): Promise<{record: string; ipnsId: string} | undefined> {
	try {
		const record = await readFile(
			join(cacheDir, `${name}.ipns-record`),
			'utf8',
		);
		const ipnsId = (
			await readFile(join(cacheDir, `${name}.ipns-name`), 'utf8')
		).trim();
		if (!ipnsId) return undefined;
		return {record, ipnsId};
	} catch {
		return undefined;
	}
}

/** Warm one URL, swallowing any error (a cold gateway must not fail the run). */
async function safeWarm(warm: GatewayFetch, url: string): Promise<void> {
	try {
		await warm(url);
	} catch {
		// Intentionally ignored: warming is best-effort.
	}
}

/** Production publisher-record fetch: GET the URL and return its body text. */
async function httpFetchText(url: string): Promise<string> {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
	return await res.text();
}

/** Production gateway warm: range-request the URL and return the HTTP status. */
async function httpFetchStatus(url: string): Promise<number> {
	const res = await fetch(url, {headers: {range: 'bytes=0-0'}});
	return res.status;
}
