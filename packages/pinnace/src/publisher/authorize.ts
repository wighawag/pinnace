/**
 * **authorize** — grant the declared PUBLISHER the key MATERIAL it needs to
 * sign a site's IPNS name, once, from the operator's machine.
 *
 * WHAT IT IS FOR (its primary job): the master-free CI bootstrap. The operator
 * runs it ONCE locally, where `PINNACE_MASTER` lives, so the publisher's
 * keystore holds the per-site key; from then on CI deploys that name FOREVER
 * with no master anywhere near the pipeline. `deploy` auto-imports the key too
 * (`../deploy/deploy.ts`), but only when it has the master — which bootstraps
 * nothing for a project that only ever deploys from CI. Hence this verb.
 *
 * WHAT IT IS NOT. It does NOT flip, set or persist any ROLE, and it performs no
 * FAILOVER. A node's role lives in two places this module cannot reach:
 * `pinnace.json` `hosts[].role` (the client's declaration, hand-edited) and
 * `NODE_ROLE` in the box's cloud-init env file (what the box's own timers
 * self-gate on). Neither is writable over Kubo RPC, so promoting a replica in
 * any real sense is a REPROVISION of that box, not a client-side call.
 * (Its predecessor `promoteReplicaToPublisher` returned a hard-coded
 * `role: 'publisher'` while persisting nothing; that fiction is deleted.)
 *
 * THE INVARIANT IT SERVES (ADR-0003): the client supplies key MATERIAL, the
 * NODE signs. The only RPCs this module issues are `key/list` (a read, the
 * idempotence probe + the second-signer check), MFS discovery reads, and
 * `key/import` through the existing {@link importIpnsKeyIntoPublisher} seam —
 * which REFUSES a `replica` and is not weakened here. Nothing signs, nothing
 * re-announces, and no key is ever GENERATED on a box (`key/gen` is never
 * issued: the key is derived from the master, so it is recoverable).
 *
 * IDEMPOTENT BY CONSTRUCTION: the publisher's keystore is probed FIRST, and a
 * key already held is a clean `already-authorized` no-op — not an error and not
 * a re-import. Re-running the bare form over a whole fleet of sites is
 * therefore safe and costs one `key/list`.
 *
 * TWO SITE FORMS. Given `ids`, exactly those sites are authorized and MFS is
 * not consulted at all (so a key can be pre-authorized BEFORE the site's first
 * deploy — the CI-bootstrap case). Given none, the publisher's sites are
 * DISCOVERED from MFS `/sites/*` ({@link discoverSites}, the same walk the
 * on-box loop uses) and each is authorized. Discovery deliberately does NOT
 * filter on the site's stored `mode`: authorize grants the material, and
 * whether a name is actually signed remains `mode`'s business on the box (a
 * stored-`ipfs` site is never signed even where a key exists — CONTEXT.md
 * `mode`), so an `ipfs` site holding an unused key is inert, while SKIPPING it
 * would make `authorize` silently partial the moment an operator flips a mode.
 *
 * DECISIONS (the seam shape, the unchecked-host policy, the CLI's refusals) are
 * recorded in `work/notes/observations/authorize-replaces-promote-decisions.md`.
 */
import type {KuboRpcClient} from '../rpc/kubo-rpc-client.js';
import type {HostRole} from '../config/config-resolution.js';
import type {DerivedIpnsKey} from '../derive/ipns-key-derivation.js';
import {discoverSites} from '../node/node-commands.js';
import {importIpnsKeyIntoPublisher} from './key-import.js';

/** One configured node this verb can speak to, named as the config names it. */
export interface AuthorizeHost {
	/** The configured host name — what a refusal names, so it is actionable. */
	name: string;
	/** That node's Kubo RPC client (per-node, bearer-guarded). */
	client: KuboRpcClient;
}

/** The node being authorized: the host the config DECLARES the publisher. */
export interface AuthorizePublisherTarget extends AuthorizeHost {
	/**
	 * The role the CONFIG declares for this host, passed straight to the import
	 * seam — which REFUSES anything but `publisher` ({@link KeyImportRoleError}).
	 * It is READ (unlike the deleted `currentRole` it replaces): a caller that
	 * hands over a declared replica is refused rather than quietly obeyed.
	 */
	role: HostRole;
}

/** Inputs to {@link authorizePublisher}. */
export interface AuthorizeInput {
	/** The declared publisher whose keystore gains the key(s). */
	publisher: AuthorizePublisherTarget;
	/**
	 * Every OTHER configured host, for the second-signer guard: each is asked
	 * (`key/list`) whether it already holds a key for a site about to be
	 * imported. Omitted/empty simply skips that guard — which is exactly the
	 * `--endpoint` case, where the config declares one node and the fleet is
	 * invisible.
	 */
	others?: AuthorizeHost[];
	/**
	 * The site ids to authorize. OMITTED = discover the publisher's sites from
	 * MFS `/sites/*` (the bare form). A named id needs no MFS entry.
	 */
	ids?: string[];
	/**
	 * Derive one site's key material from the operator's master. A FUNCTION, not
	 * a value, because the bare form does not know the ids until it has walked
	 * MFS — and because the master is env-only and must never reach the core
	 * (the caller closes over it, exactly as `deploy`/`pin` pass a pre-derived
	 * key). Called ONLY for a site that is actually being imported.
	 */
	deriveKey: (id: string) => DerivedIpnsKey;
	/** The MFS directory sites live under (default `/sites`). */
	sitesDir?: string;
}

/** What happened for one site: the key was imported now, or was already there. */
export type AuthorizeStatus = 'authorized' | 'already-authorized';

/** One site's outcome — key MATERIAL only; no role, because none changed. */
export interface AuthorizedSite {
	/** The site's single `id`: its MFS home, the keystore key name, the KDF input. */
	id: string;
	/** The IPNS id that key resolves to (from `key/list`, or the import response). */
	ipns?: string;
	/** `authorized` (imported by this run) or `already-authorized` (a no-op). */
	status: AuthorizeStatus;
}

/** The outcome of an {@link authorizePublisher} run. */
export interface AuthorizeResult {
	/** The configured host name that was authorized. */
	publisher: string;
	/** Per-site outcomes, in the order the sites were authorized. */
	sites: AuthorizedSite[];
	/**
	 * Other configured hosts the second-signer guard could NOT ask (unreachable,
	 * or answering an error). Reported rather than fatal — see the
	 * decisions note — so the caller can say which boxes were not covered.
	 */
	unchecked: string[];
}

/**
 * A key for this site already sits on ANOTHER configured host, so importing it
 * onto the publisher would create a SECOND signer for one IPNS name.
 *
 * Two nodes signing one name race its **sequence numbers**: each signs from its
 * own last-seen sequence, so the network keeps the highest-numbered record and
 * the name FLAPS between their two cids, with no error anywhere. Exactly one
 * publisher per name is the model (CONTEXT.md `publisher`, `replica`), so this
 * is a loud refusal of the whole run, raised BEFORE any `key/import`.
 */
export class AuthorizeSecondSignerError extends Error {
	constructor(
		/** The site whose key would have been duplicated. */
		readonly siteId: string,
		/** The configured host that ALREADY holds a key for it. */
		readonly holder: string,
		/** The host this run was asked to authorize. */
		readonly publisher: string,
	) {
		super(
			`refusing to authorize '${siteId}' on '${publisher}': '${holder}' ` +
				`already holds a key named '${siteId}'. Exactly one node per IPNS ` +
				`name may sign it — two signers race the record's sequence numbers, ` +
				`so the name flaps between their cids with no error anywhere. Remove ` +
				`that key from '${holder}' (or declare '${holder}' the publisher in ` +
				`pinnace.json) before authorizing '${publisher}'.`,
		);
		this.name = 'AuthorizeSecondSignerError';
	}
}

/**
 * Authorize the declared publisher to sign one site (`ids: [id]`) or every site
 * it holds in MFS (`ids` omitted): probe its keystore, refuse the two hazards,
 * and import ONLY the keys that are genuinely absent.
 *
 * The sequence, and why it is in this order:
 *  1. resolve the site ids (named, or discovered from MFS);
 *  2. `key/list` the publisher ONCE — the idempotence probe. Every site whose
 *     key is already there is `already-authorized` and is never re-imported;
 *  3. if (and only if) something still needs importing, ask each OTHER
 *     configured host whether it holds that key, and REFUSE the whole run on the
 *     first conflict ({@link AuthorizeSecondSignerError}) — pre-flight, so a
 *     refused run has imported nothing anywhere. A host that cannot answer is
 *     reported in {@link AuthorizeResult.unchecked}, not treated as a conflict;
 *  4. import the absent keys via {@link importIpnsKeyIntoPublisher}, which
 *     refuses a declared `replica` (ADR-0003) before touching the node.
 *
 * @throws {AuthorizeSecondSignerError} when another configured host already
 * holds a key for a site this run would import.
 * @throws {KeyImportRoleError} when the target's declared role is not
 * `publisher` — and only where an import is actually needed, since a run that
 * imports nothing touches no keystore at all.
 */
export async function authorizePublisher(
	input: AuthorizeInput,
): Promise<AuthorizeResult> {
	const {publisher} = input;
	const ids =
		input.ids ??
		(await discoverSites(publisher.client, input.sitesDir ?? '/sites')).map(
			(site) => site.id,
		);

	// The idempotence probe: what this publisher ALREADY holds (one read).
	const held = await listKeys(publisher.client);
	const needing = ids.filter((id) => !held.has(id));

	// The second-signer guard, asked only when something is actually going to be
	// imported (a pure no-op run introduces no second signer to guard against).
	const unchecked: string[] = [];
	if (needing.length > 0) {
		for (const other of input.others ?? []) {
			let theirs: Map<string, string>;
			try {
				theirs = await listKeys(other.client);
			} catch {
				// Could not ask this box. Reported, never read as "holds nothing".
				unchecked.push(other.name);
				continue;
			}
			const conflict = needing.find((id) => theirs.has(id));
			if (conflict !== undefined) {
				throw new AuthorizeSecondSignerError(
					conflict,
					other.name,
					publisher.name,
				);
			}
		}
	}

	const sites: AuthorizedSite[] = [];
	for (const id of ids) {
		const ipns = held.get(id);
		if (ipns !== undefined) {
			sites.push({id, ipns, status: 'already-authorized'});
			continue;
		}
		const derived = input.deriveKey(id);
		// The one write this verb makes. The seam refuses a non-publisher role.
		const imported = await importIpnsKeyIntoPublisher({
			client: publisher.client,
			role: publisher.role,
			keyName: id,
			derived,
		});
		// Prefer what the NODE says the key resolves to; fall back to the locally
		// derived id (the same value by construction: one master + one id = one name).
		sites.push({id, ipns: imported.Id ?? derived.ipnsId, status: 'authorized'});
	}

	return {publisher: publisher.name, sites, unchecked};
}

/** Map keystore key name -> IPNS id from `key/list -l`. */
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
