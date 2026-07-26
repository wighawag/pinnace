/**
 * Host-agnostic **deploy** — build one CAR and land the SAME CID on every node.
 *
 * This is the core operation user stories 4, 6, 7 describe: build a site's
 * **CAR** ONCE (via the `car-build` seam), then fan out across every configured
 * **node** (each with its OWN bearer token) so all nodes serve the IDENTICAL
 * **CID** with no single point of failure. Per node the flow is: import + pin
 * the CAR (`dag/import?pin-roots=true`), then place it in the MFS wrapper
 * `/sites/<id>/` (its `content` + `metadata.json`) so `gateway warming`, IPNS
 * republish, and `status` auto-discover it. Deploy speaks ONLY the Kubo RPC seam
 * ({@link KuboRpcClient}); it is not host-specific.
 *
 * Behaviour ported (not copied) from the reference prototype
 * `~/searches/ipfs-hetzner/deploy-car.mjs`: the multi-target fan-out, the MFS
 * placement, the per-`mode` branch, and the `Promise.allSettled` partial-failure
 * semantics (a non-empty subset of nodes succeeding is still an overall success:
 * "the site is up on the rest").
 *
 * PER-SITE `mode` RESOLUTION (the site's durable mode home is its MFS metadata,
 * not a config file): `--set-mode` > the mode STORED on the publisher > `ipfs`.
 * Omitting the flag PRESERVES, so a re-deploy of a published site keeps signing
 * its name; the resolved value is then written to EVERY node (see
 * {@link resolveFanOutMode}).
 *
 * PER-SITE `mode` BRANCH (CONTEXT.md `mode`; spec's "Per-site mode branch"):
 *  - `ipfs` mode: land + pin + MFS ONLY (no key, no publish). ENS uses
 *    `ipfs://<cid>`, updated per deploy.
 *  - `ipns` mode: everything above PLUS the publish path (`key/list` then
 *    `name/publish`) and ONLY on a PUBLISHER target. A `replica` (or a target
 *    with {@link DeployTarget.publish} disabled) NEVER signs — it re-announces
 *    the publisher's record via the on-box `mirror` verb instead. This mirrors
 *    the prototype's `doPublish = mode === "ipns" && PUBLISH_IPNS` gate, with
 *    role standing in for the prototype's `PUBLISH_IPNS=0` replica flag.
 *
 * `ipns` MODE EITHER PRODUCES THE NAME OR REFUSES — never anything in between
 * (the ONE policy `pin --set-mode ipns` already has; the two verbs differ in
 * what they PLACE, never in whether they honour a stated mode). On a target
 * that would publish:
 *  - the publisher ALREADY holds the site's key -> publish. This path needs NO
 *    key material (and so no master): it is the CI path.
 *  - it holds none and the caller supplied the DERIVED key -> IMPORT it
 *    ({@link importIpnsKeyIntoPublisher}, the same seam `pin`/`authorize` use)
 *    and then publish. The key is DERIVED, never invented: no `key/gen`.
 *  - it holds none and no derived key was supplied -> REFUSE
 *    ({@link DeployDerivedKeyRequiredError}).
 *  - nothing in the fan-out can sign at all -> REFUSE
 *    ({@link DeployPublisherRequiredError}).
 * Both refusals are PRE-FLIGHT — they precede the CAR import, the pin, the MFS
 * placement and the metadata write on EVERY node — so a deploy that cannot
 * honour its mode changes nothing anywhere (a half-deployed fan-out whose name
 * never moved is the worst outcome available). They are refusals of the WHOLE
 * run, so they are thrown, never folded into the per-node `allSettled`.
 *
 * SEAM BOUNDARY (see the sibling tasks): this module wires the per-mode call
 * SEQUENCE only. The full publisher/replica record export+mirror lives in
 * `publisher-replica-model`, the `key/list` + `name/publish` call shape lives in
 * `../publisher/ipns-publish.ts` (shared with `pin --set-mode ipns` and the on-box
 * republish timer), and serializing+importing the derived key into the
 * publisher's keystore lives in `key-import-publisher` — which REFUSES any
 * non-publisher role, so auto-import can never hand a replica a key. Deploy
 * composes those seams; it forks none of them, and it never signs anything
 * itself (the client supplies key MATERIAL, the NODE signs: ADR-0003).
 *
 * DECISIONS behind the `ipns`-mode policy above (why the keystore is probed
 * up-front, why an unprobeable node is still only that node's failure, why a
 * publish-disabled fan-out now refuses, and why the CLI arm deliberately does
 * NOT refuse a missing master the way `pin`'s does) are recorded in
 * `work/notes/observations/deploy-auto-imports-site-key-in-ipns-mode-decisions.md`.
 */
import {KuboRpcClient, type FetchLike} from '../rpc/kubo-rpc-client.js';
import {buildCar, type BuiltCar} from '../car/car-build.js';
import {placeInMfs} from '../site/site-management.js';
import {
	assertEnsNameIntent,
	resolveSiteMetadataToWrite,
	siteModeIntent,
	DEFAULT_SITE_MODE,
	PRESERVE_ENS_NAME,
	type EnsNameIntent,
	type ResolvedSiteMetadata,
} from '../site/site-wrapper.js';
import {lookupIpnsKeyId, publishSiteRecord} from '../publisher/ipns-publish.js';
import {importIpnsKeyIntoPublisher} from '../publisher/key-import.js';
import type {DerivedIpnsKey} from '../derive/ipns-key-derivation.js';
import type {HostRole, SiteMode} from '../config/config-resolution.js';

/** The MFS directory sites live under (matches site-management). */
const DEFAULT_SITES_DIR = '/sites';

/**
 * One deploy target: a node's RPC endpoint + its OWN token + its role. In
 * `ipns` mode only a `publisher` (with publish not disabled) signs the record;
 * a `replica` lands+pins+MFS but never publishes.
 */
export interface DeployTarget {
	/** The node's Kubo RPC base URL. */
	baseUrl: string;
	/** The node's bearer token (each target has its OWN). */
	token: string;
	/** publisher (may sign in ipns mode) or replica (never signs). */
	role: HostRole;
	/**
	 * Explicit publish switch. Defaults to true for a publisher. Set false to
	 * land+pin+MFS on a publisher WITHOUT signing (the prototype's
	 * `PUBLISH_IPNS=0`). A `replica` never publishes regardless of this flag.
	 */
	publish?: boolean;
	/** Injectable fetch (tests pass a MockKuboApi); defaults to global fetch. */
	fetchImpl?: FetchLike;
}

/** Inputs to {@link deploy}. Supply EITHER a `sourceDir` OR a prebuilt `car`. */
export interface DeployInput {
	/** The site source directory to build a CAR from (mutually exclusive with `car`). */
	sourceDir?: string;
	/** A prebuilt CAR to deploy as-is (mutually exclusive with `sourceDir`). */
	car?: BuiltCar;
	/** The site's single `id`: its MFS entry `/sites/<id>` and, in ipns mode, its key name. */
	id: string;
	/**
	 * The mode this deploy STATES (`--set-mode`): ipfs (land+pin+MFS) or ipns
	 * (also key/list + name/publish on publishers).
	 *
	 * OMITTED = PRESERVE, exactly as omitting the ensName flags does: the deploy
	 * runs in the mode the site is ALREADY stored under on the publisher, and
	 * only a site that stores none falls back to {@link DEFAULT_SITE_MODE}. So a
	 * plain re-deploy of a published site still signs its record instead of
	 * silently demoting it (see {@link DeployResult.mode} for what it resolved to).
	 */
	mode?: SiteMode;
	/**
	 * What this deploy says about the site's `ensName` in the wrapper metadata
	 * ({@link EnsNameIntent}). Omitted = PRESERVE: the deploy leaves whatever the
	 * site already carries (absent on a first deploy, unchanged on a re-deploy),
	 * so a deploy never silently wipes — or invents — an eth.limo name.
	 */
	ensName?: EnsNameIntent;
	/** The nodes to deploy to (each with its own token); the CAR lands on all. */
	targets: DeployTarget[];
	/** The MFS directory sites live under (default `/sites`). */
	sitesDir?: string;
	/**
	 * The per-site key derived from the operator's master + this deploy's `id`
	 * (`deriveIpnsKey`), used ONLY to provision a publisher that does not already
	 * hold it. Unused in `ipfs` mode, and unused in `ipns` mode when every signing
	 * target already holds the key (the CI path, which needs no master at all).
	 * The master itself is env-only and never reaches this module — the caller
	 * derives (mirroring `pin`/`authorize`), so the core never touches the
	 * environment. Its ABSENCE where it IS needed is a loud refusal
	 * ({@link DeployDerivedKeyRequiredError}), never a silent unsigned deploy.
	 */
	derived?: DerivedIpnsKey;
}

/** A per-target success record. */
export interface DeployNodeOk {
	/** The node's base URL. */
	baseUrl: string;
	/** The CID landed on this node (identical across all successful nodes). */
	cid: string;
	/** The IPNS id published on this node, if it signed; undefined otherwise. */
	ipns?: string;
	/** Whether this node signed+published an IPNS record. */
	published: boolean;
}

/** A per-target failure record. */
export interface DeployNodeFailure {
	/** The node's base URL. */
	baseUrl: string;
	/** The error that failed this node's deploy (its content is up elsewhere). */
	error: Error;
}

/**
 * The deploy RESOLVED to `ipns` mode — stated (`--set-mode ipns`) or preserved
 * from what the site already stores — but NOTHING in the fan-out can sign it:
 * no `publisher` among the targets, or every publisher has
 * {@link DeployTarget.publish} disabled. A loud refusal rather than a deploy
 * that lands content under a name nobody moved; a keyless replica must never be
 * handed a signing key (CONTEXT.md `replica`; ADR-0003). Mirrors
 * `PinPublisherRequiredError`, and is thrown before any node is touched.
 */
export class DeployPublisherRequiredError extends Error {
	constructor(
		/** The site id this deploy would have signed. */
		readonly siteId: string,
		/** Whether the ipns mode was STATED (vs preserved from the stored one). */
		readonly stated: boolean,
		/** The targets that were offered, as roles + publish switches. */
		readonly targets: Array<{role: HostRole; publish?: boolean}>,
	) {
		super(
			(stated
				? `--set-mode ipns needs a publisher to sign '${siteId}'`
				: `'${siteId}' is already stored in \`ipns\` mode, so this deploy must ` +
					`refresh its name, but that needs a publisher to sign it`) +
				`: none of the ${targets.length} deploy target(s) can (` +
				`${targets
					.map((t) =>
						t.publish === false ? `${t.role} (publish off)` : t.role,
					)
					.join(', ')}). A replica is keyless and only re-announces the ` +
				`publisher's signed record; deploy with --set-mode ipfs, or include the ` +
				`publisher in the fan-out.`,
		);
		this.name = 'DeployPublisherRequiredError';
	}
}

/**
 * The deploy RESOLVED to `ipns` mode — stated, or preserved from what the site
 * already stores — but a target that must sign holds NO key for the site and
 * the caller supplied no {@link DeployInput.derived} key material to import, so
 * the name could not be produced. A loud refusal BEFORE anything is written to
 * any node (the master is env-only and lives one layer up, in the CLI), never a
 * quiet exit 0 that lands the content and leaves the name on the OLD cid.
 *
 * Mirrors `PinDerivedKeyRequiredError`, including its STATED/PRESERVED
 * distinction, and names all three remedies: supply the key (export
 * `PINNACE_MASTER`), authorize the node once (`pinnace authorize`), or stop
 * asking for a name (`--set-mode ipfs`).
 */
export class DeployDerivedKeyRequiredError extends Error {
	constructor(
		/** The site id (its MFS entry, its key name AND the KDF input). */
		readonly siteId: string,
		/** Whether the ipns mode was STATED (vs preserved from the stored one). */
		readonly stated: boolean,
		/** The signing target that holds no key for the site. */
		readonly baseUrl: string,
	) {
		super(
			`deploying '${siteId}' in \`ipns\` mode needs the per-site key, but ` +
				`${baseUrl} holds no key named '${siteId}' and no \`derived\` key ` +
				`material was given (deriveIpnsKey from the env-only master + the site ` +
				`id). ` +
				(stated
					? ''
					: `That mode is what '${siteId}' is already stored under — it is ` +
						`published under this name and this deploy must refresh it, or the ` +
						`name keeps pointing at the OLD cid. `) +
				`Export PINNACE_MASTER so this deploy can import the key, or run ` +
				`\`pinnace authorize ${siteId}\` once from a machine that has the ` +
				`master, or deploy with --set-mode ipfs to stop publishing it.`,
		);
		this.name = 'DeployDerivedKeyRequiredError';
	}
}

/** The overall deploy result: the CID, and per-node success/failure. */
export interface DeployResult {
	/** The authoritative site CID (identical on every node). */
	cid: string;
	/** The site's mode. */
	mode: SiteMode;
	/** Nodes the deploy landed on (import + MFS, plus publish where applicable). */
	ok: DeployNodeOk[];
	/** Nodes whose deploy failed (reported, not thrown — the rest are up). */
	failed: DeployNodeFailure[];
	/** True when at least one node succeeded (some-nodes-up is still success). */
	success: boolean;
}

/**
 * Deploy a site: RESOLVE the mode, build the CAR ONCE, then import the SAME CAR
 * into every target (each with its own token), pin it, place it in MFS, and (in
 * `ipns` mode, on publisher targets) publish the IPNS record. Fans out with
 * `Promise.allSettled`: a node that fails is reported in {@link DeployResult.failed}
 * and does not sink the others; a non-empty success subset is still an overall
 * success ({@link DeployResult.success}). Throws only if NO node succeeds is
 * NOT the contract here — deploy always RESOLVES with the per-node breakdown;
 * callers inspect `success`.
 *
 * @throws if neither `sourceDir` nor `car` is supplied, or both are.
 * @throws {EnsNameInferenceError} for a bare `--set-ens-name` (the `infer`
 * intent) on a non-`.eth` id — checked BEFORE the CAR is built or any node is
 * touched, so a refusal leaves nothing half-done.
 * @throws {SiteMetadataUnreadableError} when the PUBLISHER cannot say what the
 * site stores and the mode/ensName are being PRESERVED: the whole deploy is
 * refused before the CAR is built, because resolving the fan-out's ONE mode
 * from an unreadable node would write a demotion to every node. A node that
 * fails the SAME read later in the fan-out is a per-node failure like any other
 * ({@link DeployResult.failed}), and that node is left untouched.
 * @throws {DeployPublisherRequiredError} in a resolved `ipns` mode when no
 * target can sign — before any node is written to.
 * @throws {DeployDerivedKeyRequiredError} in a resolved `ipns` mode when a
 * signing target holds no key for the site and no `derived` key was supplied to
 * import — before any node is written to.
 */
export async function deploy(input: DeployInput): Promise<DeployResult> {
	const {sourceDir, car, id, targets} = input;
	if ((sourceDir === undefined) === (car === undefined)) {
		throw new Error('deploy requires exactly one of `sourceDir` or `car`');
	}
	const ensName = input.ensName ?? PRESERVE_ENS_NAME;
	assertEnsNameIntent(ensName, id);
	const sitesDir = input.sitesDir ?? DEFAULT_SITES_DIR;

	// The ONE mode this whole fan-out runs in (see resolveFanOutMode): a stated
	// mode, else the PUBLISHER's stored one, else the conservative default.
	const resolved = await resolveFanOutMode(input, sitesDir, ensName);
	const mode = resolved.mode;

	// Can this deploy actually produce the name it was asked for? Answered (and
	// refused) BEFORE the CAR is built or a single byte is written anywhere.
	const stated = input.mode !== undefined;
	const keystores = await assertCanSign(input, mode, stated);

	// Build the CAR ONCE — the same bytes (and thus the same CID) land on every
	// node (redundancy, no single point of failure).
	const built: BuiltCar = car ?? (await buildCar(sourceDir as string));

	const plan: DeployPlan = {
		built,
		id,
		mode,
		sitesDir,
		ensName,
		stated,
		...(input.derived ? {derived: input.derived} : {}),
	};
	// Fan out. allSettled so one node's failure never sinks the others.
	const settled = await Promise.allSettled(
		targets.map((target, i) =>
			deployToNode(
				target,
				plan,
				i === resolved.resolvedFrom ? resolved.metadata : undefined,
				keystores[i],
			),
		),
	);

	const ok: DeployNodeOk[] = [];
	const failed: DeployNodeFailure[] = [];
	settled.forEach((outcome, i) => {
		const baseUrl = targets[i].baseUrl;
		if (outcome.status === 'fulfilled') {
			ok.push(outcome.value);
		} else {
			failed.push({baseUrl, error: asError(outcome.reason)});
		}
	});

	return {
		cid: built.rootCid,
		mode,
		ok,
		failed,
		success: ok.length > 0,
	};
}

/** The resolved per-deploy plan every target is executed against (internal). */
interface DeployPlan {
	built: BuiltCar;
	id: string;
	/** The RESOLVED mode the WHOLE fan-out runs in (never the raw input). */
	mode: SiteMode;
	sitesDir: string;
	ensName: EnsNameIntent;
	/** Whether the mode was STATED (only ever used to word a refusal). */
	stated: boolean;
	/** The derived key to import into a publisher that holds none (if given). */
	derived?: DerivedIpnsKey;
}

/**
 * What the PRE-FLIGHT `key/list` learned about ONE signing target's keystore:
 * it already `held` the site's key (with the IPNS id it resolves to), it
 * answered and holds none (`absent`, so the key must be imported), or it did
 * not answer at all (`unreachable`).
 *
 * `unreachable` is deliberately NOT a refusal: a node that is down must never
 * sink the whole fan-out (the partial-failure contract). That node simply fails
 * on its own, loudly, in its own arm of the `allSettled` — where the same
 * key-absent refusal is repeated as its per-node failure, so an unprobed node
 * still cannot land content and silently skip the signing.
 */
type KeystoreProbe =
	{kind: 'held'; ipns: string} | {kind: 'absent'} | {kind: 'unreachable'};

/**
 * Resolve the ONE mode this deploy runs in, from the PUBLISHER target — the
 * node that holds the key and actually signs.
 *
 * Metadata is stored PER NODE, but "does this deploy sign IPNS?" is a SINGLE
 * decision for the whole fan-out, so it cannot be taken per node: it is taken
 * once, here, and then STATED to every target (so no two nodes can disagree
 * about how the site is addressed). A stated `mode` needs no node at all; only
 * the `preserve` intent reads, and that read doubles as the publisher's own
 * ensName read-modify-write (returned as `metadata`, so the publisher is not
 * read twice). With NO publisher among the targets there is nothing to resolve
 * from — and nothing that could sign — so the default applies.
 */
async function resolveFanOutMode(
	input: DeployInput,
	sitesDir: string,
	ensName: EnsNameIntent,
): Promise<{
	mode: SiteMode;
	/** Index of the target the mode was resolved from, or -1. */
	resolvedFrom: number;
	/** That target's fully-resolved metadata (reused for its own write). */
	metadata?: ResolvedSiteMetadata;
}> {
	const intent = siteModeIntent(input.mode);
	if (intent.kind === 'set') return {mode: intent.mode, resolvedFrom: -1};
	const resolvedFrom = input.targets.findIndex(
		(target) => target.role === 'publisher',
	);
	if (resolvedFrom < 0) return {mode: DEFAULT_SITE_MODE, resolvedFrom};
	const metadata = await resolveSiteMetadataToWrite({
		client: clientFor(input.targets[resolvedFrom]),
		sitesDir,
		id: input.id,
		mode: intent,
		ensName,
	});
	return {mode: metadata.mode, resolvedFrom, metadata};
}

/**
 * The PRE-FLIGHT gate of `ipns` mode: can this deploy actually produce the name
 * it was asked for? Answered before the CAR is built and before ANY node is
 * written to, so a deploy that cannot honour its mode changes nothing anywhere.
 *
 * Two refusals, in the order they can be answered:
 *  1. nothing in the fan-out can sign ({@link DeployPublisherRequiredError}) —
 *     no node needed to know that.
 *  2. a signing target holds no key for the site and no derived key was given
 *     to import ({@link DeployDerivedKeyRequiredError}). ONE keyless signer
 *     refuses the WHOLE run: it would otherwise land the content and leave that
 *     node's name on the old cid, which is the very failure this gate exists for.
 *
 * The `key/list` this asks is a READ (it mutates nothing), and it doubles as
 * the publish path's own lookup — the result is threaded into the fan-out
 * ({@link publish}), so a signing target is asked about its keystore ONCE, not
 * twice. In `ipfs` mode nothing here runs at all: no keystore probe, no key
 * material, no refusal.
 *
 * @returns per-target probes, aligned to `input.targets` (undefined for every
 * target that does not sign: a replica is never even asked).
 */
async function assertCanSign(
	input: DeployInput,
	mode: SiteMode,
	stated: boolean,
): Promise<Array<KeystoreProbe | undefined>> {
	const {targets, id} = input;
	const none: Array<KeystoreProbe | undefined> = targets.map(() => undefined);
	if (mode !== 'ipns') return none;
	if (!targets.some(shouldPublish)) {
		throw new DeployPublisherRequiredError(
			id,
			stated,
			targets.map((t) => ({role: t.role, publish: t.publish})),
		);
	}

	const probes = [...none];
	await Promise.all(
		targets.map(async (target, i) => {
			if (!shouldPublish(target)) return;
			try {
				const ipns = await lookupIpnsKeyId(clientFor(target), id);
				probes[i] = ipns ? {kind: 'held', ipns} : {kind: 'absent'};
			} catch {
				// This node's own problem, not the run's (see KeystoreProbe).
				probes[i] = {kind: 'unreachable'};
			}
		}),
	);

	if (!input.derived) {
		const keyless = probes.findIndex((probe) => probe?.kind === 'absent');
		if (keyless >= 0) {
			throw new DeployDerivedKeyRequiredError(
				id,
				stated,
				targets[keyless].baseUrl,
			);
		}
	}
	return probes;
}

/** The per-node client every step of the deploy speaks through. */
function clientFor(target: DeployTarget): KuboRpcClient {
	return new KuboRpcClient({
		baseUrl: target.baseUrl,
		token: target.token,
		fetchImpl: target.fetchImpl,
	});
}

/**
 * Deploy the (already-built) CAR to ONE node: import + pin, place in MFS, then
 * (in ipns mode on a publishing publisher) key/list + name/publish. Rejects on
 * any RPC failure so the caller's allSettled records it as a per-node failure.
 *
 * `metadata` is this node's ALREADY-resolved metadata when the fan-out's mode
 * was read from it (the publisher); every other node resolves its own here.
 */
async function deployToNode(
	target: DeployTarget,
	plan: DeployPlan,
	metadata?: ResolvedSiteMetadata,
	probe?: KeystoreProbe,
): Promise<DeployNodeOk> {
	const {built, id, mode, sitesDir, ensName} = plan;
	const client = clientFor(target);

	// 1. Import + pin the CAR (same CID as every other node).
	await client.dagImport(built.carBytes);

	// 2. Place it in the MFS wrapper /sites/<id>/ (content + metadata.json).
	//    Reuses the single implementation of that sequence (site-management).
	//    The metadata records the RESOLVED mode (the same one on every node) plus
	//    the `ensName` state the operator asked for — resolved against THIS node's
	//    existing metadata when the intent is `preserve` (the read-modify-write
	//    that makes omitting the flags leave an existing name alone).
	const resolved =
		metadata ??
		(await resolveSiteMetadataToWrite({
			client,
			sitesDir,
			id,
			mode: {kind: 'set', mode},
			ensName,
		}));
	await placeInMfs(client, sitesDir, id, built.rootCid, resolved);

	// 3. Mode branch: ipns mode ADDS publish, and ONLY on a publishing publisher.
	//    It follows the RESOLVED mode, so a preserved `ipns` site is still signed.
	if (mode === 'ipns' && shouldPublish(target)) {
		const ipns = await publish(client, target, plan, probe);
		return {baseUrl: target.baseUrl, cid: built.rootCid, ipns, published: true};
	}

	return {baseUrl: target.baseUrl, cid: built.rootCid, published: false};
}

/**
 * Whether this target signs the IPNS record: a `publisher` whose publish switch
 * is not explicitly disabled. A `replica` NEVER publishes (it re-announces the
 * publisher's signed record via the on-box `mirror` verb instead).
 */
function shouldPublish(target: DeployTarget): boolean {
	return target.role === 'publisher' && target.publish !== false;
}

/**
 * The publish path on ONE signing publisher (ipns mode), composed from the
 * EXISTING seams — exactly as `pin --set-mode ipns` composes them, because the
 * two verbs share ONE policy:
 *  1. the site key's IPNS id, from the PRE-FLIGHT probe ({@link assertCanSign})
 *     when that node answered, else `key/list` here (the probe could not reach
 *     it, so this is where its failure surfaces as its own per-node failure).
 *  2. no key there yet -> {@link importIpnsKeyIntoPublisher} (`key/import`), the
 *     same call `pin`/`authorize` make, which itself REFUSES a non-publisher role
 *     so auto-import can never hand a replica a key. The key is DERIVED, never
 *     invented: nothing here ever issues `key/gen`. The client supplies key
 *     MATERIAL only; the NODE signs (ADR-0003).
 *  3. {@link publishSiteRecord} (`name/publish arg=/ipfs/<cid> key=<id>`) — the
 *     shared call shape deploy, pin and the on-box republish timer use, so the
 *     record's lifetime/ttl cannot drift between them.
 *
 * The keystore key name is the site's single `id` (the same value key-import
 * imports under — one identifier, so the lookup cannot miss by a name/keyId
 * split). Step 2 is skipped when the key is already there, which is what keeps
 * the CI path master-free: a re-deploy of a provisioned site is a plain
 * re-publish.
 *
 * @throws {DeployDerivedKeyRequiredError} when this node holds no key and no
 * derived key was supplied — the same refusal the pre-flight gate makes, for
 * the one node it could not probe. A deploy NEVER lands content on a publisher
 * and quietly leaves its name behind.
 */
async function publish(
	client: KuboRpcClient,
	target: DeployTarget,
	plan: DeployPlan,
	probe?: KeystoreProbe,
): Promise<string> {
	const {id, derived} = plan;
	const cid = plan.built.rootCid;
	let ipns =
		probe?.kind === 'held'
			? probe.ipns
			: probe?.kind === 'absent'
				? undefined
				: await lookupIpnsKeyId(client, id);
	if (!ipns) {
		if (!derived) {
			throw new DeployDerivedKeyRequiredError(id, plan.stated, target.baseUrl);
		}
		const imported = await importIpnsKeyIntoPublisher({
			client,
			role: target.role,
			keyName: id,
			derived,
		});
		// Prefer what the NODE says the key resolves to; fall back to the locally
		// derived id (the same value by construction: one master + one id = one name).
		ipns = imported.Id ?? derived.ipnsId;
	}
	await publishSiteRecord({client, id, cid});
	return ipns;
}

/** Coerce an unknown rejection reason into an Error. */
function asError(reason: unknown): Error {
	return reason instanceof Error ? reason : new Error(String(reason));
}
