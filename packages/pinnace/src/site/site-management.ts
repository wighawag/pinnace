/**
 * First-class **site management** — the `site` namespace (spec user stories 4,
 * 15; CONTEXT.md `gateway warming`). Sites are auto-discovered from MFS
 * `/sites/*` (that is how `gateway warming`, IPNS republish, and `status` find
 * them), so managing the sites a node serves = managing those MFS entries + the
 * pins that back them. This module gives the operator explicit verbs for that
 * lifecycle instead of leaving it an implicit side-effect of `deploy`:
 *
 *   - **list**   — enumerate `/sites/*` with each site's current CID and, when a
 *                  same-`id` keystore key exists, its IPNS id.
 *   - **remove** — `files/rm /sites/<id>` (the whole wrapper, so the entry drops
 *                  out of warm/republish/status auto-discovery) AND `pin/rm
 *                  <cid>` so the content stops being served/announced and its
 *                  storage is reclaimed.
 *   - **add**    — place an already-imported `/ipfs/<cid>` into MFS
 *                  `/sites/<id>/content` (mkdir parents / rm old / cp) plus the
 *                  wrapper's `metadata.json`, PRESERVING what the site already
 *                  stores (it states neither `mode` nor `ensName`). See the
 *                  DESIGN NOTE below on its relationship to `deploy`.
 *
 * A site in MFS is a WRAPPER dir — `/sites/<id>/{content, metadata.json}` (see
 * `./site-wrapper.ts`, which owns those paths). So every content-cid read here
 * targets the `content` SUBPATH, never the wrapper dir itself.
 *
 * Every verb speaks ONLY the Kubo RPC seam (MFS + pin endpoints), so the same
 * core is usable both as a TypeScript API and behind the thin `pinnace site
 * <verb>` CLI (CONTEXT.md `core vs cli`). Tests drive it through the recording
 * `MockKuboApi`, never a live daemon (spec Testing Decisions).
 *
 * DESIGN NOTE (add vs deploy) — recorded per the task's "decide during build".
 * `add` is a DISTINCT verb, not an alias over `deploy`. `deploy` (see
 * `deploy-multi-target`) builds a fresh CAR, imports+pins it on every node, and
 * THEN performs this MFS-placement step. `add` is exactly that final placement
 * step in isolation: it takes an EXISTING CID (already imported/pinned, e.g. a
 * known-good historical CID, or one imported out of band) and makes the node
 * serve it under a site name, WITHOUT building or importing a CAR. Adding a site
 * from an existing CID is a meaningful operation deploy does not cover (no fresh
 * artifact), so it earns its own verb. Deploy is expected to REUSE
 * {@link placeInMfs} for its placement step when it lands, keeping a single
 * implementation of the mkdir/rm/cp sequence rather than forking it. This is
 * NOT a new domain concept: `add` sits at the same layer as the other explicit
 * client verbs and reuses the existing `/sites/<name>` MFS convention.
 */
import type {KuboRpcClient} from '../rpc/kubo-rpc-client.js';
import {nextHistory, prunePins, type PrunedCid} from './site-retention.js';
import {
	encodeSiteMetadata,
	resolveSiteMetadataToWrite,
	siteContentPath,
	siteMetadataPath,
	siteWrapperPath,
	PRESERVE_ENS_NAME,
	PRESERVE_SITE_MODE,
	type SiteMetadata,
} from './site-wrapper.js';

/** The three site-management verbs, under the `site` namespace. */
export type SiteVerb = 'list' | 'remove' | 'add';

/** The verbs, in a stable order (for help text / iteration). */
export const SITE_VERBS: readonly SiteVerb[] = ['list', 'remove', 'add'];

/** The MFS directory sites live under. */
const DEFAULT_SITES_DIR = '/sites';

/** One site as listed: its MFS `id`, current CID, and IPNS id if a key exists. */
export interface SiteListing {
	/** The site's single `id` (its MFS wrapper dir under `/sites/`). */
	id: string;
	/** The current content root CID (`files/stat --hash` of `<wrapper>/content`). */
	cid: string;
	/** The IPNS id, if a same-`id` keystore key exists (ipfs-mode sites lack one). */
	ipns?: string;
}

/** Inputs shared by every site-management verb. */
interface SiteBaseInput {
	/** The Kubo RPC client for the node whose sites are being managed. */
	client: KuboRpcClient;
	/** The MFS directory sites live under (default `/sites`). */
	sitesDir?: string;
}

/** Inputs to {@link listSites}. */
export type ListSitesInput = SiteBaseInput;

/** Inputs to {@link removeSite}. */
export interface RemoveSiteInput extends SiteBaseInput {
	/** The site `id` (its MFS entry `/sites/<id>`) to remove. */
	id: string;
}

/** The outcome of {@link removeSite}. */
export interface RemoveSiteResult {
	/** The site `id` that was removed. */
	id: string;
	/** The CID that backed it (undefined if it had no resolvable content). */
	cid?: string;
	/** True when the content was unpinned (storage reclaimed); false if unpin failed. */
	unpinned: boolean;
}

/** Inputs to {@link addSite}. */
export interface AddSiteInput extends SiteBaseInput {
	/** The site `id` to expose it under (its MFS entry `/sites/<id>`). */
	id: string;
	/** The already-imported content root CID to place into MFS. */
	cid: string;
}

/** The outcome of {@link addSite}. */
export interface AddSiteResult {
	/** The site `id` that was placed. */
	id: string;
	/** The CID that now backs it in MFS. */
	cid: string;
}

/**
 * **list** — enumerate the sites the node currently serves (MFS `/sites/*`),
 * annotating each with its current CID (from `files/stat`) and, when a keystore
 * key of the same name exists, its IPNS id (from `key/list -l`). A fresh box
 * with no `/sites` dir yields an empty list, not an error.
 */
export async function listSites(input: ListSitesInput): Promise<SiteListing[]> {
	const sitesDir = input.sitesDir ?? DEFAULT_SITES_DIR;
	const entries = await lsSites(input.client, sitesDir);
	if (entries.length === 0) return [];

	const keys = await listKeys(input.client);
	const sites: SiteListing[] = [];
	for (const id of entries) {
		// The CONTENT subpath: the wrapper dir's own hash is not the site's cid.
		const cid = await statCid(input.client, siteContentPath(sitesDir, id));
		if (!cid) continue; // an entry with no resolvable CID is skipped, not fatal.
		sites.push({id, cid, ipns: keys.get(id)});
	}
	return sites;
}

/**
 * **remove** — delete a site: `files/rm /sites/<name>` FIRST (the whole WRAPPER,
 * recursively — content AND metadata — so it immediately drops out of MFS
 * auto-discovery and stops being served/announced/warmed), THEN `pin/rm <cid>`
 * to unpin the content so its storage is reclaimed. The CID is resolved up-front
 * with `files/stat` of the wrapper's CONTENT subpath (the site's cid, not the
 * wrapper's own hash) so we know what to unpin after the entry is gone.
 *
 * The MFS removal is the load-bearing step and is always attempted. The unpin
 * is best-effort: if the content was never pinned (or is pinned indirectly),
 * `pin/rm` errors, which is REPORTED (`unpinned: false`) rather than thrown, so
 * a partially-pinned site still removes cleanly.
 */
export async function removeSite(
	input: RemoveSiteInput,
): Promise<RemoveSiteResult> {
	const sitesDir = input.sitesDir ?? DEFAULT_SITES_DIR;

	// Resolve the CONTENT cid before we remove the wrapper (afterwards it is
	// gone) — unpinning the wrapper's own hash would leave the site's content
	// pinned forever.
	const cid = await statCid(input.client, siteContentPath(sitesDir, input.id));

	// Remove the whole wrapper first: it stops being discovered/served/announced.
	await input.client.filesRm(siteWrapperPath(sitesDir, input.id), {
		recursive: true,
		force: true,
	});

	// Then reclaim storage by unpinning the content. Best-effort: a site that
	// was never pinned (or pinned indirectly) must not fail the removal.
	let unpinned = false;
	if (cid) {
		try {
			await input.client.pinRm(cid);
			unpinned = true;
		} catch {
			unpinned = false;
		}
	}

	return {id: input.id, cid, unpinned};
}

/**
 * **add** — expose an existing CID as a served site by placing it into the MFS
 * wrapper `/sites/<name>/` (the discoverable location warm/republish/status
 * read). This is deploy's MFS-placement step in isolation (see the module
 * DESIGN NOTE): it does NOT build or import a CAR and does NOT pin (the CID is
 * assumed already imported/pinned on the node).
 *
 * DECISION (`site add` PRESERVES; the `ipfs` it records is a DEFAULT, not a
 * report) — recorded because it governs a USER-VISIBLE surface. `placeInMfs`
 * always writes the wrapper's `metadata.json`, so `add` must say something about
 * both fields, and `add` has no flag for either: it states NOTHING. Stating
 * nothing is PRESERVE, exactly as it is for `deploy`/`pin` (CONTEXT.md `mode`,
 * `ensName`), so `add` resolves its metadata through the SAME
 * {@link resolveSiteMetadataToWrite} seam with both intents preserving. A FIRST
 * `add` therefore records `{mode: 'ipfs'}` because `ipfs` is the DEFAULT mode of
 * a site that stores none (`DEFAULT_SITE_MODE` in `./site-wrapper.ts`) — NOT because `add`
 * performed an ipfs-shaped placement. That earlier reading ("it writes the mode
 * it actually performed") was true of the placement but licensed destroying the
 * OTHER field and demoting a mode the operator set deliberately, which is the
 * silent loss this seam exists to stop.
 *
 * CONSEQUENCE to ratify: re-`add`ing over a stored-`ipns` site keeps
 * `mode: 'ipns'` while `add` itself still signs nothing (it touches no key and
 * never `name/publish`es). That is correct — `mode` records how the site is
 * ADDRESSED, and refreshing the name is `deploy`/`pin`'s job — but it does mean
 * an `add` of a NEWER cid under a published name leaves that name pointing at
 * the OLD cid until the next `deploy`/`pin`. Alternatives considered: (a)
 * keeping the hard `{mode:'ipfs'}` — the defect itself; (b) giving `add` its own
 * mode/ens flags — a wider surface than the task, and still not what an operator
 * who stated nothing asked for. What it touches: the `site add` CLI verb (which
 * gains the refusal below), CONTEXT.md's `pin`/`metadata` glossary entries.
 *
 * @throws {SiteMetadataUnreadableError} when the node cannot say what the site
 * already stores (down, or a stale token): nothing is placed, because the
 * alternative is overwriting stored metadata on a guess.
 */
export async function addSite(input: AddSiteInput): Promise<AddSiteResult> {
	const sitesDir = input.sitesDir ?? DEFAULT_SITES_DIR;
	// `add` states neither field, so BOTH preserve: the same read-modify-write
	// its sibling verbs do, through the same resolver (no parallel rule).
	const metadata = await resolveSiteMetadataToWrite({
		client: input.client,
		sitesDir,
		id: input.id,
		mode: PRESERVE_SITE_MODE,
		ensName: PRESERVE_ENS_NAME,
	});
	await placeInMfs(input.client, sitesDir, input.id, input.cid, metadata);
	return {id: input.id, cid: input.cid};
}

/**
 * What a placement did to the site's PREVIOUS content, beyond writing the new
 * one: the superseded cid, the history now stored, and the outcome of any
 * unpinning the site's `keep` policy asked for.
 *
 * Every part of it is BEST-EFFORT bookkeeping around a load-bearing write. The
 * placement itself (content + metadata) is what must succeed; a node that cannot
 * say what it held before simply records no history for this write, rather than
 * failing a deploy over an accounting detail.
 */
export interface PlaceResult {
	/** The cid now placed at `/sites/<id>/content`. */
	cid: string;
	/** What the site resolved to before this write, when it changed. */
	previousCid?: string;
	/** The superseded cids still held (and so still accountable), newest first. */
	history: string[];
	/** Cids the keep policy acted on, with each outcome. */
	pruned: PrunedCid[];
}

/**
 * The MFS-placement step, writing the site's WRAPPER: `files/mkdir
 * /sites/<id> --parents` (the sites dir AND the wrapper), `files/rm
 * /sites/<id>/content --recursive --force` (clear any prior content, leaving
 * the wrapper), `files/cp /ipfs/<cid> /sites/<id>/content`, then `files/write
 * /sites/<id>/metadata.json` with the per-site {@link SiteMetadata}. Ported
 * from the reference prototype's deploy MFS placement
 * (`~/searches/ipfs-hetzner/deploy-car.mjs`), extended with the wrapper +
 * metadata. Exported so `deploy` and `pin` REUSE this exact sequence rather
 * than forking it.
 *
 * IDEMPOTENT: re-placing a site REPLACES both parts — the content (rm + cp) and
 * the metadata (`files/write` truncates, so a re-write never leaves a tail of
 * the previous JSON). Re-running `deploy` for the same `id` is therefore how a
 * site's metadata is changed; there is no separate `update` verb.
 *
 * `metadata` is REQUIRED, not defaulted here: what a site's metadata says is the
 * CALLER's knowledge (deploy/pin know the mode they ran in), and a default
 * buried at this shared seam would silently author per-site state on everyone's
 * behalf.
 */
export async function placeInMfs(
	client: KuboRpcClient,
	sitesDir: string,
	id: string,
	cid: string,
	metadata: SiteMetadata,
): Promise<PlaceResult> {
	const content = siteContentPath(sitesDir, id);

	// What this site resolved to BEFORE this write: read first, because the `cp`
	// below replaces it. Best-effort by construction (see PlaceResult): a node
	// that cannot answer must not turn a placement into a failure.
	const previousCid = await readSiteContentCid(client, sitesDir, id);

	await client.filesMkdir(siteWrapperPath(sitesDir, id), {parents: true});
	await client.filesRm(content, {recursive: true, force: true});
	await client.filesCp(`/ipfs/${cid}`, content);

	// Bookkeeping, then (only if the site states a keep policy) the unpinning it
	// asks for. Both happen BEFORE the metadata write, so what is stored is the
	// history that survived: a cid whose unpin failed stays listed and is retried
	// by the next prune, rather than being forgotten while still on disk.
	const history = nextHistory(metadata.history, previousCid, cid);
	const {pruned, history: retained} = await prunePins({
		client,
		sitesDir,
		history,
		...(metadata.keep !== undefined ? {keep: metadata.keep} : {}),
		apply: true,
	});

	await client.filesWrite(
		siteMetadataPath(sitesDir, id),
		encodeSiteMetadata({
			...metadata,
			...(retained.length > 0 ? {history: retained} : {history: undefined}),
		}),
	);
	return {
		cid,
		...(previousCid !== undefined && previousCid !== cid ? {previousCid} : {}),
		history: retained,
		pruned,
	};
}

// ---------------------------------------------------------------------------
// Small shared Kubo reads (fail-soft where a missing dir is not an error).
// ---------------------------------------------------------------------------

/** List the entry NAMES under the sites dir; empty on a fresh box (no dir). */
async function lsSites(
	client: KuboRpcClient,
	sitesDir: string,
): Promise<string[]> {
	let listing: {Entries?: Array<{Name?: string}> | null};
	try {
		listing = await client.filesLs<{Entries?: Array<{Name?: string}> | null}>(
			sitesDir,
		);
	} catch {
		// No /sites dir yet (fresh box) — nothing to list, not an error.
		return [];
	}
	const names: string[] = [];
	for (const entry of listing.Entries ?? []) {
		if (entry?.Name) names.push(entry.Name);
	}
	return names;
}

/**
 * The CID a site's wrapper currently points at (`files/stat --hash` of
 * `<sitesDir>/<id>/content`), or undefined when the site does not exist / has no
 * resolvable content.
 *
 * Exported because it is the seam PROMOTION reads: `pin --from-site <id>` needs
 * one node's answer to "what is this site serving right now?", and the wrapper's
 * CONTENT subpath is that answer (the wrapper dir's OWN hash is not the site's
 * cid, a distinction {@link removeSite} exists to get right too).
 */
export async function readSiteContentCid(
	client: KuboRpcClient,
	sitesDir: string,
	id: string,
): Promise<string | undefined> {
	return statCid(client, siteContentPath(sitesDir, id));
}

/** Stat an MFS path for its current CID, or undefined if it cannot be resolved. */
async function statCid(
	client: KuboRpcClient,
	path: string,
): Promise<string | undefined> {
	try {
		const stat = await client.filesStat<{Hash?: string}>(path);
		return stat?.Hash;
	} catch {
		return undefined;
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
