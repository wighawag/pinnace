/**
 * **pin** — take custody of an EXTERNAL network CID: content the operator has
 * only the CID for (not the files), pinned REDUNDANTLY across every configured
 * node and placed in MFS so it is tracked exactly like a site. This turns the
 * operator's boxes into a self-hosted pinning service for other people's
 * content, not only for their own deploys (spec user stories 4, 15).
 *
 * Per node the flow is: `pin/add?arg=<cid>&recursive=true` (Kubo RESOLVES and
 * FETCHES the DAG over the network, then pins it), then {@link placeInMfs} at
 * `/sites/<name>` so `gateway warming`, IPNS republish-discovery and `status`
 * auto-discover it (it shows on the dashboard). It speaks ONLY the Kubo RPC seam
 * ({@link KuboRpcClient}), so it is host-agnostic and testable against the
 * recording mock (no live daemon).
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
 * RETRIEVABILITY (the honest caveat): `pin/add` only succeeds if SOMETHING on
 * the network still serves the content. A node that cannot find it fails with
 * that node's {@link PinStageError} (stage `pin`) carrying Kubo's own message,
 * which is REPORTED per node rather than thrown, so the nodes that could fetch
 * it still count. Kubo's `pin/add` BLOCKS while it fetches, and no timeout is
 * imposed here (a default one would abort legitimately slow large-DAG pins);
 * see the decisions note linked from the done record.
 */
import {KuboRpcClient, type FetchLike} from '../rpc/kubo-rpc-client.js';
import {placeInMfs} from '../site/site-management.js';

/** The MFS directory sites live under (matches site-management + deploy). */
const DEFAULT_SITES_DIR = '/sites';

/**
 * One pin target: a node's RPC endpoint + its OWN token. Deliberately NOT
 * {@link import('../deploy/deploy.js').DeployTarget}: pinning is role-agnostic
 * (no publisher/replica branch, nothing is signed), so requiring a `role` here
 * would be meaningless ceremony.
 */
export interface PinTarget {
	/** The node's Kubo RPC base URL. */
	baseUrl: string;
	/** The node's bearer token (each target has its OWN). */
	token: string;
	/** Injectable fetch (tests pass a MockKuboApi); defaults to global fetch. */
	fetchImpl?: FetchLike;
}

/** Inputs to {@link pinExternal}. */
export interface PinExternalInput {
	/** The nodes to pin on (all configured nodes by default; one when narrowed). */
	targets: PinTarget[];
	/** The external CID to fetch + pin (a bare CID, as `pin/add?arg=` takes). */
	cid: string;
	/** The name to track it under: its MFS entry `/sites/<name>` (a site `id`). */
	name: string;
	/** Pin the whole DAG (default true) rather than the root block alone. */
	recursive?: boolean;
	/** The MFS directory sites live under (default `/sites`). */
	sitesDir?: string;
}

/** Which step of a node's pin failed (pin = could Kubo fetch it at all). */
export type PinStage = 'pin' | 'place';

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
	/** The external CID that was pinned. */
	cid: string;
	/** The name it is tracked under on every successful node. */
	name: string;
	/** Whether the whole DAG was pinned. */
	recursive: boolean;
	/** Nodes that fetched + pinned it and placed it in MFS. */
	ok: PinNodeOk[];
	/** Nodes that failed (reported, not thrown), with the stage that failed. */
	failed: PinNodeFailure[];
	/** True when at least one node pinned it (some-nodes-pinned is success). */
	success: boolean;
}

/**
 * Pin an external CID across nodes: on each target, `pin/add` (Kubo fetches the
 * DAG) then place it in MFS at `/sites/<name>`. Fans out with
 * `Promise.allSettled` so one unreachable/failing node never sinks the others;
 * always RESOLVES with the per-node breakdown (callers inspect `success`).
 *
 * @throws if `cid` or `name` is empty — a nameless pin would be untrackable
 * (nothing to place in MFS, so nothing would show on the dashboard).
 */
export async function pinExternal(
	input: PinExternalInput,
): Promise<PinExternalResult> {
	const {targets, cid, name} = input;
	if (!cid) throw new Error('pinExternal requires a `cid` to pin');
	if (!name) throw new Error('pinExternal requires a `name` to track it under');
	const recursive = input.recursive ?? true;
	const sitesDir = input.sitesDir ?? DEFAULT_SITES_DIR;

	const settled = await Promise.allSettled(
		targets.map((target) => pinOnNode(target, cid, name, recursive, sitesDir)),
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

	return {cid, name, recursive, ok, failed, success: ok.length > 0};
}

/**
 * Pin on ONE node: `pin/add` (the fetch), then the MFS placement. Rejects with a
 * stage-tagged {@link PinStageError} so the caller's allSettled records WHICH
 * step failed; the pin comes first because there is no point filing content the
 * node does not hold.
 */
async function pinOnNode(
	target: PinTarget,
	cid: string,
	name: string,
	recursive: boolean,
	sitesDir: string,
): Promise<PinNodeOk> {
	const client = new KuboRpcClient({
		baseUrl: target.baseUrl,
		token: target.token,
		fetchImpl: target.fetchImpl,
	});

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

	return {baseUrl: target.baseUrl, cid, name, recursive};
}

/** Coerce an unknown rejection reason into an Error. */
function asError(reason: unknown): Error {
	return reason instanceof Error ? reason : new Error(String(reason));
}

/** The message of an unknown thrown value (for wrapping). */
function messageOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
