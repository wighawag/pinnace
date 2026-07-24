/**
 * Import a derived per-site IPNS key into the **publisher** node's keystore.
 *
 * This module wires the frozen master-key -> per-site key derivation (see
 * `../derive/ipns-key-derivation.ts`, {@link DerivedIpnsKey}) into a running
 * publisher node: it serializes the ed25519 keypair into the libp2p-protobuf
 * form Kubo's `ipfs key import` (`key/import`) expects, then POSTs those bytes
 * to the publisher's keystore via the {@link KuboRpcClient} seam. The client
 * only ever supplies key MATERIAL.
 *
 * THE LOAD-BEARING INVARIANT (docs/adr/0003-*): deriving a key client-side is
 * NOT client-side record SIGNING. A future reader will look at client-side key
 * derivation + import and reasonably wonder "isn't this the fully-keyless C-1
 * client-signing model the spec excludes?" — it is NOT. This module hands the
 * node key MATERIAL; the NODE then signs the IPNS record and owns sequence
 * numbers / validity via `name/publish` (owned by the on-box `republish` verb,
 * `../node/node-commands.ts`). No signing primitive runs here; the only RPC
 * this module issues is `key/import`. Spec Out of Scope excludes the C-1
 * fully-keyless client-signing model; ADR-0003 records that invariant durably.
 *
 * PUBLISHER-ONLY (CONTEXT.md `publisher`, `replica`): exactly one node per
 * shared IPNS name holds the key; replicas are KEYLESS and only re-announce the
 * publisher's signed record. So this module REFUSES to import onto a `replica`
 * ({@link KeyImportRoleError}) rather than silently proceeding — a wrong-role
 * import is a caller error, not a no-op, because it would put a signing key on a
 * box that must never hold one. (Design note: this refusal is a new, loud ERROR
 * gated on the existing `HostRole` concept; it does not invent a role. See the
 * done record's Decisions block.)
 *
 * SCOPE: ONLY key import into the publisher. Deriving the key is the
 * `ipns-key-derivation` task; the publish/refresh timers and the record
 * export/mirror are the `publisher-replica-model` task. This module does
 * neither — it lands the key and stops.
 */
import type {DerivedIpnsKey} from '../derive/ipns-key-derivation.js';
import type {HostRole} from '../config/config-resolution.js';
import type {KuboRpcClient} from '../rpc/kubo-rpc-client.js';

/**
 * The frozen libp2p-protobuf `PrivateKey` prefix for an ed25519 key with a
 * 64-byte `Data`:
 *
 *   0x08 0x01  — field 1 (Type), varint, KeyType Ed25519 = 1
 *   0x12 0x40  — field 2 (Data), length-delimited, length = 64
 *
 * followed by the 64-byte ed25519 raw key (32-byte seed || 32-byte public key,
 * the Go `ed25519.PrivateKey` layout libp2p `Raw()` emits). This is the
 * `libp2p-protobuf-cleartext` format `ipfs key import` defaults to.
 *
 * @see https://github.com/libp2p/go-libp2p/blob/master/core/crypto/pb/crypto.proto
 * @see https://github.com/libp2p/go-libp2p/blob/master/core/crypto/ed25519.go
 */
export const LIBP2P_ED25519_PRIVATE_KEY_PREFIX = Uint8Array.from([
	0x08, 0x01, 0x12, 0x40,
]);

/**
 * Serialize a {@link DerivedIpnsKey} into the libp2p-protobuf-cleartext
 * `PrivateKey` bytes `ipfs key import` expects.
 *
 * The libp2p ed25519 private key `Data` is the 64-byte concatenation of the
 * 32-byte private seed and the 32-byte public key (so the public key need not
 * be recomputed on load); we wrap it in the `PrivateKey { Type=Ed25519, Data }`
 * protobuf via {@link LIBP2P_ED25519_PRIVATE_KEY_PREFIX}. Pure and offline: no
 * node, network, or signing — this only reshapes bytes we already derived.
 */
export function serializeIpnsKeyForImport(derived: DerivedIpnsKey): Uint8Array {
	if (derived.seed.length !== 32) {
		throw new Error(
			`expected a 32-byte ed25519 seed, got ${derived.seed.length}`,
		);
	}
	if (derived.publicKey.length !== 32) {
		throw new Error(
			`expected a 32-byte ed25519 public key, got ${derived.publicKey.length}`,
		);
	}
	const prefix = LIBP2P_ED25519_PRIVATE_KEY_PREFIX;
	const out = new Uint8Array(prefix.length + 64);
	out.set(prefix, 0);
	out.set(derived.seed, prefix.length); // Data[0..32): the private seed.
	out.set(derived.publicKey, prefix.length + 32); // Data[32..64): the pubkey.
	return out;
}

/** A loud refusal to import a key onto a non-publisher node (a replica). */
export class KeyImportRoleError extends Error {
	constructor(
		/** The role the caller passed (must be `publisher` to import). */
		readonly role: HostRole,
		/** The key name the import was attempted under. */
		readonly keyName: string,
	) {
		super(
			`refusing key/import '${keyName}' onto a ${role}: only the publisher ` +
				`holds the IPNS key; replicas are keyless and re-announce the ` +
				`publisher's signed record`,
		);
		this.name = 'KeyImportRoleError';
	}
}

/** Inputs to {@link importIpnsKeyIntoPublisher}. */
export interface ImportIpnsKeyInput {
	/** The Kubo RPC client for the PUBLISHER node (per-node, bearer-guarded). */
	client: KuboRpcClient;
	/** The target node's role; MUST be `publisher` or the import is refused. */
	role: HostRole;
	/** The keystore key name to import under (the site name / `key/list` Name). */
	keyName: string;
	/** The derived per-site key (seed + public key) from `ipns-key-derivation`. */
	derived: DerivedIpnsKey;
}

/**
 * The Kubo `key/import` JSON response (`Name` + IPNS `Id`), as far as we read.
 */
export interface KeyImportResult {
	Name?: string;
	Id?: string;
}

/**
 * Serialize the derived key and import it into the PUBLISHER node's keystore
 * via Kubo `key/import`. REFUSES ({@link KeyImportRoleError}) on any non-
 * publisher role, touching the node not at all, so a replica stays keyless.
 *
 * The client supplies key MATERIAL only. The node signs IPNS records itself via
 * `name/publish` (a separate concern the on-box `republish` verb owns); nothing
 * here signs, and the only RPC issued is `key/import`. See the module doc +
 * ADR-0003 for the "no client-side record signing" invariant.
 */
export async function importIpnsKeyIntoPublisher(
	input: ImportIpnsKeyInput,
): Promise<KeyImportResult> {
	if (input.role !== 'publisher') {
		throw new KeyImportRoleError(input.role, input.keyName);
	}
	const keyBytes = serializeIpnsKeyForImport(input.derived);
	return await input.client.keyImport<KeyImportResult>(input.keyName, keyBytes);
}
