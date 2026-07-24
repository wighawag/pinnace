/**
 * First-class **site management** — the `site` namespace (spec user stories 4,
 * 15; CONTEXT.md `gateway warming`). Sites are auto-discovered from MFS
 * `/sites/*` (that is how `gateway warming`, IPNS republish, and `status` find
 * them), so managing the sites a node serves = managing those MFS entries + the
 * pins that back them. This module gives the operator explicit verbs for that
 * lifecycle instead of leaving it an implicit side-effect of `deploy`:
 *
 *   - **list**   — enumerate `/sites/*` with each site's current CID and, when a
 *                  same-named keystore key exists, its IPNS id.
 *   - **remove** — `files/rm /sites/<name>` (the entry drops out of
 *                  warm/republish/status auto-discovery) AND `pin/rm <cid>` so
 *                  the content stops being served/announced and its storage is
 *                  reclaimed.
 *   - **add**    — place an already-imported `/ipfs/<cid>` into MFS
 *                  `/sites/<name>` (mkdir parents / rm old / cp). See the
 *                  DESIGN NOTE below on its relationship to `deploy`.
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

/** The three site-management verbs, under the `site` namespace. */
export type SiteVerb = 'list' | 'remove' | 'add';

/** The verbs, in a stable order (for help text / iteration). */
export const SITE_VERBS: readonly SiteVerb[] = ['list', 'remove', 'add'];

/** The MFS directory sites live under. */
const DEFAULT_SITES_DIR = '/sites';

/** One site as listed: its MFS name, current CID, and IPNS id if a key exists. */
export interface SiteListing {
	/** The MFS entry name under `/sites/` (often the ENS name). */
	name: string;
	/** The current content root CID (`files/stat --hash`). */
	cid: string;
	/** The IPNS id, if a same-named keystore key exists (ipfs-mode sites lack one). */
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
	/** The site name (its MFS entry `/sites/<name>`) to remove. */
	name: string;
}

/** The outcome of {@link removeSite}. */
export interface RemoveSiteResult {
	/** The site name that was removed. */
	name: string;
	/** The CID that backed it (undefined if it had no resolvable content). */
	cid?: string;
	/** True when the content was unpinned (storage reclaimed); false if unpin failed. */
	unpinned: boolean;
}

/** Inputs to {@link addSite}. */
export interface AddSiteInput extends SiteBaseInput {
	/** The site name to expose it under (its MFS entry `/sites/<name>`). */
	name: string;
	/** The already-imported content root CID to place into MFS. */
	cid: string;
}

/** The outcome of {@link addSite}. */
export interface AddSiteResult {
	/** The site name that was placed. */
	name: string;
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
	for (const name of entries) {
		const cid = await statCid(input.client, `${sitesDir}/${name}`);
		if (!cid) continue; // an entry with no resolvable CID is skipped, not fatal.
		sites.push({name, cid, ipns: keys.get(name)});
	}
	return sites;
}

/**
 * **remove** — delete a site: `files/rm /sites/<name>` FIRST (so it immediately
 * drops out of MFS auto-discovery and stops being served/announced/warmed),
 * THEN `pin/rm <cid>` to unpin the content so its storage is reclaimed. The CID
 * is resolved up-front with `files/stat` so we know what to unpin after the
 * entry is gone.
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
	const path = `${sitesDir}/${input.name}`;

	// Resolve the CID before we remove the entry (afterwards it is gone).
	const cid = await statCid(input.client, path);

	// Remove the MFS entry first: it stops being discovered/served/announced.
	await input.client.filesRm(path, {recursive: true, force: true});

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

	return {name: input.name, cid, unpinned};
}

/**
 * **add** — expose an existing CID as a served site by placing it into MFS at
 * `/sites/<name>` (the discoverable location warm/republish/status read). This
 * is deploy's MFS-placement step in isolation (see the module DESIGN NOTE): it
 * does NOT build or import a CAR and does NOT pin (the CID is assumed already
 * imported/pinned on the node).
 */
export async function addSite(input: AddSiteInput): Promise<AddSiteResult> {
	const sitesDir = input.sitesDir ?? DEFAULT_SITES_DIR;
	await placeInMfs(input.client, sitesDir, input.name, input.cid);
	return {name: input.name, cid: input.cid};
}

/**
 * The MFS-placement step: `files/mkdir /sites --parents`, `files/rm
 * /sites/<name> --recursive --force` (clear any prior content), then `files/cp
 * /ipfs/<cid> /sites/<name>`. Ported from the reference prototype's deploy MFS
 * placement (`~/searches/ipfs-hetzner/deploy-car.mjs`). Exported so `deploy`
 * can REUSE this exact sequence rather than forking it.
 */
export async function placeInMfs(
	client: KuboRpcClient,
	sitesDir: string,
	name: string,
	cid: string,
): Promise<void> {
	await client.filesMkdir(sitesDir, {parents: true});
	await client.filesRm(`${sitesDir}/${name}`, {recursive: true, force: true});
	await client.filesCp(`/ipfs/${cid}`, `${sitesDir}/${name}`);
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
