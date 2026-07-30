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
 * NOT here: granting a node the key in the first place. That is `authorize`
 * (`./authorize.ts`), a client-driven verb over the `key-import-publisher`
 * seam, which used to live in this module as `promoteReplicaToPublisher` —
 * misfiled, because it is not part of the recurring record sequence, and
 * misnamed, because it never promoted anything (it returned a hard-coded
 * `role: 'publisher'` while persisting no role at all). A node's role lives in
 * `pinnace.json` and in the box's `NODE_ROLE`, neither reachable over Kubo RPC,
 * so a real promotion is a REPROVISION of the box. What this module still
 * gives a lost publisher is the GRACE WINDOW above: replicas keep re-announcing
 * the last signed record for its remaining validity.
 */
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {KuboRpcClient} from '../rpc/kubo-rpc-client.js';
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
 * shape shared with deploy + `pin --set-mode ipns`), so this module's public API is
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
 * PUBLISHER op. For each discovered site that should be republished:
 *   1. `name/publish` to refresh the signed record (~72h lifetime, ~1h ttl),
 *   2. `routing/get` to EXPORT the raw signed record, then
 *   3. write the record + its ipns id under {@link NodeCommandContext.recordsDir}
 *      where replicas fetch them.
 * This is the ONLY place a signing primitive (`name/publish`) runs in the whole
 * sequence.
 *
 * WHETHER to sign is decided by the site's stored **metadata** `mode` (the
 * `metadata.json` beside its content in MFS, which discovery already read), NOT
 * by a key happening to sit in the keystore — the operator's recorded intent is
 * what the box acts on, which is the whole point of metadata travelling with
 * the site (spec `sites-metadata-in-mfs`). Three tiers:
 *
 *  - stored `ipfs` -> NEVER published, even when a key exists for the id (one
 *    left over from an earlier ipns life, or derived for a sibling purpose).
 *    Reported `ipfs-mode`, deliberately NOT `no-key`: a key IS present, and
 *    saying otherwise would send the operator hunting for a key problem that
 *    does not exist.
 *  - stored `ipns` -> exactly as before: a key signs+exports (`exported`), no
 *    key reports `no-key` (the site wants a name this node cannot sign for).
 *  - mode ABSENT -> exactly as before, key presence decides. A site placed
 *    before metadata existed (or by an older pinnace) stores no mode, and must
 *    keep republishing rather than silently go dark on this change.
 *
 * DECISION (worth knowing, recorded in
 * `work/notes/observations/republish-absent-mode-is-not-read-as-ipfs-2026-07-26.md`):
 * that last tier is the ONE place in pinnace where an absent `mode` is NOT read
 * as the `ipfs` default (`DEFAULT_SITE_MODE`, the write-side resolver and the
 * CONTEXT.md glossary all say absent means `ipfs`). Applying the default here
 * would take a live mode-less site off the air the moment this shipped, which
 * is a far worse failure than continuing to sign a name the operator has never
 * said to stop signing.
 */
export async function republishAndExport(
	ctx: NodeCommandContext,
	sites: DiscoveredSite[],
): Promise<NodeOpResult> {
	const keys = await listKeys(ctx.client);
	const outcomes: SiteOutcome[] = [];

	for (const site of sites) {
		if (site.metadata.mode === 'ipfs') {
			// The site STORES ipfs: it is addressed by cid and wants no name, so it is
			// not signed even if this node holds a key for its id.
			outcomes.push({id: site.id, cid: site.cid, status: 'ipfs-mode'});
			continue;
		}
		const ipns = keys.get(site.id);
		if (!ipns) {
			// A site that wants a name (or stores no mode at all) but has no key here:
			// nothing to sign or export.
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
	const fetchRecord: PublisherFetch = ctx.publisherFetch ?? httpFetchBytes;
	const outcomes: SiteOutcome[] = [];

	for (const site of sites) {
		// BYTES throughout: the record is binary protobuf, so it never becomes a
		// string anywhere on this path (fetch -> cache -> routing/put).
		let record: Uint8Array | undefined;
		let ipnsId: string | undefined;
		let fromCache = false;

		// Try the publisher first; on ANY failure fall back to the cache.
		if (base) {
			try {
				record = await fetchRecord(
					`${base}/records/${site.id}${RECORD_SUFFIX}`,
				);
				// The NAME sidecar is genuinely text (a `k51...` id), so it is the one
				// thing on this path that is decoded rather than kept as bytes.
				ipnsId = decodeName(
					await fetchRecord(`${base}/records/${site.id}${NAME_SUFFIX}`),
				);
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

		// Re-announce ONLY. No signing, because this is a replica. The bytes go
		// through: `routing/put` VALIDATES the record, so anything that mangled it
		// on the way here (a string round trip, or the un-decoded `routing/get`
		// envelope) is rejected as malformed rather than quietly announced.
		await ctx.client.routingPut(`/ipns/${ipnsId}`, record);
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
 * Read a cached record + its ipns id for a site, or undefined if absent. The
 * RECORD is read as BYTES (no encoding applied); only the name sidecar is text.
 */
async function readCached(
	cacheDir: string,
	name: string,
): Promise<{record: Uint8Array; ipnsId: string} | undefined> {
	try {
		const record = await readFile(join(cacheDir, name + RECORD_SUFFIX));
		const ipnsId = (
			await readFile(join(cacheDir, name + NAME_SUFFIX), 'utf8')
		).trim();
		if (!ipnsId) return undefined;
		return {record: new Uint8Array(record), ipnsId};
	} catch {
		return undefined;
	}
}

/**
 * Decode the `.ipns-name` sidecar: it is a `k51...` id, i.e. genuinely text,
 * unlike the record it sits beside.
 */
function decodeName(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes).trim();
}

/**
 * Production publisher-record fetch: GET the URL and return its body BYTES.
 *
 * `arrayBuffer`, never `text`: this fetches a signed IPNS record, and decoding
 * it as UTF-8 would corrupt it (see the module doc and
 * `work/notes/findings/kubo-routing-get-returns-a-json-envelope-not-the-record.md`).
 */
async function httpFetchBytes(url: string): Promise<Uint8Array> {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
	return new Uint8Array(await res.arrayBuffer());
}
