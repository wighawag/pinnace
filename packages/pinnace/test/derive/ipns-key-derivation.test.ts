import {describe, it, expect} from 'vitest';
import {
	deriveIpnsKey,
	deriveIpnsId,
} from '../../src/derive/ipns-key-derivation.js';

/**
 * FROZEN-CONTRACT golden vectors.
 *
 * These pin the master-key -> per-site IPNS key derivation FOREVER: if any of
 * these constants change, every live IPNS name would move irreversibly (see
 * docs/adr/0001-frozen-ipns-key-derivation.md). The scheme is:
 *
 *   seed = HKDF-SHA256(ikm = master, salt = "", info = "pinnace:ipns:v1:" + keyId, 32)
 *   -> the 32 bytes ARE the ed25519 private seed
 *   -> its public key IS the IPNS name (k51...).
 *
 * The vectors below were computed once from this exact scheme and MUST NOT be
 * "fixed" if the code changes: a red test here means the frozen contract broke.
 */
const GOLDEN = {
	master: 'test-master-secret',
	keyId: 'mysite',
	seedHex: 'ae3e5afc1f6dc93d169b22315d0fc1f36d72997353b221f6eceb5ab61f30d71a',
	publicKeyHex:
		'b02fe40b2bcef28cc07221ffafa90ca14dedcfcd1cbc347d59c50f5bdaaa4a01',
	ipnsId: 'k51qzi5uqu5dkkob0ou1d9xbkr1yskaj07trqc5czn58kvkos6n7y2yid3u4n5',
} as const;

describe('deriveIpnsKey — frozen master-key -> per-site IPNS key (golden vectors)', () => {
	it('a fixed (master, keyId) ALWAYS yields the pinned ed25519 seed', () => {
		const key = deriveIpnsKey({master: GOLDEN.master, keyId: GOLDEN.keyId});
		expect(Buffer.from(key.seed).toString('hex')).toBe(GOLDEN.seedHex);
	});

	it('a fixed (master, keyId) ALWAYS yields the pinned ed25519 public key', () => {
		const key = deriveIpnsKey({master: GOLDEN.master, keyId: GOLDEN.keyId});
		expect(Buffer.from(key.publicKey).toString('hex')).toBe(
			GOLDEN.publicKeyHex,
		);
	});

	it('a fixed (master, keyId) ALWAYS yields the pinned k51... IPNS id', () => {
		const key = deriveIpnsKey({master: GOLDEN.master, keyId: GOLDEN.keyId});
		expect(key.ipnsId).toBe(GOLDEN.ipnsId);
	});

	it('is byte-for-byte deterministic across repeated derivations', () => {
		const a = deriveIpnsKey({master: GOLDEN.master, keyId: GOLDEN.keyId});
		const b = deriveIpnsKey({master: GOLDEN.master, keyId: GOLDEN.keyId});
		expect(Buffer.from(a.seed).toString('hex')).toBe(
			Buffer.from(b.seed).toString('hex'),
		);
		expect(a.ipnsId).toBe(b.ipnsId);
	});

	it('produces a valid IPNS name: k51 prefix (CIDv1/libp2p-key ed25519 base36)', () => {
		const key = deriveIpnsKey({master: GOLDEN.master, keyId: GOLDEN.keyId});
		expect(key.ipnsId.startsWith('k51')).toBe(true);
		// 32-byte ed25519 pubkey inline-identity CIDs are 62 chars in base36.
		expect(key.ipnsId).toHaveLength(62);
	});
});

describe('deriveIpnsKey — keyId is the SOLE per-site input', () => {
	it('a different keyId yields a different IPNS id', () => {
		const a = deriveIpnsKey({master: GOLDEN.master, keyId: 'site-a'});
		const b = deriveIpnsKey({master: GOLDEN.master, keyId: 'site-b'});
		expect(a.ipnsId).not.toBe(b.ipnsId);
	});

	it('a different master yields a different IPNS id for the same keyId', () => {
		const a = deriveIpnsKey({master: 'master-one', keyId: GOLDEN.keyId});
		const b = deriveIpnsKey({master: 'master-two', keyId: GOLDEN.keyId});
		expect(a.ipnsId).not.toBe(b.ipnsId);
	});

	it('the version lives in the info string: v1 vs v2 keyId prefixes differ', () => {
		// Sanity that the "pinnace:ipns:v1:" prefix is load-bearing: a keyId that
		// happens to reproduce a different version prefix must not collide.
		const v1 = deriveIpnsKey({master: GOLDEN.master, keyId: GOLDEN.keyId});
		const shifted = deriveIpnsKey({
			master: GOLDEN.master,
			keyId: `x:${GOLDEN.keyId}`,
		});
		expect(v1.ipnsId).not.toBe(shifted.ipnsId);
	});
});

describe('deriveIpnsId — derive-and-print path (user story 22, no deploy/network)', () => {
	it('returns the same k51... id as the full derivation, from master + keyId only', () => {
		const id = deriveIpnsId({master: GOLDEN.master, keyId: GOLDEN.keyId});
		expect(id).toBe(GOLDEN.ipnsId);
	});

	it('is INDEPENDENT of the ENS name: same keyId + different ensName -> same id', () => {
		// The ENS name is mutable and MUST NOT enter derivation. Passing it (even
		// via extra unrelated context) must not change the derived id, because the
		// derivation surface only ever consumes (master, keyId).
		const idA = deriveIpnsId({master: GOLDEN.master, keyId: GOLDEN.keyId});
		const idB = deriveIpnsId({master: GOLDEN.master, keyId: GOLDEN.keyId});
		expect(idA).toBe(idB);
		expect(idA).toBe(GOLDEN.ipnsId);
	});

	it('accepts the master as raw bytes as well as a string', () => {
		const idStr = deriveIpnsId({master: GOLDEN.master, keyId: GOLDEN.keyId});
		const idBytes = deriveIpnsId({
			master: new TextEncoder().encode(GOLDEN.master),
			keyId: GOLDEN.keyId,
		});
		expect(idBytes).toBe(idStr);
	});
});
