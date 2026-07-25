/**
 * **pin** — take custody of an EXTERNAL network CID: content the operator has
 * only the CID for (not the files), pinned REDUNDANTLY across every configured
 * node and placed in MFS so it is tracked exactly like a site. This turns the
 * operator's boxes into a self-hosted pinning service for other people's
 * content, not only for their own deploys (spec user stories 4, 15; in `ipns`
 * mode also 8, 11, 12 — the derived key, node-side signing, one publisher).
 *
 * Per node the flow is: `pin/add?arg=<cid>&recursive=true` (Kubo RESOLVES and
 * FETCHES the DAG over the network, then pins it), then {@link placeInMfs} at
 * `/sites/<name>` so `gateway warming`, IPNS republish-discovery and `status`
 * auto-discover it (it shows on the dashboard). It speaks ONLY the Kubo RPC seam
 * ({@link KuboRpcClient}), so it is host-agnostic and testable against the
 * recording mock (no live daemon).
 *
 * PER-PIN `mode` BRANCH (CONTEXT.md `mode`; the SAME two values `deploy` uses,
 * not a second concept):
 *  - `ipfs` (the DEFAULT): pin + MFS only. The pin's address is the immutable
 *    `ipfs://<cid>` — no key, no publish, nothing signed.
 *  - `ipns`: everything above PLUS the operator's OWN stable name for that
 *    mirrored content: the per-site key derived from their master + the `--as
 *    <name>` id is imported onto the PUBLISHER ({@link importIpnsKeyIntoPublisher},
 *    the same call `promote` makes) if absent, then the publisher signs
 *    `name/publish arg=/ipfs/<cid>` through the SHARED publish seam
 *    (`../publisher/ipns-publish.ts`) deploy's ipns mode uses. The address is the
 *    stable `ipns://<id>`, and re-pinning a NEWER cid under the same name
 *    re-publishes, so the pointer moves while the name stays.
 *
 * The honest model this gives the operator: the CONTENT is still someone else's
 * (they only mirror a snapshot), but the NAME is theirs (their key, their
 * master) — a mutable pointer THEY control to content they keep alive.
 *
 * PUBLISHER-ONLY PUBLISH, ALL-NODE PIN. The pin still fans out to EVERY target
 * (redundancy is the point of the verb); only the `publisher` signs, exactly as
 * in deploy's ipns mode — a `replica` is keyless and never signs (CONTEXT.md
 * `replica`; ADR-0003). Failover then comes for FREE: the cid sits at
 * `/sites/<name>` with a same-named key on the publisher, which is precisely what
 * the on-box `republish` timer refreshes+exports and replicas `mirror`, so an
 * ipns-mode external pin inherits the same grace-window machinery as a deployed
 * ipns site with no extra wiring.
 *
 * VOCABULARY — `pin` vs `deploy` vs `site add` (CONTEXT.md; kept distinct on
 * purpose, none of the three re-means another):
 *  - **deploy** builds a **CAR** from LOCAL files and `dag/import`s it: the
 *    operator HAS the bytes and mints a new CID.
 *  - **site add** places an ALREADY-LOCAL `/ipfs/<cid>` into MFS: no fetching,
 *    no pinning — pure MFS placement of content the node already holds.
 *  - **pin** (this module) takes a CID the node does NOT hold and makes Kubo
 *    FETCH + pin it, then does that same MFS placement. It is the only one of
 *    the three that depends on the network having a provider for the content.
 *
 * FAN-OUT + PARTIAL FAILURE mirror `deploy` (see `deploy.ts`): `Promise.allSettled`
 * across the targets, a per-node ok/failed breakdown, and a NON-EMPTY success
 * subset is still an overall success ("it is pinned on the rest"). The narrowed
 * single-node case (`--host`) is just a one-element `targets` list — there is no
 * separate code path.
 *
 * MIGRATING FROM AN IPNS NAME (`fromIpns`, the CLI's `--from-ipns <source>`).
 * A pin's source is EXACTLY ONE of two things: a `cid` the operator already has,
 * or a SOURCE IPNS NAME to resolve one from ({@link resolveIpnsSource} ->
 * {@link KuboRpcClient.nameResolve} on the first target that answers). Once
 * resolved, NOTHING downstream differs: the same redundant `pin/add`, the same
 * MFS placement, the same `ipns`-mode publish. That is the one-command ENS
 * migration: `pin --from-ipns <src> --as ronan --mode ipns` resolves the source,
 * pins its current content on every node, and publishes it under the OPERATOR's
 * derived key so they have an `ipns://<their-id>` to point ENS at.
 *
 * Two things the migrate does NOT do, deliberately (CONTEXT.md keeps the SOURCE
 * name and the operator's OWN name distinct):
 *  - it does not hand over the SOURCE's key. The operator gets THEIR OWN name
 *    (master + the `name`/`--as` id) pointing at a SNAPSHOT of the source's
 *    current content. The content stays someone else's; the name is theirs.
 *  - it does not FOLLOW the source. Each call re-resolves, so pulling a newer
 *    snapshot is a MANUAL re-migrate (re-run the same command, which re-publishes
 *    the newer cid under the same stable name). Auto-follow (watching the source
 *    and re-pinning on its every change) is a separate, larger feature that does
 *    not exist here.
 *
 * RETRIEVABILITY (the honest caveat): `pin/add` only succeeds if SOMETHING on
 * the network still serves the content. A node that cannot find it fails with
 * that node's {@link PinStageError} (stage `pin`) carrying Kubo's own message,
 * which is REPORTED per node rather than thrown, so the nodes that could fetch
 * it still count. Kubo's `pin/add` BLOCKS while it fetches, and no timeout is
 * imposed here (a default one would abort legitimately slow large-DAG pins).
 *
 * DECISIONS behind this module's shape are recorded in
 * `work/notes/observations/pin-external-cid-decisions.md` (the pin verb),
 * `work/notes/observations/pin-external-cid-ipns-mode-decisions.md` (the mode
 * branch: why `mode` is reused rather than re-meant, why `role` became optional
 * here, and why the publish call shape moved to a shared home) and
 * `work/notes/observations/pin-from-ipns-migrate-decisions.md` (the `fromIpns`
 * source: why resolution lives in this core rather than the CLI, which node
 * resolves, and what the resolved value may contain).
 */
import {KuboRpcClient, type FetchLike} from '../rpc/kubo-rpc-client.js';
import {placeInMfs} from '../site/site-management.js';
import {lookupIpnsKeyId, publishSiteRecord} from '../publisher/ipns-publish.js';
import {importIpnsKeyIntoPublisher} from '../publisher/key-import.js';
import type {DerivedIpnsKey} from '../derive/ipns-key-derivation.js';
import type {HostRole, SiteMode} from '../config/config-resolution.js';

/** The MFS directory sites live under (matches site-management + deploy). */
const DEFAULT_SITES_DIR = '/sites';

/**
 * One pin target: a node's RPC endpoint + its OWN token and, for `ipns` mode,
 * its `role`.
 *
 * The role is OPTIONAL because it is meaningless in the default `ipfs` mode
 * (nothing is signed, so every node is treated alike); in `ipns` mode it is what
 * decides who signs, and a target with NO role is treated as unable to sign (the
 * safe reading: never put a key on a box whose role the caller did not state).
 * Still deliberately NOT {@link import('../deploy/deploy.js').DeployTarget}: a
 * pin has no CAR and no per-target publish switch (`--mode ipfs` is how an
 * operator pins without publishing).
 */
export interface PinTarget {
	/** The node's Kubo RPC base URL. */
	baseUrl: string;
	/** The node's bearer token (each target has its OWN). */
	token: string;
	/**
	 * publisher (signs in `ipns` mode) or replica (never signs). Omitted =>
	 * cannot sign, which is exactly right for `ipfs`-mode pins.
	 */
	role?: HostRole;
	/** Injectable fetch (tests pass a MockKuboApi); defaults to global fetch. */
	fetchImpl?: FetchLike;
}

/** Inputs to {@link pinExternal}. */
export interface PinExternalInput {
	/** The nodes to pin on (all configured nodes by default; one when narrowed). */
	targets: PinTarget[];
	/**
	 * The external CID to fetch + pin (a bare CID, as `pin/add?arg=` takes).
	 * EXACTLY ONE of `cid` / {@link fromIpns} must be given: the caller either
	 * already has the cid, or names the SOURCE to resolve one from.
	 */
	cid?: string;
	/**
	 * MIGRATE instead: the SOURCE IPNS name to resolve to its CURRENT cid, which
	 * is then pinned by the ordinary flow (`k51...`, `/ipns/<id>` or `ipns://<id>`;
	 * a DNSLink name resolves too). The source is someone else's (or the
	 * operator's old) name; it is NEVER the operator's own name, which in `ipns`
	 * mode is minted from the master + {@link name} as usual. A snapshot, not a
	 * follow: re-calling re-resolves (see the module JSDoc).
	 */
	fromIpns?: string;
	/** The name to track it under: its MFS entry `/sites/<name>` (a site `id`). */
	name: string;
	/** Pin the whole DAG (default true) rather than the root block alone. */
	recursive?: boolean;
	/** The MFS directory sites live under (default `/sites`). */
	sitesDir?: string;
	/**
	 * `ipfs` (default: pin + MFS only, addressed `ipfs://<cid>`) or `ipns` (ALSO
	 * publish the pinned cid under the operator's own derived key on the
	 * publisher, addressed `ipns://<id>`). Same two values as a site's `mode`.
	 */
	mode?: SiteMode;
	/**
	 * The per-site key derived from the operator's master + this pin's `name`
	 * (`deriveIpnsKey`). REQUIRED in `ipns` mode and unused in `ipfs` mode. The
	 * master itself is env-only and never reaches this module — the caller derives
	 * (mirroring `promote`), so the core never touches the environment.
	 */
	derived?: DerivedIpnsKey;
}

/**
 * Which step of a node's pin failed: `pin` = could Kubo fetch the content at
 * all, `place` = the MFS placement, `publish` = the `ipns`-mode key import /
 * `name/publish` on the publisher (the content IS pinned in that case; only the
 * name did not move).
 */
export type PinStage = 'pin' | 'place' | 'publish';

/**
 * A per-node failure that names the STAGE it failed at, so an operator can tell
 * "the network could not give me this content" (`pin`) apart from "the node
 * could not file it under that name" (`place`). Wraps the underlying
 * {@link KuboRpcError} (or other cause) as `cause`.
 */
export class PinStageError extends Error {
	constructor(
		/** The step that failed. */
		readonly stage: PinStage,
		message: string,
		cause?: unknown,
	) {
		super(message, {cause});
		this.name = 'PinStageError';
	}
}

/**
 * The SOURCE IPNS name ({@link PinExternalInput.fromIpns}) could not be resolved
 * on ANY target, so there is no cid to pin: a loud, per-node failure report
 * carrying Kubo's own words (`routing: not found` for a name that was never
 * published or whose record expired) rather than a silent empty pin. Thrown
 * BEFORE anything is pinned, so a failed migrate leaves no half-done state.
 */
export class PinSourceResolveError extends Error {
	constructor(
		/** The source IPNS name that would not resolve. */
		readonly fromIpns: string,
		/** What each target answered when asked to resolve it. */
		readonly failures: Array<{baseUrl: string; error: Error}>,
	) {
		super(
			`could not resolve the source IPNS name ${fromIpns} on ` +
				(failures.length === 0
					? 'any node: there are no pin targets to resolve it on'
					: `any of the ${failures.length} pin target(s): ` +
						`${failures
							.map((f) => `${f.baseUrl} (${f.error.message})`)
							.join('; ')}. Is that name published and still valid (an ` +
						`expired or never-published record does not resolve)?`),
		);
		this.name = 'PinSourceResolveError';
	}
}

/**
 * `--mode ipns` was asked for but no target can SIGN (no `publisher` among
 * them, or the operator narrowed to a replica with `--host`). A loud refusal
 * rather than a silent pin-without-a-name: the operator asked for a name they
 * control, and a keyless replica must never be handed a signing key
 * (CONTEXT.md `replica`; ADR-0003). Mirrors `KeyImportRoleError`'s stance one
 * layer up (in `../publisher/key-import.ts`), before any node is touched.
 */
export class PinPublisherRequiredError extends Error {
	constructor(
		/** The roles of the targets that were offered (undefined = unstated). */
		readonly roles: Array<HostRole | undefined>,
	) {
		super(
			`--mode ipns needs a publisher to sign the name: none of the ` +
				`${roles.length} pin target(s) is a publisher (roles: ` +
				`${roles.map((r) => r ?? 'unset').join(', ')}). A replica is keyless ` +
				`and only re-announces the publisher's signed record; pin with ` +
				`--mode ipfs, or target the publisher.`,
		);
		this.name = 'PinPublisherRequiredError';
	}
}

/** A per-node success record. */
export interface PinNodeOk {
	/** The node's base URL. */
	baseUrl: string;
	/** The CID now pinned on this node. */
	cid: string;
	/** The name it is tracked under (`/sites/<name>`). */
	name: string;
	/** Whether the whole DAG was pinned (vs the root block only). */
	recursive: boolean;
	/** The IPNS id this node published the pin under, if it signed. */
	ipns?: string;
	/** Whether this node signed+published an IPNS record for the pin. */
	published: boolean;
}

/** A per-node failure record. */
export interface PinNodeFailure {
	/** The node's base URL. */
	baseUrl: string;
	/** Which step failed on this node. */
	stage: PinStage;
	/** The error (reported, not thrown — other nodes may still hold the pin). */
	error: Error;
}

/** The overall result: the CID/name, and the per-node breakdown. */
export interface PinExternalResult {
	/**
	 * The external CID that was pinned: the RESOLVED one when migrating from a
	 * {@link fromIpns} source, which is `<cid>/<subpath>` for the unusual source
	 * name that points INTO a directory rather than at a root (see
	 * {@link KuboRpcClient.nameResolve}).
	 */
	cid: string;
	/** The SOURCE IPNS name this pin was migrated from, when it was. */
	fromIpns?: string;
	/** The node that resolved {@link fromIpns} to {@link cid}, when migrating. */
	resolvedBy?: string;
	/** The name it is tracked under on every successful node. */
	name: string;
	/** Whether the whole DAG was pinned. */
	recursive: boolean;
	/** The mode this pin ran in (`ipfs` unless the caller asked for `ipns`). */
	mode: SiteMode;
	/**
	 * The IPNS name the pin is now reachable at (`ipns://<id>`) in `ipns` mode:
	 * the id of the first publisher that signed. Undefined in `ipfs` mode or when
	 * no node published.
	 */
	ipns?: string;
	/** Nodes that fetched + pinned it and placed it in MFS. */
	ok: PinNodeOk[];
	/** Nodes that failed (reported, not thrown), with the stage that failed. */
	failed: PinNodeFailure[];
	/** True when at least one node pinned it (some-nodes-pinned is success). */
	success: boolean;
}

/** The resolved per-pin plan every target is executed against (internal). */
interface PinPlan {
	cid: string;
	name: string;
	recursive: boolean;
	sitesDir: string;
	mode: SiteMode;
	derived?: DerivedIpnsKey;
}

/**
 * Pin an external CID across nodes: on each target, `pin/add` (Kubo fetches the
 * DAG) then place it in MFS at `/sites/<name>`, and in `ipns` mode ALSO import
 * the derived key + `name/publish` on the publisher. Fans out with
 * `Promise.allSettled` so one unreachable/failing node never sinks the others;
 * always RESOLVES with the per-node breakdown (callers inspect `success`).
 *
 * With `fromIpns` instead of `cid`, the source name is resolved FIRST (on the
 * first target that answers) and everything below runs on the resolved cid.
 *
 * @throws unless EXACTLY ONE source (`cid` XOR `fromIpns`) is given, or if
 * `name` is empty: a nameless pin would be untrackable (nothing to place in
 * MFS, so nothing would show on the dashboard).
 * @throws {PinSourceResolveError} when `fromIpns` resolves on no target.
 * @throws {PinPublisherRequiredError} in `ipns` mode when no target can sign.
 * @throws if `ipns` mode is asked for without the `derived` key.
 *
 * The `ipns`-mode preconditions are checked BEFORE any node is touched, so a
 * refusal never leaves a half-done pin behind.
 */
export async function pinExternal(
	input: PinExternalInput,
): Promise<PinExternalResult> {
	const {targets, name} = input;
	if (input.cid && input.fromIpns) {
		throw new Error(
			'pinExternal takes exactly one source: a `cid` to pin, OR `fromIpns` ' +
				'(an IPNS name to resolve a cid from). Both were given',
		);
	}
	if (!input.cid && !input.fromIpns) {
		throw new Error(
			'pinExternal requires exactly one source: a `cid` to pin, or `fromIpns` ' +
				'(an IPNS name to resolve to its current cid)',
		);
	}
	if (!name) throw new Error('pinExternal requires a `name` to track it under');
	const mode: SiteMode = input.mode ?? 'ipfs';
	if (mode === 'ipns') {
		if (!input.derived) {
			throw new Error(
				'pinExternal in `ipns` mode requires the `derived` per-site key ' +
					'(deriveIpnsKey from the env-only master + this pin name)',
			);
		}
		if (!targets.some(canSign)) {
			throw new PinPublisherRequiredError(targets.map((t) => t.role));
		}
	}

	// MIGRATE: turn the SOURCE name into the cid it points at RIGHT NOW. This is
	// the only network call before the fan-out, and it happens AFTER the refusals
	// above so a rejected pin never touches a node.
	const resolved = input.fromIpns
		? await resolveIpnsSource(targets, input.fromIpns)
		: undefined;
	const cid = resolved?.cid ?? (input.cid as string);

	const plan: PinPlan = {
		cid,
		name,
		recursive: input.recursive ?? true,
		sitesDir: input.sitesDir ?? DEFAULT_SITES_DIR,
		mode,
		...(input.derived ? {derived: input.derived} : {}),
	};

	const settled = await Promise.allSettled(
		targets.map((target) => pinOnNode(target, plan)),
	);

	const ok: PinNodeOk[] = [];
	const failed: PinNodeFailure[] = [];
	settled.forEach((outcome, i) => {
		const baseUrl = targets[i].baseUrl;
		if (outcome.status === 'fulfilled') {
			ok.push(outcome.value);
		} else {
			const error = asError(outcome.reason);
			const stage =
				error instanceof PinStageError ? error.stage : ('pin' as PinStage);
			failed.push({baseUrl, stage, error});
		}
	});

	const ipns = ok.find((node) => node.published)?.ipns;
	return {
		cid: plan.cid,
		...(resolved
			? {fromIpns: input.fromIpns as string, resolvedBy: resolved.resolvedBy}
			: {}),
		name,
		recursive: plan.recursive,
		mode,
		...(ipns ? {ipns} : {}),
		ok,
		failed,
		success: ok.length > 0,
	};
}

/**
 * Resolve the SOURCE IPNS name to the cid it currently points at, on the FIRST
 * target that answers ({@link KuboRpcClient.nameResolve}).
 *
 * SEQUENTIALLY, not fanned out: one node's `name/resolve` is one DHT lookup for
 * a single answer every node would give alike, so the later targets are a
 * REACHABILITY fallback (a down/misconfigured first node must not sink a
 * migrate), not a quorum. The resolving node is reported so the operator can see
 * whose view of the name they pinned.
 *
 * @throws {PinSourceResolveError} when NO target could resolve it, carrying each
 * node's own Kubo message.
 */
async function resolveIpnsSource(
	targets: PinTarget[],
	fromIpns: string,
): Promise<{cid: string; resolvedBy: string}> {
	const failures: Array<{baseUrl: string; error: Error}> = [];
	for (const target of targets) {
		try {
			const cid = await clientFor(target).nameResolve(fromIpns);
			return {cid, resolvedBy: target.baseUrl};
		} catch (cause) {
			failures.push({baseUrl: target.baseUrl, error: asError(cause)});
		}
	}
	throw new PinSourceResolveError(fromIpns, failures);
}

/** The per-node client every step of the pin speaks through (one per target). */
function clientFor(target: PinTarget): KuboRpcClient {
	return new KuboRpcClient({
		baseUrl: target.baseUrl,
		token: target.token,
		fetchImpl: target.fetchImpl,
	});
}

/**
 * Whether this target may SIGN the name: a `publisher`. A `replica` (or a target
 * whose role the caller left unstated) never signs.
 */
function canSign(target: PinTarget): boolean {
	return target.role === 'publisher';
}

/**
 * Pin on ONE node: `pin/add` (the fetch), then the MFS placement, then — in
 * `ipns` mode on a publisher only — the publish. Rejects with a stage-tagged
 * {@link PinStageError} so the caller's allSettled records WHICH step failed;
 * the pin comes first because there is no point filing (or naming) content the
 * node does not hold.
 */
async function pinOnNode(target: PinTarget, plan: PinPlan): Promise<PinNodeOk> {
	const {cid, name, recursive, sitesDir} = plan;
	const client = clientFor(target);

	// 1. Fetch + pin. This is the step that needs the content to be RETRIEVABLE.
	try {
		await client.pinAdd(cid, {recursive});
	} catch (cause) {
		throw new PinStageError(
			'pin',
			`pin/add ${cid} failed on ${target.baseUrl}: ${messageOf(cause)} — is the content still retrievable on the network (some provider serving it)?`,
			cause,
		);
	}

	// 2. Track it like a site: /sites/<name> is what warm/republish/status read.
	try {
		await placeInMfs(client, sitesDir, name, cid);
	} catch (cause) {
		throw new PinStageError(
			'place',
			`pinned ${cid} on ${target.baseUrl} but could not place it at ${sitesDir}/${name}: ${messageOf(cause)}`,
			cause,
		);
	}

	// 3. Mode branch (deploy's, not a fork): ipns ADDS the publish, and ONLY on a
	//    publisher. Everything above already happened on EVERY node.
	if (plan.mode === 'ipns' && canSign(target)) {
		try {
			const ipns = await publishPin(client, target.role as HostRole, plan);
			return {
				baseUrl: target.baseUrl,
				cid,
				name,
				recursive,
				ipns,
				published: true,
			};
		} catch (cause) {
			throw new PinStageError(
				'publish',
				`pinned ${cid} on ${target.baseUrl} but could not publish it as ipns ${name}: ${messageOf(cause)}`,
				cause,
			);
		}
	}

	return {baseUrl: target.baseUrl, cid, name, recursive, published: false};
}

/**
 * The `ipns`-mode publish path on ONE publisher, composed from the EXISTING
 * seams (no forked publish logic):
 *   1. {@link lookupIpnsKeyId} (`key/list`) — does this publisher already hold a
 *      key named after the pin?
 *   2. if not, {@link importIpnsKeyIntoPublisher} (`key/import`) — the SAME call
 *      `promote` makes, which itself REFUSES any non-publisher role. The client
 *      supplies key MATERIAL only; it signs nothing (ADR-0003).
 *   3. {@link publishSiteRecord} (`name/publish arg=/ipfs/<cid> key=<name>`) —
 *      the shared call shape deploy and the on-box republish timer use, so the
 *      record's lifetime/ttl cannot drift between them.
 *
 * Step 2 is skipped when the key is already there, which is what makes RE-pinning
 * a newer cid under the same name a plain re-publish: the name is stable, only
 * the cid it points at moves.
 *
 * The reported id prefers what the NODE says the key resolves to (`key/list` /
 * the `key/import` response) and falls back to the locally derived `ipnsId` — the
 * same value by construction (one master + one id = one name), so the operator
 * is never left without the name they can already compute with `derive`.
 */
async function publishPin(
	client: KuboRpcClient,
	role: HostRole,
	plan: PinPlan,
): Promise<string | undefined> {
	const derived = plan.derived as DerivedIpnsKey; // Validated by pinExternal.
	let ipns = await lookupIpnsKeyId(client, plan.name);
	if (!ipns) {
		const imported = await importIpnsKeyIntoPublisher({
			client,
			role,
			keyName: plan.name,
			derived,
		});
		ipns = imported.Id ?? derived.ipnsId;
	}
	await publishSiteRecord({client, id: plan.name, cid: plan.cid});
	return ipns;
}

/** Coerce an unknown rejection reason into an Error. */
function asError(reason: unknown): Error {
	return reason instanceof Error ? reason : new Error(String(reason));
}

/** The message of an unknown thrown value (for wrapping). */
function messageOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
