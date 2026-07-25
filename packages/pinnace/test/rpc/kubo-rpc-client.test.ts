import {describe, it, expect} from 'vitest';
import {KuboRpcClient, KuboRpcError} from '../../src/rpc/kubo-rpc-client.js';
import {MockKuboApi} from '../../src/rpc/mock-kubo.js';

function clientWith(mock: MockKuboApi, token = 'secret-token') {
	return new KuboRpcClient({
		baseUrl: mock.baseUrl,
		token,
		fetchImpl: mock.fetchImpl,
	});
}

describe('KuboRpcClient — auth + per-endpoint request shape', () => {
	it('sends Authorization: Bearer <token> on every call, as POST', async () => {
		const mock = new MockKuboApi();
		const client = clientWith(mock, 'my-token');
		await client.id();
		const req = mock.lastRequest!;
		expect(req.method).toBe('POST');
		expect(req.headers['authorization']).toBe('Bearer my-token');
	});

	it('id() targets /api/v0/id', async () => {
		const mock = new MockKuboApi().on('id', {json: {ID: 'peer-abc'}});
		const client = clientWith(mock);
		const res = await client.id();
		expect(mock.lastRequest!.path).toBe('id');
		expect((res as {ID: string}).ID).toBe('peer-abc');
	});

	it('dagImport hits dag/import?pin-roots=true with the CAR bytes as body', async () => {
		const mock = new MockKuboApi();
		const client = clientWith(mock);
		const car = new Uint8Array([1, 2, 3, 4]);
		await client.dagImport(car);
		const req = mock.lastRequest!;
		expect(req.path).toBe('dag/import');
		expect(req.query.get('pin-roots')).toBe('true');
		expect(req.headers['authorization']).toBe('Bearer secret-token');
	});

	it('files/* verbs carry the right arg query params', async () => {
		const mock = new MockKuboApi();
		const client = clientWith(mock);
		await client.filesMkdir('/sites', {parents: true});
		expect(mock.lastRequest!.path).toBe('files/mkdir');
		expect(mock.lastRequest!.query.get('arg')).toBe('/sites');
		expect(mock.lastRequest!.query.get('parents')).toBe('true');

		await client.filesRm('/sites/mysite', {recursive: true, force: true});
		expect(mock.lastRequest!.path).toBe('files/rm');
		expect(mock.lastRequest!.query.get('arg')).toBe('/sites/mysite');
		expect(mock.lastRequest!.query.get('recursive')).toBe('true');
		expect(mock.lastRequest!.query.get('force')).toBe('true');

		await client.filesCp('/ipfs/bafyroot', '/sites/mysite');
		expect(mock.lastRequest!.path).toBe('files/cp');
		expect(mock.lastRequest!.query.getAll('arg')).toEqual([
			'/ipfs/bafyroot',
			'/sites/mysite',
		]);

		mock.on('files/stat', {json: {Hash: 'bafyroot', Type: 'directory'}});
		const stat = await client.filesStat('/sites/mysite');
		expect(mock.lastRequest!.path).toBe('files/stat');
		expect((stat as {Hash: string}).Hash).toBe('bafyroot');

		mock.on('files/ls', {json: {Entries: [{Name: 'mysite'}]}});
		await client.filesLs('/sites');
		expect(mock.lastRequest!.path).toBe('files/ls');
		expect(mock.lastRequest!.query.get('arg')).toBe('/sites');
	});

	it('key/* verbs: list, gen, import', async () => {
		const mock = new MockKuboApi().on('key/list', {
			json: {Keys: [{Name: 'mysite', Id: 'k51xxx'}]},
		});
		const client = clientWith(mock);
		const keys = await client.keyList();
		expect(mock.lastRequest!.path).toBe('key/list');
		expect(mock.lastRequest!.query.get('l')).toBe('true');
		expect((keys as {Keys: unknown[]}).Keys.length).toBe(1);

		await client.keyGen('mysite');
		expect(mock.lastRequest!.path).toBe('key/gen');
		expect(mock.lastRequest!.query.get('arg')).toBe('mysite');
		expect(mock.lastRequest!.query.get('type')).toBe('ed25519');

		await client.keyImport('mysite', new Uint8Array([9, 9, 9]));
		expect(mock.lastRequest!.path).toBe('key/import');
		expect(mock.lastRequest!.query.get('arg')).toBe('mysite');
	});
});

/**
 * The file-upload contract Kubo actually enforces: `add`, `dag/import` and
 * `key/import` MUST be `multipart/form-data` with the payload as a `file` part.
 * Real Kubo v0.38+ rejects a raw `application/octet-stream` body with
 * `400 file argument 'path' is required`. These assertions guard that seam
 * without a live daemon (they failed before the multipart fix; see
 * work/notes/findings/kubo-file-upload-multipart-contract.md).
 */
describe('KuboRpcClient — file-upload endpoints send multipart/form-data', () => {
	it('dagImport sends multipart/form-data with a `file` part (no hand-set content-type)', async () => {
		const mock = new MockKuboApi();
		const client = clientWith(mock);
		const car = new Uint8Array([1, 2, 3, 4]);
		await client.dagImport(car);
		const req = mock.lastRequest!;
		expect(req.contentType).toBe('multipart/form-data');
		// The caller must NOT hand-set content-type: fetch owns the boundary.
		expect(req.headers['content-type']).toBeUndefined();
		const filePart = req.fileParts?.find((p) => p.field === 'file');
		expect(filePart).toBeDefined();
		expect(Array.from(filePart!.bytes)).toEqual([1, 2, 3, 4]);
		// Query params + auth are untouched by the encoding change.
		expect(req.query.get('pin-roots')).toBe('true');
		expect(req.headers['authorization']).toBe('Bearer secret-token');
	});

	it('add sends multipart/form-data with a `file` part (no hand-set content-type)', async () => {
		const mock = new MockKuboApi();
		const client = clientWith(mock);
		await client.add(new Uint8Array([5, 6, 7]));
		const req = mock.lastRequest!;
		expect(req.path).toBe('add');
		expect(req.contentType).toBe('multipart/form-data');
		expect(req.headers['content-type']).toBeUndefined();
		const filePart = req.fileParts?.find((p) => p.field === 'file');
		expect(filePart).toBeDefined();
		expect(Array.from(filePart!.bytes)).toEqual([5, 6, 7]);
		expect(req.headers['authorization']).toBe('Bearer secret-token');
	});

	it('keyImport sends multipart/form-data with a `file` part, keeping arg=<name>', async () => {
		const mock = new MockKuboApi();
		const client = clientWith(mock);
		await client.keyImport('mysite', new Uint8Array([9, 9, 9]));
		const req = mock.lastRequest!;
		expect(req.path).toBe('key/import');
		expect(req.query.get('arg')).toBe('mysite');
		expect(req.contentType).toBe('multipart/form-data');
		expect(req.headers['content-type']).toBeUndefined();
		const filePart = req.fileParts?.find((p) => p.field === 'file');
		expect(filePart).toBeDefined();
		expect(Array.from(filePart!.bytes)).toEqual([9, 9, 9]);
		expect(req.headers['authorization']).toBe('Bearer secret-token');
	});

	it('name/publish carries arg + key + lifetime + ttl', async () => {
		const mock = new MockKuboApi();
		const client = clientWith(mock);
		await client.namePublish({
			cidPath: '/ipfs/bafyroot',
			key: 'mysite',
			lifetime: '72h',
			ttl: '1h',
		});
		const req = mock.lastRequest!;
		expect(req.path).toBe('name/publish');
		expect(req.query.get('arg')).toBe('/ipfs/bafyroot');
		expect(req.query.get('key')).toBe('mysite');
		expect(req.query.get('lifetime')).toBe('72h');
		expect(req.query.get('ttl')).toBe('1h');
	});

	it('routing/get is a body-less read (no multipart, no file part)', async () => {
		const mock = new MockKuboApi();
		const client = clientWith(mock);
		await client.routingGet('/ipns/k51xxx');
		const req = mock.lastRequest!;
		expect(req.path).toBe('routing/get');
		expect(req.query.get('arg')).toBe('/ipns/k51xxx');
		// WRITE-side only takes a file: the read carries no body at all.
		expect(req.contentType).toBeUndefined();
		expect(req.fileParts).toBeUndefined();
		expect(req.bodyText).toBe('');
		expect(req.headers['authorization']).toBe('Bearer secret-token');
	});

	it('routingPut sends multipart/form-data with a `value-file` part (NOT `file`), keeping arg + bearer', async () => {
		const mock = new MockKuboApi();
		const client = clientWith(mock);
		await client.routingPut('/ipns/k51xxx', new Uint8Array([7, 7]));
		const req = mock.lastRequest!;
		expect(req.path).toBe('routing/put');
		expect(req.query.get('arg')).toBe('/ipns/k51xxx');
		expect(req.contentType).toBe('multipart/form-data');
		// The caller must NOT hand-set content-type: fetch owns the boundary.
		expect(req.headers['content-type']).toBeUndefined();
		// Kubo's routing/put names the record part `value-file`, NOT the generic
		// `file` the other upload endpoints use.
		expect(req.fileParts?.some((p) => p.field === 'file')).toBeFalsy();
		const valueFile = req.fileParts?.find((p) => p.field === 'value-file');
		expect(valueFile).toBeDefined();
		expect(Array.from(valueFile!.bytes)).toEqual([7, 7]);
		expect(req.headers['authorization']).toBe('Bearer secret-token');
	});

	it('add posts to /api/v0/add', async () => {
		const mock = new MockKuboApi();
		const client = clientWith(mock);
		await client.add(new Uint8Array([1]));
		expect(mock.lastRequest!.path).toBe('add');
	});

	it('pinRm hits pin/rm?arg=<cid> to unpin content', async () => {
		const mock = new MockKuboApi();
		const client = clientWith(mock);
		await client.pinRm('bafysite');
		expect(mock.lastRequest!.path).toBe('pin/rm');
		expect(mock.lastRequest!.query.get('arg')).toBe('bafysite');
	});

	it('pinAdd hits pin/add?arg=<cid>&recursive=true (recursive by default)', async () => {
		const mock = new MockKuboApi();
		const client = clientWith(mock, 'pin-token');
		await client.pinAdd('bafyexternal');
		const req = mock.lastRequest!;
		expect(req.method).toBe('POST');
		expect(req.path).toBe('pin/add');
		expect(req.query.get('arg')).toBe('bafyexternal');
		expect(req.query.get('recursive')).toBe('true');
		expect(req.headers['authorization']).toBe('Bearer pin-token');
	});

	it('pinAdd sends recursive=false when recursion is disabled (root block only)', async () => {
		const mock = new MockKuboApi();
		const client = clientWith(mock);
		await client.pinAdd('bafyexternal', {recursive: false});
		expect(mock.lastRequest!.query.get('recursive')).toBe('false');
	});

	it('pinAdd raises the loud KuboRpcError on a non-2xx (unretrievable content)', async () => {
		const mock = new MockKuboApi().on('pin/add', {
			status: 500,
			text: 'merkledag: not found',
		});
		const client = clientWith(mock);
		await expect(client.pinAdd('bafymissing')).rejects.toThrow(KuboRpcError);
	});
});

/**
 * `name/resolve`: resolving an IPNS NAME to the CID it CURRENTLY points at.
 * This is the read the `pin --from-ipns <source>` migrate path stands on: the
 * SOURCE name (someone else's, or the operator's old one) resolved to a
 * snapshot CID, which the existing pin flow then pins. Kubo does the DHT work;
 * this seam only asserts the call shape, the auth, and the `/ipfs/<cid>` parse.
 */
describe('KuboRpcClient, name/resolve (the migrate SOURCE read)', () => {
	it('nameResolve hits name/resolve?arg=/ipns/<name> and parses the /ipfs/<cid>', async () => {
		const mock = new MockKuboApi().on('name/resolve', {
			json: {Path: '/ipfs/bafycurrentsnapshot'},
		});
		const client = clientWith(mock, 'resolve-token');
		const cid = await client.nameResolve('k51source');
		const req = mock.lastRequest!;
		expect(req.method).toBe('POST');
		expect(req.path).toBe('name/resolve');
		expect(req.query.get('arg')).toBe('/ipns/k51source');
		expect(req.headers['authorization']).toBe('Bearer resolve-token');
		// The CID the SOURCE name currently points at (what a migrate then pins).
		expect(cid).toBe('bafycurrentsnapshot');
	});

	it('normalises a bare id, an /ipns/<id> path and an ipns://<id> address alike', async () => {
		const mock = new MockKuboApi().on('name/resolve', {
			json: {Path: '/ipfs/bafycurrentsnapshot'},
		});
		const client = clientWith(mock);
		for (const form of ['k51source', '/ipns/k51source', 'ipns://k51source']) {
			await client.nameResolve(form);
			expect(mock.lastRequest!.query.get('arg')).toBe('/ipns/k51source');
		}
	});

	it('raises the loud KuboRpcError when the name does not resolve (Kubo says so)', async () => {
		const mock = new MockKuboApi().on('name/resolve', {
			status: 500,
			text: 'routing: not found',
		});
		const client = clientWith(mock);
		await expect(client.nameResolve('k51nothere')).rejects.toThrow(
			KuboRpcError,
		);
		try {
			await client.nameResolve('k51nothere');
		} catch (e) {
			// Kubo's own message is passed through, not swallowed.
			expect((e as KuboRpcError).message).toContain('routing: not found');
			expect((e as KuboRpcError).endpoint).toBe('name/resolve');
		}
	});

	it('fails loudly when the resolved path is not /ipfs/<cid> (never a silent empty cid)', async () => {
		const mock = new MockKuboApi().on('name/resolve', {json: {}});
		const client = clientWith(mock);
		await expect(client.nameResolve('k51source')).rejects.toThrow(
			/name\/resolve/,
		);
	});
});

describe('KuboRpcClient — error path', () => {
	it('raises a loud KuboRpcError naming the endpoint and status on non-2xx', async () => {
		const mock = new MockKuboApi().on('files/stat', {
			status: 500,
			text: 'boom',
		});
		const client = clientWith(mock);
		await expect(client.filesStat('/sites/nope')).rejects.toThrow(KuboRpcError);
		try {
			await client.filesStat('/sites/nope');
		} catch (e) {
			const err = e as KuboRpcError;
			expect(err.message).toContain('files/stat');
			expect(err.message).toContain('500');
			expect(err.status).toBe(500);
			expect(err.endpoint).toBe('files/stat');
		}
	});
});
