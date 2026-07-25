/**
 * The **publisher / keyless-replica IPNS record SEQUENCE** — pinnace's C-2
 * grace-window machinery (CONTEXT.md `publisher`, `replica`, `IPNS record`;
 * spec "Publisher / keyless-replica model" + user stories 12, 13, 14).
 *
 * A shared IPNS name stays reachable with a grace window even if the publisher
 * dies. Exactly ONE publisher per name holds the derived key and:
 *   - refreshes the record's validity by re-SIGNING it (`name/publish`,
 *     ~72h lifetime, ~1h ttl — refreshed well within validity), then
 *   - EXPORTS the raw signed record (`routing/get`) plus its ipns id to a
 *     records dir where keyless replicas fetch it.
 * Keyless REPLICAS hold no key. For each site they:
 *   - FETCH the publisher's exported record from the publisher endpoint,
 *   - re-announce it (`routing/put`) — they NEVER sign,
 *   - FALL BACK to their last cached record if the publisher is unreachable,
 *     so the name keeps announcing through a publisher outage.
 *
 * THE LOAD-BEARING INVARIANT (spec Out of Scope C-1; ADR-0003): a replica NEVER
 * signs. The only signing primitive in the whole sequence is the publisher's
 * `name/publish` (the NODE signs, owning sequence numbers + validity). A replica
 * issues ONLY `routing/put` (re-announce) — never `name/publish`. Re-announcing
 * a signed record is not signing it. The tests assert no `name/publish` ever
 * reaches a replica's Kubo, including on the cache-fallback path.
 *
 * ONE IMPLEMENTATION (ADR-0002): this module is the SINGLE home of the record
 * sequence. The on-box `pinnace node republish|mirror` verbs
 * (`../node/node-commands.ts`) do NOT re-implement it — they inject the ops
 * this module exposes ({@link makeRepublishOp}, {@link makeMirrorOp}) through
 * their `NodeCommandOps` seam, exactly as `status-report` supplies the `status`
 * op via `makeStatusOp`. So the client and the box run the same code; there is
 * no bash/TS behaviour drift like the reference prototype had.
 *
 * Behaviour ported (NOT copied as bash) from the reference cloud-init scripts
 * `ipfs-ipns-publish.sh` (publisher: `name publish` + `routing get` export to
 * the dashboard vhost) and `ipfs-ipns-mirror.sh` (replica: curl the publisher's
 * `/records/<name>.ipns-record`, `routing put`, fall back to cache)
 * (`~/searches/ipfs-hetzner/cloud-init.yaml`).
 *
 * Promotion (story 14) — {@link promoteReplicaToPublisher} — reuses the
 * `key-import-publisher` seam ({@link importIpnsKeyIntoPublisher}) to import the
 * derived key and flip the role, recovering the name within the record's
 * validity window without content downtime.
 */
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {KuboRpcClient} from '../rpc/kubo-rpc-client.js';
import type {HostRole} from '../config/config-resolution.js';
import type {DerivedIpnsKey} from '../derive/ipns-key-derivation.js';
import {importIpnsKeyIntoPublisher} from './key-import.js';
import {
	publishSiteRecord,
	RECORD_LIFETIME,
	RECORD_TTL,
} from './ipns-publish.js';
import type {
	DiscoveredSite,
	NodeCommandContext,
	NodeOpResult,
	PublisherFetch,
	SiteOutcome,
} from '../node/node-commands.js';

/**
 * Records are ~72h valid, refreshed with a ~1h ttl (the reference values). The
 * republish timer fires well within 72h so the record never lapses. Re-exported
 * from their single home `./ipns-publish.ts` (which owns the `name/publish` call
 * shape shared with deploy + `pin --mode ipns`), so this module's public API is
 * unchanged and there is only ONE copy of the validity contract.
 */
export {RECORD_LIFETIME, RECORD_TTL};

/** The exported record file suffix (raw signed record bytes). */
const RECORD_SUFFIX = '.ipns-record';
/** The exported ipns-id file suffix (the `k51...` name `routing/put` targets). */
const NAME_SUFFIX = '.ipns-name';

// ---------------------------------------------------------------------------
// Publisher: refresh (sign) + export.
// ---------------------------------------------------------------------------

/**
 * PUBLISHER op. For each discovered site the node holds a key for:
 *   1. `name/publish` to refresh the signed record (~72h lifetime, ~1h ttl),
 *   2. `routing/get` to EXPORT the raw signed record, then
 *   3. write the record + its ipns id under {@link NodeCommandContext.recordsDir}
 *      where replicas fetch them.
 * Sites the node holds NO key for are ipfs-mode only and are left alone
 * (reported `no-key`, never published). This is the ONLY place a signing
 * primitive (`name/publish`) runs in the whole sequence.
 */
export async function republishAndExport(
	ctx: NodeCommandContext,
	sites: DiscoveredSite[],
): Promise<NodeOpResult> {
	const keys = await listKeys(ctx.client);
	const outcomes: SiteOutcome[] = [];

	for (const site of sites) {
		const ipns = keys.get(site.id);
		if (!ipns) {
			// ipfs-mode site (no key): nothing to sign or export.
			outcomes.push({id: site.id, cid: site.cid, status: 'no-key'});
			continue;
		}

		// The NODE signs here (refreshing validity). Not the client, not a replica.
		// Through the shared publish seam, so the on-box refresh and the client-side
		// deploy/pin publishes cannot drift in lifetime/ttl/allow-offline.
		await publishSiteRecord({
			client: ctx.client,
			id: site.id,
			cid: site.cid,
		});

		// Export the raw signed record for replicas to mirror.
		const record = await ctx.client.routingGet(`/ipns/${ipns}`);
		if (ctx.recordsDir) {
			await mkdir(ctx.recordsDir, {recursive: true});
			await writeFile(join(ctx.recordsDir, site.id + NAME_SUFFIX), ipns);
			await writeFile(
				join(ctx.recordsDir, site.id + RECORD_SUFFIX),
				Buffer.from(record),
			);
		}

		outcomes.push({id: site.id, cid: site.cid, ipns, status: 'exported'});
	}

	return {sites: outcomes};
}

// ---------------------------------------------------------------------------
// Replica: fetch + re-announce, with cache fallback. NEVER signs.
// ---------------------------------------------------------------------------

/**
 * REPLICA op. For each discovered site:
 *   1. FETCH the publisher's exported record (+ its ipns id) from the publisher
 *      endpoint;
 *   2. on ANY fetch failure, FALL BACK to the last cached record for that site;
 *   3. re-announce whichever record it got via `routing/put`.
 * A freshly fetched record is cached so a later publisher outage can fall back
 * to it. A site with neither a live publisher NOR a cache is REPORTED
 * (`no-record`), never thrown — one unreachable site must not fail the others.
 *
 * A replica NEVER signs: this op issues NO `name/publish`. It only re-announces
 * a record the publisher already signed.
 */
export async function mirrorAndReannounce(
	ctx: NodeCommandContext,
	sites: DiscoveredSite[],
): Promise<NodeOpResult> {
	const base = (ctx.publisherEndpoint ?? '').replace(/\/+$/, '');
	const fetchRecord: PublisherFetch = ctx.publisherFetch ?? httpFetchText;
	const outcomes: SiteOutcome[] = [];

	for (const site of sites) {
		let record: string | undefined;
		let ipnsId: string | undefined;
		let fromCache = false;

		// Try the publisher first; on ANY failure fall back to the cache.
		if (base) {
			try {
				record = await fetchRecord(
					`${base}/records/${site.id}${RECORD_SUFFIX}`,
				);
				ipnsId = (
					await fetchRecord(`${base}/records/${site.id}${NAME_SUFFIX}`)
				).trim();
			} catch {
				record = undefined;
				ipnsId = undefined;
			}
		}
		if (record === undefined && ctx.cacheDir) {
			const cached = await readCached(ctx.cacheDir, site.id);
			if (cached) {
				record = cached.record;
				ipnsId = cached.ipnsId;
				fromCache = true;
			}
		}

		if (record === undefined || !ipnsId) {
			// Neither a live publisher nor a cache: report, don't throw.
			outcomes.push({id: site.id, status: 'no-record'});
			continue;
		}

		// Persist a freshly-fetched record so a later outage can fall back to it.
		// (Cache-sourced records are already on disk.)
		if (!fromCache && ctx.cacheDir) {
			await mkdir(ctx.cacheDir, {recursive: true});
			await writeFile(join(ctx.cacheDir, site.id + RECORD_SUFFIX), record);
			await writeFile(join(ctx.cacheDir, site.id + NAME_SUFFIX), ipnsId);
		}

		// Re-announce ONLY. No signing — this is a replica.
		await ctx.client.routingPut(
			`/ipns/${ipnsId}`,
			new Uint8Array(Buffer.from(record)),
		);
		outcomes.push({
			id: site.id,
			ipns: ipnsId,
			status: fromCache ? 're-announced-cached' : 're-announced',
		});
	}

	return {sites: outcomes};
}

// ---------------------------------------------------------------------------
// Node-command adapters: supply the owned ops behind the SAME NodeCommandOps
// seam the on-box `republish`/`mirror` verbs inject (mirrors makeStatusOp).
// ---------------------------------------------------------------------------

/**
 * Adapt {@link republishAndExport} into a {@link NodeCommandContext} `republish`
 * op so the on-box `republish` verb injects it (its `ops.republish` seam). The
 * command layer discovers sites and passes them in; this op signs+exports over
 * them. So the box runs THIS code, not a re-implementation.
 */
export function makeRepublishOp(): (
	ctx: NodeCommandContext,
	sites: DiscoveredSite[],
) => Promise<NodeOpResult> {
	return (ctx, sites) => republishAndExport(ctx, sites);
}

/**
 * Adapt {@link mirrorAndReannounce} into a {@link NodeCommandContext} `mirror`
 * op so the on-box `mirror` verb injects it (its `ops.mirror` seam). Same core,
 * one implementation.
 */
export function makeMirrorOp(): (
	ctx: NodeCommandContext,
	sites: DiscoveredSite[],
) => Promise<NodeOpResult> {
	return (ctx, sites) => mirrorAndReannounce(ctx, sites);
}

// ---------------------------------------------------------------------------
// Promote a replica to publisher (story 14).
// ---------------------------------------------------------------------------

/** Inputs to {@link promoteReplicaToPublisher}. */
export interface PromoteReplicaInput {
	/** The Kubo RPC client for the node being promoted (per-node, bearer-guarded). */
	client: KuboRpcClient;
	/** The node's CURRENT role (typically `replica`; `publisher` is a safe re-run). */
	currentRole: HostRole;
	/** The keystore key name to import under (the site name / `key/list` Name). */
	keyName: string;
	/** The derived per-site key (seed + public key) from `ipns-key-derivation`. */
	derived: DerivedIpnsKey;
}

/** The outcome of a promotion: the flipped role + the key that was imported. */
export interface PromoteReplicaResult {
	/** Always `publisher` after a successful promotion (the flipped role). */
	role: HostRole;
	/** The key name imported into the (now) publisher's keystore. */
	keyName: string;
	/** The IPNS id the imported key resolves to (from the `key/import` response). */
	ipns?: string;
}

/**
 * PROMOTE a keyless replica to publisher (spec user story 14): import the
 * derived key into the node's keystore and flip its role to `publisher`, so the
 * former replica can now sign/refresh the record itself — recovering the name
 * without downtime of the CONTENT (the CID stays pinned throughout).
 *
 * This is a client-driven operation (run by the operator against the target
 * node's RPC), NOT an on-box recurring verb: it reuses the `key-import-publisher`
 * seam ({@link importIpnsKeyIntoPublisher}) to land the key material. Because
 * that seam REFUSES a non-publisher role, we call it with role `publisher` (the
 * target role) — promotion is precisely the act of making this node the
 * publisher, so importing under the publisher role is correct.
 *
 * MUST happen WITHIN the current record's validity window: while the old
 * publisher's ~72h record is still valid (kept alive by replica re-announcement
 * during the grace window), the promoted node's first `name/publish` re-signs
 * before the record lapses, so the name never goes dark. Promotion imports the
 * key ONLY; it does not itself sign — the node signs on its next `republish`.
 */
export async function promoteReplicaToPublisher(
	input: PromoteReplicaInput,
): Promise<PromoteReplicaResult> {
	// Reuse the key-import seam. It refuses any non-publisher role, so we pass
	// the TARGET role (`publisher`): promotion IS making this node the publisher.
	const imported = await importIpnsKeyIntoPublisher({
		client: input.client,
		role: 'publisher',
		keyName: input.keyName,
		derived: input.derived,
	});
	// Flip the role. From here the node is the single signer for this name.
	return {role: 'publisher', keyName: input.keyName, ipns: imported.Id};
}

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
		const record = await readFile(join(cacheDir, name + RECORD_SUFFIX), 'utf8');
		const ipnsId = (
			await readFile(join(cacheDir, name + NAME_SUFFIX), 'utf8')
		).trim();
		if (!ipnsId) return undefined;
		return {record, ipnsId};
	} catch {
		return undefined;
	}
}

/** Production publisher-record fetch: GET the URL and return its body text. */
async function httpFetchText(url: string): Promise<string> {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
	return await res.text();
}
