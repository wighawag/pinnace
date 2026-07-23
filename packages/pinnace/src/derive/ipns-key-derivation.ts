/**
 * Master-key -> per-site IPNS key derivation. **THIS IS A FROZEN CONTRACT.**
 *
 * Every `ipns`-mode site's key is derived deterministically from one operator
 * master secret, so names are recoverable from the master alone and
 * provisioning is stateless (CONTEXT.md `master key`, `keyId`). The scheme,
 * pinned FOREVER by docs/adr/0001-frozen-ipns-key-derivation.md:
 *
 *   seed = HKDF-SHA256(ikm = master, salt = "", info = "pinnace:ipns:v1:" + keyId, length = 32)
 *   -> the 32 bytes ARE the ed25519 private seed
 *   -> its public key IS the IPNS name, rendered as a CIDv1 `k51...` id.
 *
 * Frozen invariants (changing ANY of these moves every live name irreversibly):
 *   - the KDF is HKDF-SHA256;
 *   - the `info` prefix is exactly `pinnace:ipns:v1:` (the version `v1` lives in
 *     the `info` string, NOT in a separate parameter — a v2 scheme would use a
 *     new prefix and never re-derive existing names);
 *   - `keyId` is the SOLE per-site input, appended verbatim (UTF-8) to the info
 *     prefix. The ENS name is mutable and MUST NEVER enter derivation, so this
 *     surface has no `ensName` parameter at all;
 *   - the HKDF `salt` is the RFC 5869 default (empty / zero-length). The spec
 *     pins only ikm/info/length; an empty salt is the standard "no salt" case
 *     and is pinned here so the contract is total (see ADR-0001);
 *   - the 32 HKDF output bytes are used directly as the ed25519 seed (RFC 8032
 *     private key), NOT hashed or expanded again.
 *
 * Key IMPORT into a node keystore and the "no client signing" boundary are a
 * SEPARATE concern (the `key-import-publisher` task): this module derives the
 * key + id only, with no node, network, or deploy.
 */
import {createPrivateKey, createPublicKey, hkdfSync} from 'node:crypto';

/** The frozen `info`-string prefix. The version (`v1`) is encoded HERE. */
export const IPNS_INFO_PREFIX = 'pinnace:ipns:v1:';

/** The master secret: a UTF-8 string or raw bytes. Never read from a node/file. */
export type Master = string | Uint8Array;

/** Inputs to the derivation: the master secret and the frozen per-site keyId. */
export interface DeriveIpnsInput {
	/** The operator master secret (env-only in production; see config module). */
	master: Master;
	/**
	 * The site's frozen, internal key identity — the SOLE per-site KDF input.
	 * NOT the ENS name (which is mutable and never enters derivation).
	 */
	keyId: string;
}

/** A fully derived per-site IPNS key. */
export interface DerivedIpnsKey {
	/** The 32-byte ed25519 private seed (the raw HKDF output). */
	readonly seed: Uint8Array;
	/** The 32-byte raw ed25519 public key. */
	readonly publicKey: Uint8Array;
	/** The IPNS name: a CIDv1 (libp2p-key, base36) `k51...` id. */
	readonly ipnsId: string;
}

/** PKCS#8 DER prefix wrapping a raw 32-byte ed25519 seed (RFC 8410). */
const ED25519_PKCS8_PREFIX = Buffer.from(
	'302e020100300506032b657004220420',
	'hex',
);

/** base36 lowercase alphabet (multibase `k`), per the multiformats spec. */
const BASE36_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function toBytes(master: Master): Uint8Array {
	return typeof master === 'string' ? new TextEncoder().encode(master) : master;
}

/**
 * HKDF-SHA256(master, salt = "", info = IPNS_INFO_PREFIX + keyId, 32).
 * Returns the 32-byte ed25519 seed. Frozen — see the module doc.
 */
function deriveSeed(master: Master, keyId: string): Uint8Array {
	const info = new TextEncoder().encode(IPNS_INFO_PREFIX + keyId);
	const seed = hkdfSync(
		'sha256',
		toBytes(master),
		new Uint8Array(0), // RFC 5869 default (empty) salt — pinned by ADR-0001.
		info,
		32,
	);
	return new Uint8Array(seed);
}

/** Derive the raw 32-byte ed25519 public key from a 32-byte private seed. */
function ed25519PublicKeyFromSeed(seed: Uint8Array): Uint8Array {
	const pkcs8 = Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seed)]);
	const priv = createPrivateKey({key: pkcs8, format: 'der', type: 'pkcs8'});
	const spki = createPublicKey(priv).export({format: 'der', type: 'spki'});
	// An ed25519 SPKI DER is a fixed 12-byte header + the 32 raw public bytes.
	return new Uint8Array(spki.subarray(spki.length - 32));
}

/** Encode bytes as multibase-less base36 (lowercase), preserving leading zeros. */
function base36Encode(bytes: Uint8Array): string {
	const digits = [0];
	for (const byte of bytes) {
		let carry = byte;
		for (let i = 0; i < digits.length; i++) {
			const value = digits[i] * 256 + carry;
			digits[i] = value % 36;
			carry = (value / 36) | 0;
		}
		while (carry > 0) {
			digits.push(carry % 36);
			carry = (carry / 36) | 0;
		}
	}
	let out = '';
	for (let i = 0; i < bytes.length && bytes[i] === 0; i++) out += '0';
	for (let i = digits.length - 1; i >= 0; i--)
		out += BASE36_ALPHABET[digits[i]];
	return out;
}

/**
 * Encode a raw 32-byte ed25519 public key as an IPNS name (`k51...`).
 *
 * The name is a CIDv1 with the libp2p-key multicodec, whose multihash inlines
 * the libp2p PublicKey protobuf via the identity hash (the default for
 * ed25519), rendered in case-insensitive base36 with the `k` multibase prefix:
 *
 *   0x01 (CIDv1) 0x72 (libp2p-key)
 *   0x00 (identity mh) 0x24 (len 36)
 *   0x08 0x01 (protobuf field1 Type = Ed25519) 0x12 0x20 (field2 Data, len 32)
 *   <32 raw public key bytes>
 *
 * @see https://specs.ipfs.tech/ipns/ipns-record/
 */
function ipnsIdFromPublicKey(publicKey: Uint8Array): string {
	const pbHeader = Uint8Array.from([0x08, 0x01, 0x12, 0x20]);
	const protobuf = new Uint8Array(pbHeader.length + publicKey.length);
	protobuf.set(pbHeader, 0);
	protobuf.set(publicKey, pbHeader.length);

	const multihash = new Uint8Array(2 + protobuf.length);
	multihash[0] = 0x00; // identity multihash function
	multihash[1] = protobuf.length; // digest length (36)
	multihash.set(protobuf, 2);

	const cid = new Uint8Array(2 + multihash.length);
	cid[0] = 0x01; // CIDv1
	cid[1] = 0x72; // libp2p-key multicodec
	cid.set(multihash, 2);

	return 'k' + base36Encode(cid); // multibase base36 (lowercase) prefix.
}

/**
 * Derive the full per-site IPNS key (seed + public key + `k51...` id) from the
 * master secret and the frozen `keyId`. Pure and deterministic — no node,
 * network, or deploy. This is the FROZEN CONTRACT; see the module doc.
 */
export function deriveIpnsKey(input: DeriveIpnsInput): DerivedIpnsKey {
	const seed = deriveSeed(input.master, input.keyId);
	const publicKey = ed25519PublicKeyFromSeed(seed);
	const ipnsId = ipnsIdFromPublicKey(publicKey);
	return {seed, publicKey, ipnsId};
}

/**
 * Derive-and-print path (user story 22): return a site's `k51...` IPNS id from
 * the master + keyId with NO deploy and NO network, so an operator can set the
 * ENS contenthash to `ipns://<id>` before the first deploy. The id depends ONLY
 * on (master, keyId) — never the ENS name.
 */
export function deriveIpnsId(input: DeriveIpnsInput): string {
	return deriveIpnsKey(input).ipnsId;
}
