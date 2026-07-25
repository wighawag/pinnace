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
 * SEAM BOUNDARY (see the sibling tasks): this module wires the per-mode call
 * SEQUENCE only. The full publisher/replica record export+mirror lives in
 * `publisher-replica-model`, the `key/list` + `name/publish` call shape lives in
 * `../publisher/ipns-publish.ts` (shared with `pin --mode ipns` and the on-box
 * republish timer), and importing the derived key into the publisher's keystore
 * lives in `key-import-publisher`. So deploy here does NOT `key/gen` or
 * `key/import` — it assumes the publisher already holds the key (looked up via
 * `key/list`) and issues `name/publish`. If a publisher has no matching key yet,
 * the publish is reported as skipped rather than silently generating one (key
 * provisioning is that other task's job, not deploy's).
 */
import {KuboRpcClient, type FetchLike} from '../rpc/kubo-rpc-client.js';
import {buildCar, type BuiltCar} from '../car/car-build.js';
import {placeInMfs} from '../site/site-management.js';
import {lookupIpnsKeyId, publishSiteRecord} from '../publisher/ipns-publish.js';
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
	/** ipfs (land+pin+MFS) or ipns (also key/list + name/publish on publishers). */
	mode: SiteMode;
	/** The nodes to deploy to (each with its own token); the CAR lands on all. */
	targets: DeployTarget[];
	/** The MFS directory sites live under (default `/sites`). */
	sitesDir?: string;
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
 * Deploy a site: build the CAR ONCE, then import the SAME CAR into every target
 * (each with its own token), pin it, place it in MFS, and (in `ipns` mode, on
 * publisher targets) publish the IPNS record. Fans out with
 * `Promise.allSettled`: a node that fails is reported in {@link DeployResult.failed}
 * and does not sink the others; a non-empty success subset is still an overall
 * success ({@link DeployResult.success}). Throws only if NO node succeeds is
 * NOT the contract here — deploy always RESOLVES with the per-node breakdown;
 * callers inspect `success`.
 *
 * @throws if neither `sourceDir` nor `car` is supplied, or both are.
 */
export async function deploy(input: DeployInput): Promise<DeployResult> {
	const {sourceDir, car, id, mode, targets} = input;
	if ((sourceDir === undefined) === (car === undefined)) {
		throw new Error('deploy requires exactly one of `sourceDir` or `car`');
	}
	const sitesDir = input.sitesDir ?? DEFAULT_SITES_DIR;

	// Build the CAR ONCE — the same bytes (and thus the same CID) land on every
	// node (redundancy, no single point of failure).
	const built: BuiltCar = car ?? (await buildCar(sourceDir as string));

	// Fan out. allSettled so one node's failure never sinks the others.
	const settled = await Promise.allSettled(
		targets.map((target) => deployToNode(target, built, id, mode, sitesDir)),
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

/**
 * Deploy the (already-built) CAR to ONE node: import + pin, place in MFS, then
 * (in ipns mode on a publishing publisher) key/list + name/publish. Rejects on
 * any RPC failure so the caller's allSettled records it as a per-node failure.
 */
async function deployToNode(
	target: DeployTarget,
	built: BuiltCar,
	id: string,
	mode: SiteMode,
	sitesDir: string,
): Promise<DeployNodeOk> {
	const client = new KuboRpcClient({
		baseUrl: target.baseUrl,
		token: target.token,
		fetchImpl: target.fetchImpl,
	});

	// 1. Import + pin the CAR (same CID as every other node).
	await client.dagImport(built.carBytes);

	// 2. Place it in the MFS wrapper /sites/<id>/ (content + metadata.json).
	//    Reuses the single implementation of that sequence (site-management).
	//    The metadata records the `mode` this deploy ran in; the `ensName` lever
	//    (and preserving a prior one) is the `deploy-pin-write-site-metadata`
	//    task's job, not this placement's.
	await placeInMfs(client, sitesDir, id, built.rootCid, {mode});

	// 3. Mode branch: ipns mode ADDS publish, and ONLY on a publishing publisher.
	if (mode === 'ipns' && shouldPublish(target)) {
		const ipns = await publish(client, id, built.rootCid);
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
 * The publish path (ipns mode, publisher only): `key/list` to resolve the site
 * key's IPNS id, then `name/publish` to sign+refresh the record for
 * `/ipfs/<cid>` — both through the shared `ipns-publish` seam, so deploy, `pin
 * --mode ipns` and the on-box republish timer issue the IDENTICAL calls. The
 * keystore key name is the site's single `id` (the same value key-import imports
 * under — one identifier, so the lookup cannot miss by a name/keyId split).
 *
 * Does NOT `key/gen`/`key/import`: the key is provisioned by the sibling
 * `key-import-publisher` task; here we assume it exists. If it does not yet, we
 * skip the publish (returning undefined) rather than silently generating a key
 * deploy has no business owning. (`pin --mode ipns` composes the same two calls
 * with the OPPOSITE policy: it imports the derived key first, because the
 * operator just asked for that name.)
 */
async function publish(
	client: KuboRpcClient,
	id: string,
	cid: string,
): Promise<string | undefined> {
	const ipns = await lookupIpnsKeyId(client, id);
	if (!ipns) {
		// The publisher has no key for this site yet (key-import-publisher owns
		// provisioning it). Land the content but do not sign.
		return undefined;
	}
	await publishSiteRecord({client, id, cid});
	return ipns;
}

/** Coerce an unknown rejection reason into an Error. */
function asError(reason: unknown): Error {
	return reason instanceof Error ? reason : new Error(String(reason));
}
