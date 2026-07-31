/**
 * **Retention**: what happens to a site's PREVIOUS content when a new build
 * replaces it.
 *
 * The problem this exists for. `deploy`/`pin` replace `/sites/<id>/content` and
 * pin the new root, but they never unpinned the old one, so every re-deploy left
 * an ORPHAN pin: content the node keeps for ever, that no site references, that
 * `status` cannot see, and that no pinnace verb could reclaim (the only handle
 * left was a raw Kubo `pin/rm`). In `ipfs` mode, where every build has its own
 * address, that is one orphan per push.
 *
 * The shape of the fix is two halves, and they are deliberately NOT the same
 * half:
 *
 *  - REMEMBERING is automatic and cheap. The write path records the superseded
 *    cid in the site's own `metadata.json` ({@link SiteMetadata.history}), most
 *    recent first, so superseded content stays accountable (and rollback becomes
 *    `pinnace pin <old-cid> --as <id>`).
 *  - FORGETTING is opt-in and explicit, because pinnace CANNOT SEE AN ENS
 *    RECORD. It knows what a gateway served, never what a contenthash says, so
 *    it can never prove an old cid is unreferenced. A default retention would
 *    therefore eventually delete a live site: exactly the failure mode an
 *    `ipfs`-mode site is most exposed to, since its record moves only when a
 *    human moves it. So an absent `keep` means KEEP EVERYTHING, and unpinning
 *    happens only where the operator asked for it (`--set-keep <n>`, or the
 *    `prune` verb, which is dry-run by default).
 *
 * THE CROSS-SITE GUARD (the non-obvious invariant). A Kubo recursive pin is not
 * reference-counted per referrer: one `pin/rm` unpins the cid however many
 * things point at it. And sites SHARE cids routinely \u2014 promoting a staging build
 * (`pin --from-site`) leaves `mandalas-staging` and `mandalas.eth` holding the
 * SAME cid, and rolling back re-points a site at a cid still in its own history.
 * So nothing here unpins a cid that is the CURRENT content of ANY site on that
 * node ({@link collectProtectedCids}), and a cid skipped for that reason is
 * REPORTED rather than silently dropped from history: it is still held, so it
 * must stay accountable.
 *
 * A cid also leaves `history` only when it has actually been unpinned, so a
 * failed unpin is retried by the next prune instead of being forgotten while
 * still occupying disk.
 *
 * Finally: unpinning makes blocks ELIGIBLE for collection, it does not free
 * space. That happens on Kubo's own `repo/gc`. Nothing here runs a GC \u2014 a
 * blocking, node-wide sweep is not something a deploy should trigger behind an
 * operator's back.
 */
import type {KuboRpcClient} from '../rpc/kubo-rpc-client.js';
import {readSiteContentCid} from './site-management.js';
import {
	encodeSiteMetadata,
	readSiteMetadata,
	siteMetadataPath,
	siteWrapperPath,
} from './site-wrapper.js';

/**
 * The site's history AFTER a new cid is placed: the superseded cid prepended,
 * most recent first, with no duplicates.
 *
 * Pure, and the ONE place the ordering/dedup rule lives. Two cases matter:
 *  - re-placing the SAME cid (a no-op deploy) records nothing: it superseded
 *    nothing.
 *  - placing a cid that is IN the history (a rollback) removes it from there,
 *    because it is the current content again, not a superseded build. Leaving it
 *    would let a later prune unpin the live cid.
 */
export function nextHistory(
	history: readonly string[] | undefined,
	previousCid: string | undefined,
	newCid: string,
): string[] {
	const kept = (history ?? []).filter(
		(cid) => cid !== newCid && cid !== previousCid,
	);
	const superseded = previousCid && previousCid !== newCid ? [previousCid] : [];
	return [...superseded, ...kept];
}

/** One cid considered for unpinning, and what happened to it. */
export interface PrunedCid {
	/** The superseded content cid. */
	cid: string;
	/** `unpinned`, `protected` (another site holds it), or `failed`. */
	outcome: 'unpinned' | 'protected' | 'failed';
	/** Why it failed (only for `failed`). */
	error?: string;
}

/** What a prune did, and what the site's history should now be. */
export interface PruneResult {
	/** Every cid the keep policy selected, with its outcome. */
	pruned: PrunedCid[];
	/** The history to STORE: the kept cids plus anything not actually unpinned. */
	history: string[];
}

/**
 * Every cid a site on this node currently RESOLVES to \u2014 the set nothing may
 * unpin. Read from MFS (`/sites/*` then each wrapper's `content`), which is the
 * same discovery the on-box loop and `status` use, so the guard cannot drift
 * from what the node actually serves.
 *
 * A listing that fails yields an EMPTY set, which callers must treat as "cannot
 * prune safely" rather than "nothing is protected"; {@link prunePins} takes that
 * decision, so no caller can get it wrong by omission.
 */
export async function collectProtectedCids(
	client: KuboRpcClient,
	sitesDir: string,
): Promise<Set<string>> {
	const protectedCids = new Set<string>();
	const listing = await client.filesLs<{
		Entries?: Array<{Name?: string}> | null;
	}>(sitesDir);
	for (const entry of listing.Entries ?? []) {
		if (!entry?.Name) continue;
		const cid = await readSiteContentCid(client, sitesDir, entry.Name);
		if (cid) protectedCids.add(cid);
	}
	return protectedCids;
}

/** Inputs to {@link prunePins}. */
export interface PrunePinsInput {
	/** The node to prune on. */
	client: KuboRpcClient;
	/** The MFS directory sites live under. */
	sitesDir: string;
	/** The site's history, most recent first. */
	history: readonly string[];
	/**
	 * How many superseded builds to KEEP. `undefined` prunes nothing at all (the
	 * default policy), so callers can pass a site's stored `keep` straight
	 * through without branching.
	 */
	keep?: number;
	/** False = DRY RUN: decide everything, unpin nothing. */
	apply: boolean;
}

/**
 * Apply a keep policy to one site's history on ONE node: unpin the superseded
 * cids beyond `keep`, skipping any that another site still resolves to, and
 * return both the outcomes and the history to store.
 *
 * With `apply: false` it is a DRY RUN that still does every read and every
 * check, including the cross-site guard, so what it prints is what a real run
 * would do rather than an optimistic sketch.
 *
 * @throws if the protected-cid listing fails: an unpin decided against an
 * unknown set of live cids is exactly the mistake this module exists to prevent.
 */
export async function prunePins(input: PrunePinsInput): Promise<PruneResult> {
	const history = [...input.history];
	if (input.keep === undefined || history.length <= input.keep) {
		return {pruned: [], history};
	}
	const keptCount = input.keep;
	const victims = history.slice(keptCount);

	let protectedCids: Set<string>;
	try {
		protectedCids = await collectProtectedCids(input.client, input.sitesDir);
	} catch (cause) {
		throw new Error(
			`refusing to prune '${siteWrapperPath(input.sitesDir, '<site>')}'-style ` +
				`entries: could not list the sites on this node (${
					cause instanceof Error ? cause.message : String(cause)
				}), so it cannot be checked whether a superseded cid is still the ` +
				`content of ANOTHER site. Unpinning is not reference-counted, so that ` +
				`check is not optional.`,
			{cause},
		);
	}

	const pruned: PrunedCid[] = [];
	const stillHeld: string[] = [];
	for (const cid of victims) {
		if (protectedCids.has(cid)) {
			// Another site resolves to it (a promotion, or a rollback). It stays
			// pinned AND stays in history: it is still ours to account for.
			pruned.push({cid, outcome: 'protected'});
			stillHeld.push(cid);
			continue;
		}
		if (!input.apply) {
			pruned.push({cid, outcome: 'unpinned'});
			continue;
		}
		try {
			await input.client.pinRm(cid);
			pruned.push({cid, outcome: 'unpinned'});
		} catch (cause) {
			// Keep it in history so the NEXT prune retries it: a cid dropped from
			// history while still pinned is an orphan nothing can see again.
			pruned.push({
				cid,
				outcome: 'failed',
				error: cause instanceof Error ? cause.message : String(cause),
			});
			stillHeld.push(cid);
		}
	}

	return {
		pruned,
		// A dry run reports what WOULD go but changes nothing, so the history it
		// returns is the one already stored.
		history: input.apply
			? [...history.slice(0, keptCount), ...stillHeld]
			: history,
	};
}

/**
 * The site states no retention policy and the caller named no `--keep`, so
 * there is nothing to prune AGAINST.
 *
 * Refusing beats guessing a number. Retention is the one operation here that
 * destroys data, and pinnace cannot see an ENS record, so a default keep would
 * eventually unpin a cid some contenthash still points at.
 */
export class PruneKeepRequiredError extends Error {
	constructor(readonly id: string) {
		super(
			`site '${id}' stores no retention policy, so there is nothing to prune ` +
				`against. Pass --keep <n> for a one-off prune, or record the policy ` +
				`on the site with \`--set-keep <n>\` on its next deploy/pin (an absent ` +
				`keep means KEEP EVERYTHING, which is the safe default: pinnace ` +
				`cannot read an ENS record, so it can never prove an old cid is ` +
				`unreferenced).`,
		);
		this.name = 'PruneKeepRequiredError';
	}
}

/** Inputs to {@link pruneSite}. */
export interface PruneSiteInput {
	/** The node to prune on. */
	client: KuboRpcClient;
	/** The MFS directory sites live under (default `/sites`). */
	sitesDir?: string;
	/** The site to prune. */
	id: string;
	/** A one-off keep count, overriding whatever the site stores. */
	keep?: number;
	/** False = DRY RUN (the default posture of the `prune` verb). */
	apply: boolean;
}

/** What {@link pruneSite} did on ONE node. */
export interface PruneSiteResult {
	/** The site pruned. */
	id: string;
	/** The keep count applied (stated, or the site's stored one). */
	keep: number;
	/** Whether the stated keep came from the caller rather than the site. */
	stated: boolean;
	/** The history BEFORE this prune, newest first. */
	before: string[];
	/** The history now stored (unchanged on a dry run). */
	history: string[];
	/** Each cid the policy selected, with its outcome. */
	pruned: PrunedCid[];
}

/**
 * Prune ONE site on ONE node: read its history + keep from `metadata.json`,
 * apply the policy through {@link prunePins}, and write the surviving history
 * back when anything actually changed.
 *
 * DRY RUN BY DEFAULT is the caller's choice, not this function's, but it is the
 * posture the `prune` verb takes: a dry run performs every read and every check
 * (including the cross-site guard) so its report is what a real run would do.
 *
 * The metadata write-back is skipped when the history is unchanged, so a dry
 * run, and a real run that unpinned nothing, both leave the file untouched.
 *
 * @throws {PruneKeepRequiredError} when neither the caller nor the site states a
 * keep count.
 */
export async function pruneSite(
	input: PruneSiteInput,
): Promise<PruneSiteResult> {
	const sitesDir = input.sitesDir ?? '/sites';
	const stored = await readSiteMetadata(input.client, sitesDir, input.id);
	const keep = input.keep ?? stored.keep;
	if (keep === undefined) throw new PruneKeepRequiredError(input.id);
	const before = stored.history ?? [];

	const {pruned, history} = await prunePins({
		client: input.client,
		sitesDir,
		history: before,
		keep,
		apply: input.apply,
	});

	if (input.apply && history.length !== before.length) {
		await input.client.filesWrite(
			siteMetadataPath(sitesDir, input.id),
			encodeSiteMetadata({...stored, history}),
		);
	}
	return {
		id: input.id,
		keep,
		stated: input.keep !== undefined,
		before,
		history,
		pruned,
	};
}
