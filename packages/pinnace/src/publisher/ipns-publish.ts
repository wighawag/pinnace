/**
 * The ONE home of the **IPNS publish call sequence**: resolve a site key's IPNS
 * id from the node's keystore (`key/list`), then have the NODE sign+refresh the
 * record for `/ipfs/<cid>` (`name/publish`) with the frozen validity values.
 *
 * WHY IT IS ITS OWN MODULE. Three callers need the identical two RPCs and must
 * not drift (ADR-0002's one-implementation rule):
 *  - `deploy` in `ipns` mode (publisher targets only) — `../deploy/deploy.ts`,
 *  - `pin --set-mode ipns` (the same publisher-only branch) — `../pin/pin-external.ts`,
 *  - the on-box `republish` timer, which refreshes every keyed MFS site —
 *    `./record-sequence.ts`.
 * Before this module the `name/publish` parameter set (lifetime / ttl /
 * allow-offline) existed twice with its own copy of the constants; a third copy
 * for `pin` would have been a fork. Callers COMPOSE these two functions with
 * their own policy (deploy SKIPS an unkeyed publisher; `pin` IMPORTS the derived
 * key first; the on-box timer lists keys once for all sites) — the policy is
 * theirs, the call shape is here.
 *
 * NOT here: key PROVISIONING (`./key-import.ts`) and the publisher/replica role
 * gate (each caller's own mode branch). This module signs nothing itself: the
 * only signing primitive in pinnace is the NODE's `name/publish`, which is what
 * {@link publishSiteRecord} asks the node to do (ADR-0003, no client-side record
 * signing).
 */
import type {KuboRpcClient} from '../rpc/kubo-rpc-client.js';

/**
 * Records are ~72h valid, refreshed with a ~1h ttl (the reference values). The
 * on-box republish timer fires well within 72h so a record never lapses.
 * Exported so tests pin the exact validity contract and no caller re-magic-
 * numbers it. (Re-exported by `./record-sequence.ts`, its historical home, so
 * the public API is unchanged.)
 */
export const RECORD_LIFETIME = '72h';
export const RECORD_TTL = '1h';

/** The `key/list -l` rows, as far as any caller reads them. */
interface KeyListResponse {
	Keys?: Array<{Name?: string; Id?: string}> | null;
}

/**
 * `key/list` on this node and return the IPNS id of the key named `keyName`, or
 * undefined when the node holds no such key. The keystore key name IS the site's
 * single `id` (CONTEXT.md `id`), so this lookup cannot miss by a name/keyId
 * split. Callers decide what an absent key MEANS (deploy and pin both import the
 * derived key, and REFUSE when they have none; the on-box timer reports
 * `no-key`).
 */
export async function lookupIpnsKeyId(
	client: KuboRpcClient,
	keyName: string,
): Promise<string | undefined> {
	const keys = await client.keyList<KeyListResponse>();
	return (keys.Keys ?? []).find((k) => k?.Name === keyName)?.Id;
}

/** Inputs to {@link publishSiteRecord}. */
export interface PublishSiteRecordInput {
	/** The Kubo client of the PUBLISHER node (the only node that ever signs). */
	client: KuboRpcClient;
	/** The site's single `id` — also the keystore key name to sign with. */
	id: string;
	/** The CID the name should point at (published as `/ipfs/<cid>`). */
	cid: string;
}

/**
 * Ask the NODE to sign+publish `/ipfs/<cid>` under the key named `id`, with the
 * frozen {@link RECORD_LIFETIME}/{@link RECORD_TTL} and `allow-offline=true` (so
 * a freshly-booted node with no peers yet still writes the record locally).
 *
 * The caller MUST have established that this node is the publisher and holds the
 * key — a replica never signs (CONTEXT.md `replica`; ADR-0003).
 */
export async function publishSiteRecord(
	input: PublishSiteRecordInput,
): Promise<void> {
	await input.client.namePublish({
		cidPath: `/ipfs/${input.cid}`,
		key: input.id,
		lifetime: RECORD_LIFETIME,
		ttl: RECORD_TTL,
		allowOffline: true,
	});
}
