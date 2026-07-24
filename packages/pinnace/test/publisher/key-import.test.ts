import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {KuboRpcClient} from '../../src/rpc/kubo-rpc-client.js';
import {MockKuboApi} from '../../src/rpc/mock-kubo.js';
import {deriveIpnsKey} from '../../src/derive/ipns-key-derivation.js';
import {
	serializeIpnsKeyForImport,
	importIpnsKeyIntoPublisher,
	KeyImportRoleError,
	LIBP2P_ED25519_PRIVATE_KEY_PREFIX,
} from '../../src/publisher/key-import.js';

/**
 * These tests ISOLATE the import at the mock Kubo RPC seam:
 *  - the Kubo daemon is the recording MockKuboApi (no live daemon, no shared
 *    or global keystore is touched),
 *  - the derived key is the golden-vector key from ipns-key-derivation.
 * They pin BOTH halves of the task: (1) the derived key is serialized to the
 * libp2p-protobuf import form and lands via `key/import` on the PUBLISHER only,
 * and (2) NO record-signing primitive is invoked client-side — the client only
 * supplies key MATERIAL; the node's `name/publish` does the signing.
 */

/** The golden-vector key (from the frozen derivation) so serialization is pinned. */
const GOLDEN = {
	master: 'test-master-secret',
	keyId: 'mysite',
	seedHex: 'ae3e5afc1f6dc93d169b22315d0fc1f36d72997353b221f6eceb5ab61f30d71a',
	publicKeyHex:
		'b02fe40b2bcef28cc07221ffafa90ca14dedcfcd1cbc347d59c50f5bdaaa4a01',
} as const;

function goldenKey() {
	return deriveIpnsKey({master: GOLDEN.master, keyId: GOLDEN.keyId});
}

function clientWith(mock: MockKuboApi, token = 'publisher-token') {
	return new KuboRpcClient({
		baseUrl: mock.baseUrl,
		token,
		fetchImpl: mock.fetchImpl,
	});
}

describe('serializeIpnsKeyForImport — libp2p-protobuf-cleartext PrivateKey bytes', () => {
	it('wraps the ed25519 raw key (seed||pubkey) in the PrivateKey protobuf', () => {
		const bytes = serializeIpnsKeyForImport(goldenKey());
		// PrivateKey { Type=Ed25519(1) field1 varint; Data field2 len-delim } =
		//   0x08 0x01 0x12 0x40 <64 bytes: seed(32) || pubkey(32)>
		const prefix = Buffer.from(bytes.subarray(0, 4)).toString('hex');
		expect(prefix).toBe('08011240');
		expect(bytes.length).toBe(4 + 64);
	});

	it('the Data is exactly the 32-byte seed followed by the 32-byte public key', () => {
		const bytes = serializeIpnsKeyForImport(goldenKey());
		const data = Buffer.from(bytes.subarray(4)).toString('hex');
		expect(data).toBe(GOLDEN.seedHex + GOLDEN.publicKeyHex);
	});

	it('exposes the frozen protobuf prefix constant matching the emitted bytes', () => {
		const bytes = serializeIpnsKeyForImport(goldenKey());
		expect(
			Buffer.from(
				bytes.subarray(0, LIBP2P_ED25519_PRIVATE_KEY_PREFIX.length),
			).equals(Buffer.from(LIBP2P_ED25519_PRIVATE_KEY_PREFIX)),
		).toBe(true);
	});
});

describe('importIpnsKeyIntoPublisher — lands the serialized key via key/import on the publisher', () => {
	it('POSTs the serialized bytes to key/import under the site key name', async () => {
		const mock = new MockKuboApi().on('key/import', {
			json: {Name: 'mysite', Id: 'k51golden'},
		});
		const client = clientWith(mock);

		await importIpnsKeyIntoPublisher({
			client,
			role: 'publisher',
			keyName: 'mysite',
			derived: goldenKey(),
		});

		const imports = mock.requestsFor('key/import');
		expect(imports).toHaveLength(1);
		const req = imports[0]!;
		expect(req.query.get('arg')).toBe('mysite');
		// Kubo's key/import requires multipart/form-data with the key material as a
		// `file` part (NOT a raw body); the client must not hand-set content-type
		// (fetch owns the boundary). Assert the multipart contract + that the file
		// part carries EXACTLY what serializeIpnsKeyForImport produced.
		expect(req.contentType).toBe('multipart/form-data');
		expect(req.headers['content-type']).toBeUndefined();
		const filePart = req.fileParts?.find((p) => p.field === 'file');
		expect(filePart).toBeDefined();
		const expected = serializeIpnsKeyForImport(goldenKey());
		expect(Buffer.from(filePart!.bytes).equals(Buffer.from(expected))).toBe(
			true,
		);
		// It carried the bearer token like every other RPC call.
		expect(req.headers['authorization']).toBe('Bearer publisher-token');
	});
});

describe('importIpnsKeyIntoPublisher — publisher-only: replicas receive no key', () => {
	it('REFUSES to import on a replica and touches the Kubo RPC not at all', async () => {
		const mock = new MockKuboApi();
		const client = clientWith(mock);

		await expect(
			importIpnsKeyIntoPublisher({
				client,
				role: 'replica',
				keyName: 'mysite',
				derived: goldenKey(),
			}),
		).rejects.toBeInstanceOf(KeyImportRoleError);

		// No key/import (nor any) request reached the node: replicas stay keyless.
		expect(mock.requests).toHaveLength(0);
	});
});

describe('importIpnsKeyIntoPublisher — NO client-side record signing', () => {
	it('issues ONLY key/import: no name/publish or routing/put (where signing lives)', async () => {
		const mock = new MockKuboApi().on('key/import', {json: {Name: 'mysite'}});
		const client = clientWith(mock);

		await importIpnsKeyIntoPublisher({
			client,
			role: 'publisher',
			keyName: 'mysite',
			derived: goldenKey(),
		});

		// The client hands the node key MATERIAL only: the ONLY RPC issued is
		// key/import. It never asks the node to SIGN (no name/publish, which signs
		// a record) and never re-announces (no routing/put). Signing is the node's
		// concern via name/publish, owned by a separate task.
		expect(mock.requests.map((r) => r.path)).toEqual(['key/import']);
		expect(mock.requestsFor('name/publish')).toHaveLength(0);
		expect(mock.requestsFor('routing/put')).toHaveLength(0);
	});

	it('the module source uses NO signing primitive (only key material is supplied)', () => {
		// A static guard on the load-bearing invariant: the import module must not
		// reach for any client-side record-signing primitive. If a future edit
		// introduces node:crypto `sign`/`createSign` or a Sign() call here, this
		// fails loudly, pointing back at ADR-0003 (client derivation != signing).
		const src = readFileSync(
			fileURLToPath(
				new URL('../../src/publisher/key-import.ts', import.meta.url),
			),
			'utf8',
		);
		// Strip line comments + block comments so the ADR prose that legitimately
		// discusses "sign" does not trip the guard; only real CODE is inspected.
		const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
		expect(code).not.toMatch(/\bcreateSign\b/);
		expect(code).not.toMatch(/\bsign\s*\(/);
		expect(code).not.toMatch(/\.sign\b/);
	});
});
