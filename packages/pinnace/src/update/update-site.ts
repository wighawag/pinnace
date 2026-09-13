/**
 * **update** — change a live site's metadata (`mode`, `ensName`, `keep`)
 * WITHOUT rebuilding or re-placing its content.
 *
 * A site deployed in `ipfs` mode whose build artifacts are gone can still be
 * promoted to `ipns` (or get an `ensName`, or a retention policy): `update`
 * reads the site's CURRENT content CID from MFS, writes the resolved metadata
 * to `/sites/<id>/metadata.json`, and — in `ipns` mode on a publisher — publishes
 * the IPNS record pointing at that existing CID. No CAR is built, no content is
 * imported or re-placed: the metadata is the only thing that moves.
 *
 * This is the command `deploy` cannot be without a source directory: `deploy`
 * builds a CAR and re-imports the (identical) CID on every node to carry a
 * metadata change, which is correct but heavyweight when the operator has only
 * the live site. `update` is the metadata-only path — the same resolution, the
 * same publish, the same pre-flight refusals, but no content round-trip.
 *
 * MODE RESOLUTION, PRE-FLIGHT, and PUBLISH reuse the SAME seams as `deploy` and
 * `pin`: the mode is resolved from the PUBLISHER (stated > stored > default),
 * the keystore is probed up-front, the key is imported if the publisher holds
 * none, and `name/publish arg=/ipfs/<cid>` is the shared publish call. The
 * fan-out uses `Promise.allSettled` so a node that fails is reported, not
 * fatal — a non-empty success subset is still an overall success.
 */
import {KuboRpcClient, type FetchLike} from '../rpc/kubo-rpc-client.js';
import {prunePins, type PrunedCid} from '../site/site-retention.js';
import {
	assertEnsNameIntent,
	encodeSiteMetadata,
	readSiteContentCidForWrite,
	resolveSiteMetadataToWrite,
	siteContentPath,
	siteMetadataPath,
	siteModeIntent,
	PRESERVE_ENS_NAME,
	PRESERVE_SITE_KEEP,
	type EnsNameIntent,
	type SiteKeepIntent,
	type ResolvedSiteMetadata,
} from '../site/site-wrapper.js';
import {lookupIpnsKeyId, publishSiteRecord} from '../publisher/ipns-publish.js';
import {importIpnsKeyIntoPublisher} from '../publisher/key-import.js';
import type {DerivedIpnsKey} from '../derive/ipns-key-derivation.js';
import type {HostRole, SiteMode} from '../config/config-resolution.js';

/** The MFS directory sites live under (matches deploy + pin). */
const DEFAULT_SITES_DIR = '/sites';

/**
 * One update target: a node's RPC endpoint + its OWN token + its role. In
 * `ipns` mode only a `publisher` signs the record; a `replica` writes metadata
 * only.
 */
export interface UpdateSiteTarget {
	/** The node's Kubo RPC base URL. */
	baseUrl: string;
	/** The node's bearer token (each target has its OWN). */
	token: string;
	/** publisher (may sign in ipns mode) or replica (never signs). */
	role: HostRole;
	/** Injectable fetch (tests pass a MockKuboApi); defaults to global fetch. */
	fetchImpl?: FetchLike;
}

/** Inputs to {@link updateSite}. */
export interface UpdateSiteInput {
	/** The site's single `id`: its MFS entry `/sites/<id>` and, in ipns mode, its key name. */
	id: string;
	/**
	 * The mode this update STATES (`--set-mode`): ipfs or ipns. OMITTED =
	 * PRESERVE: the update runs in the mode the site is ALREADY stored under on
	 * the publisher, and only a site that stores none falls back to
	 * {@link DEFAULT_SITE_MODE} (`ipfs`).
	 */
	mode?: SiteMode;
	/**
	 * What this update says about the site's `ensName` in the wrapper metadata.
	 * Omitted = PRESERVE: the update leaves whatever the site already carries.
	 */
	ensName?: EnsNameIntent;
	/**
	 * What this update says about the site's RETENTION (`--set-keep <n>` /
	 * `--unset-keep`). Omitted = PRESERVE.
	 */
	keep?: SiteKeepIntent;
	/** The nodes to update (each with its own token); metadata is written on all. */
	targets: UpdateSiteTarget[];
	/** The MFS directory sites live under (default `/sites`). */
	sitesDir?: string;
	/**
	 * The per-site key derived from the operator's master + this update's `id`
	 * (`deriveIpnsKey`), used ONLY to provision a publisher that does not already
	 * hold it. Unused in `ipfs` mode, and unused in `ipns` mode when the publisher
	 * already holds the key (the CI path). The master itself is env-only and
	 * never reaches this module.
	 */
	derived?: DerivedIpnsKey;
}

/**
 * `update` was asked to change a site the AUTHORITY node does not hold, so
 * there is nothing to update and—decisively—no stored `mode` to PRESERVE.
 *
 * This refusal is what keeps `update` from inheriting a default that is wrong
 * for it. `deploy` may legitimately find the publisher storing nothing (a FIRST
 * deploy, which the same run then creates) and fall back to
 * `DEFAULT_SITE_MODE`. `update` creates nothing, so on this verb "the authority
 * stores nothing" never means "first" — it means DRIFT, and defaulting to
 * `ipfs` there would STATE that demotion to every node that does hold the site,
 * silently stopping a live name from being signed.
 *
 * Absence is established POSITIVELY ({@link readSiteContentCidForWrite}); a
 * node that merely would not answer raises `SiteContentUnreadableError`
 * instead, so this error never stands in for an outage.
 */
export class UpdateSiteMissingError extends Error {
	constructor(
		/** The site id that has no content on the authority node. */
		readonly siteId: string,
		/** The authority node (its Kubo RPC base URL). */
		readonly baseUrl: string,
		/** That node's role, so the message can say WHY it is the authority. */
		readonly role: HostRole,
	) {
		super(
			`site '${siteId}' has no content on ${baseUrl}` +
				`${role === 'publisher' ? ' (the publisher)' : ''}, so there is nothing ` +
				`to update: \`update\` changes the metadata of a site that is already ` +
				`live, and never places content. ` +
				(role === 'publisher'
					? `The publisher is the node that holds the key and signs the name, ` +
						`so it is also the node a preserved \`mode\` is read from — ` +
						`resolving it from a node that does not have the site would write ` +
						`\`ipfs\` over whatever the nodes that DO have it are stored under. `
					: '') +
				`Deploy it first (\`pinnace deploy <dir> ${siteId}\`), or point this ` +
				`node at an existing build (\`pinnace pin --from-site <id> --as ` +
				`${siteId}\`). \`pinnace status\` lists the sites each node holds.`,
		);
		this.name = 'UpdateSiteMissingError';
	}
}

/**
 * The update RESOLVED to `ipns` mode but NOTHING in the fan-out can sign it:
 * no `publisher` among the targets. A loud refusal rather than an update that
 * records `ipns` mode but leaves the name pointing at the old cid (or not
 * published at all). Mirrors `DeployPublisherRequiredError`, thrown before any
 * node is touched.
 */
export class UpdatePublisherRequiredError extends Error {
	constructor(
		readonly siteId: string,
		readonly stated: boolean,
		readonly targets: Array<{role: HostRole}>,
	) {
		super(
			(stated
				? `--set-mode ipns needs a publisher to sign '${siteId}'`
				: `'${siteId}' is already stored in \`ipns\` mode, so this update must ` +
					`refresh its name, but that needs a publisher to sign it`) +
				`: none of the ${targets.length} update target(s) can (` +
				`${targets.map((t) => t.role).join(', ')}). A replica is keyless and ` +
				`only re-announces the publisher's signed record; update with ` +
				`--set-mode ipfs, or include the publisher.`,
		);
		this.name = 'UpdatePublisherRequiredError';
	}
}

/**
 * The update RESOLVED to `ipns` mode but a signing target holds NO key for the
 * site and the caller supplied no {@link UpdateSiteInput.derived} key material.
 * A loud refusal BEFORE any node is written to, never a quiet update that
 * records `ipns` mode but leaves the name on the OLD cid. Mirrors
 * `DeployDerivedKeyRequiredError`.
 */
export class UpdateDerivedKeyRequiredError extends Error {
	constructor(
		readonly siteId: string,
		readonly stated: boolean,
		readonly baseUrl: string,
	) {
		super(
			`updating '${siteId}' in \`ipns\` mode needs the per-site key, but ` +
				`${baseUrl} holds no key named '${siteId}' and no \`derived\` key ` +
				`material was given. ` +
				(stated
					? ''
					: `That mode is what '${siteId}' is already stored under — it is ` +
						`published under this name and this update must refresh it, or the ` +
						`name keeps pointing at the OLD cid. `) +
				`Export PINNACE_MASTER so this update can import the key, or run ` +
				`\`pinnace authorize ${siteId}\` once from a machine that has the ` +
				`master, or update with --set-mode ipfs to stop publishing it.`,
		);
		this.name = 'UpdateDerivedKeyRequiredError';
	}
}

/** A per-target success record. */
export interface UpdateNodeOk {
	/** The node's base URL. */
	baseUrl: string;
	/**
	 * The cid THIS node's wrapper currently resolves to (read from its own MFS).
	 *
	 * Per NODE, deliberately: unlike `deploy` — where the one built CAR root
	 * lands everywhere — `update` places no content, so each node answers with
	 * whatever it was last left holding, and nodes CAN legitimately disagree (a
	 * previous deploy that landed unevenly still exits 0 by the partial-failure
	 * contract). That disagreement is exactly what an operator reaching for this
	 * verb needs to see, so it is reported rather than averaged away.
	 */
	cid: string;
	/** The IPNS id published on this node, if it signed; undefined otherwise. */
	ipns?: string;
	/** Whether this node signed+published an IPNS record. */
	published: boolean;
	/** Superseded cids this node's keep policy acted on, with each outcome. */
	pruned: PrunedCid[];
}

/** A per-target failure record. */
export interface UpdateNodeFailure {
	/** The node's base URL. */
	baseUrl: string;
	/** The error that failed this node's update (the site is still up elsewhere). */
	error: Error;
}

/** The overall update result: the site's CID, and per-node success/failure. */
export interface UpdateSiteResult {
	/**
	 * The AUTHORITY node's content cid: the cid a resolved `ipns` mode actually
	 * published, and the one the site's name therefore resolves to.
	 *
	 * NOT "the cid, assumed identical everywhere": see {@link UpdateNodeOk.cid}.
	 * Taking the first successful node's cid instead would let a stale replica
	 * that happens to sort first report a cid the published name does not point
	 * at — which a CI step reading `.cid` would then act on.
	 */
	cid: string;
	/** The site's resolved mode. */
	mode: SiteMode;
	/**
	 * Nodes whose cid DIFFERS from {@link cid} (they hold another build). Empty
	 * when the fan-out agrees. Surfaced because `update` cannot fix it — only a
	 * `deploy` or a `pin --from-site` can — so the operator has to be told.
	 */
	diverged: Array<{baseUrl: string; cid: string}>;
	/** Nodes where the metadata was written (plus publish where applicable). */
	ok: UpdateNodeOk[];
	/** Nodes whose update failed (reported, not thrown). */
	failed: UpdateNodeFailure[];
	/** True when at least one node succeeded. */
	success: boolean;
}

/**
 * What the PRE-FLIGHT `key/list` learned about ONE signing target's keystore.
 */
type KeystoreProbe =
	{kind: 'held'; ipns: string} | {kind: 'absent'} | {kind: 'unreachable'};

/** The resolved per-update plan every target is executed against (internal). */
interface UpdatePlan {
	id: string;
	mode: SiteMode;
	sitesDir: string;
	ensName: EnsNameIntent;
	keep: SiteKeepIntent;
	stated: boolean;
	derived?: DerivedIpnsKey;
}

/**
 * Update a live site's metadata: RESOLVE the mode, then on each target read the
 * current content CID, write the resolved metadata to `metadata.json`, and (in
 * `ipns` mode on a publisher) publish the IPNS record pointing at that CID. No
 * content is built, imported, or re-placed.
 *
 * @throws {EnsNameInferenceError} for a bare `--set-ens-name` on a non-`.eth` id.
 * @throws {SiteMetadataUnreadableError} when the PUBLISHER cannot say what the
 * site stores and the mode/ensName are being PRESERVED.
 * @throws {UpdatePublisherRequiredError} in a resolved `ipns` mode when no
 * target can sign.
 * @throws {UpdateDerivedKeyRequiredError} in a resolved `ipns` mode when a
 * signing target holds no key and no `derived` key was supplied.
 */
export async function updateSite(
	input: UpdateSiteInput,
): Promise<UpdateSiteResult> {
	const {id, targets} = input;
	if (targets.length === 0) {
		throw new Error('updateSite requires at least one target node');
	}
	const ensName = input.ensName ?? PRESERVE_ENS_NAME;
	const keep = input.keep ?? PRESERVE_SITE_KEEP;
	assertEnsNameIntent(ensName, id);
	const sitesDir = input.sitesDir ?? DEFAULT_SITES_DIR;

	// The AUTHORITY: the node whose view of this site decides the run. The
	// publisher when there is one (it holds the key, it signs the name, and so it
	// is the node a preserved `mode` must be read from); otherwise the first
	// target, so a publisher-less fan-out still resolves from a node that really
	// holds the site rather than from a default.
	const authorityIndex = Math.max(
		targets.findIndex((target) => target.role === 'publisher'),
		0,
	);
	const authority = targets[authorityIndex];
	const authorityClient = clientFor(authority);

	// PRE-FLIGHT 1: the site must EXIST on the authority. Absence is established
	// POSITIVELY, so a node that merely would not answer raises
	// SiteContentUnreadableError instead of being reported as "not deployed".
	// Without this, a preserved mode read from a publisher that does not hold the
	// site resolves to `ipfs` and STATES that demotion to every node that does.
	const authorityContent = await readSiteContentCidForWrite(
		authorityClient,
		sitesDir,
		id,
	);
	if (authorityContent.kind === 'absent') {
		throw new UpdateSiteMissingError(id, authority.baseUrl, authority.role);
	}

	// The ONE mode this whole fan-out runs in (stated > the authority's stored >
	// — and there is no third tier here, because the authority provably holds the
	// site). The authority's read doubles as its own metadata resolution.
	const resolved = await resolveFanOutMode(
		input,
		authorityClient,
		authorityIndex,
		sitesDir,
		ensName,
		keep,
	);
	const mode = resolved.mode;

	// PRE-FLIGHT 2: can this update actually produce the name it was asked for?
	// Answered before any node is written to, so a refusal changes nothing.
	const stated = input.mode !== undefined;
	const keystores = await assertCanSign(input, mode, stated);

	const plan: UpdatePlan = {
		id,
		mode,
		sitesDir,
		ensName,
		keep,
		stated,
		...(input.derived ? {derived: input.derived} : {}),
	};

	// Fan out. allSettled so one node's failure never sinks the others.
	const settled = await Promise.allSettled(
		targets.map((target, i) =>
			updateOnNode(
				target,
				plan,
				i === resolved.resolvedFrom ? resolved.metadata : undefined,
				keystores[i],
				i === authorityIndex ? authorityContent.cid : undefined,
			),
		),
	);

	const ok: UpdateNodeOk[] = [];
	const failed: UpdateNodeFailure[] = [];
	settled.forEach((outcome, i) => {
		const baseUrl = targets[i].baseUrl;
		if (outcome.status === 'fulfilled') {
			ok.push(outcome.value);
		} else {
			failed.push({baseUrl, error: asError(outcome.reason)});
		}
	});

	// The AUTHORITY's cid, never `ok[0]`: it is the cid a resolved `ipns` mode
	// just published, so it is the one the name resolves to. Nodes holding
	// anything else are REPORTED rather than silently represented.
	const cid = authorityContent.cid;
	const diverged = ok
		.filter((node) => node.cid !== cid)
		.map((node) => ({baseUrl: node.baseUrl, cid: node.cid}));

	return {cid, mode, diverged, ok, failed, success: ok.length > 0};
}

/**
 * Resolve the ONE mode this update runs in, from the PUBLISHER target — the
 * node that holds the key and actually signs. Mirrors deploy's and pin's
 * resolution exactly (one concept, one rule). A STATED mode needs no node; only
 * the `preserve` intent reads, and that read doubles as the publisher's own
 * metadata resolution (returned as `metadata`, so the publisher is not read
 * twice). With NO publisher among the targets there is nothing to resolve from
 * — and nothing that could sign — so the default applies.
 */
async function resolveFanOutMode(
	input: UpdateSiteInput,
	authorityClient: KuboRpcClient,
	authorityIndex: number,
	sitesDir: string,
	ensName: EnsNameIntent,
	keep: SiteKeepIntent,
): Promise<{
	mode: SiteMode;
	resolvedFrom: number;
	metadata?: ResolvedSiteMetadata;
}> {
	const intent = siteModeIntent(input.mode);
	if (intent.kind === 'set') return {mode: intent.mode, resolvedFrom: -1};
	const metadata = await resolveSiteMetadataToWrite({
		client: authorityClient,
		sitesDir,
		id: input.id,
		mode: intent,
		ensName,
		keep,
	});
	return {mode: metadata.mode, resolvedFrom: authorityIndex, metadata};
}

/**
 * The PRE-FLIGHT gate of `ipns` mode: can this update actually produce the name?
 * Answered before any node is written to. Mirrors deploy's `assertCanSign`.
 */
async function assertCanSign(
	input: UpdateSiteInput,
	mode: SiteMode,
	stated: boolean,
): Promise<Array<KeystoreProbe | undefined>> {
	const {targets, id} = input;
	const none: Array<KeystoreProbe | undefined> = targets.map(() => undefined);
	if (mode !== 'ipns') return none;
	if (!targets.some(canSign)) {
		throw new UpdatePublisherRequiredError(
			id,
			stated,
			targets.map((t) => ({role: t.role})),
		);
	}

	const probes = [...none];
	await Promise.all(
		targets.map(async (target, i) => {
			if (!canSign(target)) return;
			try {
				const ipns = await lookupIpnsKeyId(clientFor(target), id);
				probes[i] = ipns ? {kind: 'held', ipns} : {kind: 'absent'};
			} catch {
				probes[i] = {kind: 'unreachable'};
			}
		}),
	);

	if (!input.derived) {
		const keyless = probes.findIndex((probe) => probe?.kind === 'absent');
		if (keyless >= 0) {
			throw new UpdateDerivedKeyRequiredError(
				id,
				stated,
				targets[keyless].baseUrl,
			);
		}
	}
	return probes;
}

/** The per-node client every step of the update speaks through. */
function clientFor(target: UpdateSiteTarget): KuboRpcClient {
	return new KuboRpcClient({
		baseUrl: target.baseUrl,
		token: target.token,
		fetchImpl: target.fetchImpl,
	});
}

/** Whether this target may SIGN the name: a `publisher`. */
function canSign(target: UpdateSiteTarget): boolean {
	return target.role === 'publisher';
}

/**
 * Update ONE node: read the current content CID, write the resolved metadata,
 * and in `ipns` mode on a publisher publish the IPNS record. Rejects on any RPC
 * failure so the caller's allSettled records it as a per-node failure.
 *
 * `metadata` is this node's ALREADY-resolved metadata when the fan-out's mode
 * was read from it (the publisher); every other node resolves its own here.
 */
async function updateOnNode(
	target: UpdateSiteTarget,
	plan: UpdatePlan,
	metadata?: ResolvedSiteMetadata,
	probe?: KeystoreProbe,
	knownCid?: string,
): Promise<UpdateNodeOk> {
	const {id, mode, sitesDir, ensName} = plan;
	const client = clientFor(target);

	// 1. This node's CURRENT content cid. The update places no content, but the
	//    cid is what a resolved `ipns` mode publishes and what the report names.
	//    STRICT: a node that will not answer raises SiteContentUnreadableError,
	//    never the "has it been deployed here?" absence — telling an operator to
	//    deploy to a node whose real problem is a rotated token sends them to fix
	//    the wrong thing. The authority's cid is passed in, already established.
	let cid = knownCid;
	if (cid === undefined) {
		const read = await readSiteContentCidForWrite(client, sitesDir, id);
		if (read.kind === 'absent') {
			// A genuine absence on a NON-authority node is only that node's failure:
			// it may have been added after this site's last deploy, and the nodes
			// that do hold it are still updated.
			throw new Error(
				`site '${id}' has no content on ${target.baseUrl} (nothing at ` +
					`${siteContentPath(sitesDir, id)}). This node has never been ` +
					`deployed this site; \`pinnace pin --from-site ${id} --as ${id}\` ` +
					`from a node that holds it, or deploy again to fan it out.`,
			);
		}
		cid = read.cid;
	}

	// 2. Resolve THIS node's metadata (the authority's is passed in, already
	//    resolved). The RESOLVED mode is STATED to every node so none can
	//    disagree about how the site is addressed; ensName/keep/history resolve
	//    against this node's own stored metadata when the intent is preserve.
	const resolved =
		metadata ??
		(await resolveSiteMetadataToWrite({
			client,
			sitesDir,
			id,
			mode: {kind: 'set', mode},
			ensName,
			keep: plan.keep,
		}));

	// 3. Apply the site's keep policy, exactly as `placeInMfs` does for the
	//    verbs that DO place content. `update` writes `metadata.json` directly
	//    (it has no content to place), so without this an operator's
	//    `--set-keep 2` would be RECORDED and never ACTED ON — a flag that means
	//    nothing, and a README that says the policy is applied as each write
	//    happens. The content cid is unchanged, so nothing is superseded here:
	//    the history carried forward is pruned as-is.
	//
	//    Pruning precedes the metadata write for the same reason it does in
	//    `placeInMfs`: what gets STORED is the history that SURVIVED, so a cid
	//    whose unpin failed stays listed and is retried by the next prune rather
	//    than forgotten while still on disk.
	const {pruned, history: retained} = await prunePins({
		client,
		sitesDir,
		history: resolved.history ?? [],
		...(resolved.keep !== undefined ? {keep: resolved.keep} : {}),
		apply: true,
	});

	// 4. Write the metadata. `files/write` sends create+parents+truncate, so this
	//    REPLACES the file rather than appending into it.
	await client.filesWrite(
		siteMetadataPath(sitesDir, id),
		encodeSiteMetadata({
			...resolved,
			...(retained.length > 0 ? {history: retained} : {history: undefined}),
		}),
	);

	// 5. Mode branch: ipns mode ADDS publish, and ONLY on a publisher. The
	//    record points at the EXISTING content cid (no new content was made).
	if (mode === 'ipns' && canSign(target)) {
		const ipns = await publish(client, target, plan, cid, probe);
		return {baseUrl: target.baseUrl, cid, ipns, published: true, pruned};
	}

	return {baseUrl: target.baseUrl, cid, published: false, pruned};
}

/**
 * The publish path on ONE signing publisher (ipns mode), composed from the
 * EXISTING seams — exactly as deploy's and pin's publish paths compose them.
 */
async function publish(
	client: KuboRpcClient,
	target: UpdateSiteTarget,
	plan: UpdatePlan,
	cid: string,
	probe?: KeystoreProbe,
): Promise<string> {
	const {id, derived} = plan;
	let ipns =
		probe?.kind === 'held'
			? probe.ipns
			: probe?.kind === 'absent'
				? undefined
				: await lookupIpnsKeyId(client, id);
	if (!ipns) {
		if (!derived) {
			throw new UpdateDerivedKeyRequiredError(id, plan.stated, target.baseUrl);
		}
		const imported = await importIpnsKeyIntoPublisher({
			client,
			role: target.role,
			keyName: id,
			derived,
		});
		ipns = imported.Id ?? derived.ipnsId;
	}
	await publishSiteRecord({client, id, cid});
	return ipns;
}

/** Coerce an unknown rejection reason into an Error. */
function asError(reason: unknown): Error {
	return reason instanceof Error ? reason : new Error(String(reason));
}
