import {describe, it, expect} from 'vitest';
import {KuboRpcClient, KuboRpcError} from '../../src/rpc/kubo-rpc-client.js';
import {MockKuboApi, routingGetBody} from '../../src/rpc/mock-kubo.js';

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
		// Unstated: Kubo's own sequence logic is left alone, which is right for
		// every publish by a node that already signs this name.
		expect(req.query.get('sequence')).toBeNull();
	});

	it('name/publish carries an EXPLICIT sequence when one is stated', async () => {
		// The failover lever: a new signer that cannot see the live record would
		// otherwise silently start at 0 and lose. See
		// work/notes/findings/ipns-sequence-resets-to-zero-on-a-new-signer.md.
		const mock = new MockKuboApi();
		const client = clientWith(mock);
		await client.namePublish({
			cidPath: '/ipfs/bafyroot',
			key: 'mysite',
			sequence: 42,
		});
		expect(mock.lastRequest!.query.get('sequence')).toBe('42');
	});

	it('name/publish omits a sequence of 0 (Kubo rejects it; it overrides nothing)', async () => {
		const mock = new MockKuboApi();
		const client = clientWith(mock);
		await client.namePublish({
			cidPath: '/ipfs/bafyroot',
			key: 'mysite',
			sequence: 0,
		});
		expect(mock.lastRequest!.query.get('sequence')).toBeNull();
	});

	it('name/inspect uploads the record as multipart and suppresses the hex dump', async () => {
		const mock = new MockKuboApi().on('name/inspect', {
			json: {Entry: {Sequence: 5}},
		});
		const client = clientWith(mock);
		const out = await client.nameInspect(new Uint8Array([1, 2, 3]));
		const req = mock.lastRequest!;
		expect(req.path).toBe('name/inspect');
		expect(req.contentType).toMatch(/multipart\/form-data/);
		expect(Array.from(req.fileParts![0]!.bytes)).toEqual([1, 2, 3]);
		expect(req.query.get('dump')).toBe('false');
		expect(out.Entry?.Sequence).toBe(5);
	});

	it("routing/get DECODES the base64 record out of Kubo's JSON envelope", async () => {
		// Kubo's HTTP RPC returns a JSON QueryEvent carrying the record base64 in
		// `Extra` — the raw bytes a shell redirect sees come only from the CLI's
		// text encoder. Exporting the ENVELOPE is what broke replica re-announce in
		// production; see
		// work/notes/findings/kubo-routing-get-returns-a-json-envelope-not-the-record.md.
		const record = new Uint8Array([0x0a, 0x41, 0x2f, 0xff, 0x00, 0xfe]);
		const mock = new MockKuboApi().on('routing/get', {
			text: routingGetBody(record),
		});
		const got = await clientWith(mock).routingGet('/ipns/k51xxx');
		expect(Array.from(got)).toEqual(Array.from(record));
	});

	it('routing/get REFUSES loudly when the envelope carries no record', async () => {
		// The envelope is a 200-OK non-empty body, so nothing upstream fails on it.
		// An empty/absent `Extra` must therefore be a loud error, never an empty
		// record that would later read as "this name has no record".
		const mock = new MockKuboApi().on('routing/get', {
			text: JSON.stringify({ID: '', Type: 5, Responses: null}),
		});
		await expect(clientWith(mock).routingGet('/ipns/k51xxx')).rejects.toThrow(
			/no base64 'Extra'/,
		);
	});

	it('routing/get REFUSES loudly on a body that is not JSON at all', async () => {
		const mock = new MockKuboApi().on('routing/get', {text: 'not json'});
		await expect(clientWith(mock).routingGet('/ipns/k51xxx')).rejects.toThrow(
			/not JSON/,
		);
	});

	it('routing/get is a body-less read (no multipart, no file part)', async () => {
		const mock = new MockKuboApi().on('routing/get', {
			text: routingGetBody('rec'),
		});
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

/**
 * MFS file read/write: the channel a site's `metadata.json` travels on
 * (`/sites/<id>/metadata.json`). `files/write` is a file-upload endpoint (same
 * multipart contract as `add`/`dag/import`), `files/read` is a plain body-less
 * read that streams the bytes back.
 */
describe('KuboRpcClient, MFS file write/read (metadata.json channel)', () => {
	it('filesWrite hits files/write?arg=<path>&create&parents&truncate with the bearer', async () => {
		const mock = new MockKuboApi();
		const client = clientWith(mock, 'mfs-token');
		await client.filesWrite('/sites/mysite/metadata.json', new Uint8Array([1]));
		const req = mock.lastRequest!;
		expect(req.method).toBe('POST');
		expect(req.path).toBe('files/write');
		expect(req.query.get('arg')).toBe('/sites/mysite/metadata.json');
		// create-or-fully-replace: create the file (and its parents) if absent,
		// truncate it to zero first so a re-write REPLACES rather than appends.
		expect(req.query.get('create')).toBe('true');
		expect(req.query.get('parents')).toBe('true');
		expect(req.query.get('truncate')).toBe('true');
		expect(req.headers['authorization']).toBe('Bearer mfs-token');
	});

	it('filesWrite sends multipart/form-data with a `file` part (no hand-set content-type)', async () => {
		const mock = new MockKuboApi();
		const client = clientWith(mock);
		const bytes = new TextEncoder().encode('{"mode":"ipns"}');
		await client.filesWrite('/sites/mysite/metadata.json', bytes);
		const req = mock.lastRequest!;
		expect(req.contentType).toBe('multipart/form-data');
		// The caller must NOT hand-set content-type: fetch owns the boundary.
		expect(req.headers['content-type']).toBeUndefined();
		const filePart = req.fileParts?.find((p) => p.field === 'file');
		expect(filePart).toBeDefined();
		expect(new TextDecoder().decode(filePart!.bytes)).toBe('{"mode":"ipns"}');
	});

	it('a re-write sends the same truncating request shape (replace, never append)', async () => {
		const mock = new MockKuboApi();
		const client = clientWith(mock);
		await client.filesWrite('/sites/mysite/metadata.json', new Uint8Array([1]));
		await client.filesWrite('/sites/mysite/metadata.json', new Uint8Array([2]));
		const writes = mock.requestsFor('files/write');
		expect(writes.length).toBe(2);
		for (const req of writes) {
			expect(req.query.get('truncate')).toBe('true');
			expect(req.query.get('create')).toBe('true');
		}
		expect(
			Array.from(writes[1]!.fileParts!.find((p) => p.field === 'file')!.bytes),
		).toEqual([2]);
	});

	it('filesWrite raises the loud KuboRpcError on a non-2xx', async () => {
		const mock = new MockKuboApi().on('files/write', {
			status: 500,
			text: 'file does not exist',
		});
		const client = clientWith(mock);
		await expect(
			client.filesWrite('/sites/nope/metadata.json', new Uint8Array([1])),
		).rejects.toThrow(KuboRpcError);
	});

	it('filesRead hits files/read?arg=<path> with the bearer and returns the bytes', async () => {
		const mock = new MockKuboApi().on('files/read', {
			text: '{"ensName":"example.eth"}',
		});
		const client = clientWith(mock, 'mfs-token');
		const bytes = await client.filesRead('/sites/mysite/metadata.json');
		const req = mock.lastRequest!;
		expect(req.method).toBe('POST');
		expect(req.path).toBe('files/read');
		expect(req.query.get('arg')).toBe('/sites/mysite/metadata.json');
		expect(req.headers['authorization']).toBe('Bearer mfs-token');
		// A body-less read: nothing is uploaded.
		expect(req.contentType).toBeUndefined();
		expect(req.fileParts).toBeUndefined();
		expect(req.bodyText).toBe('');
		expect(new TextDecoder().decode(bytes)).toBe('{"ensName":"example.eth"}');
	});

	it('filesRead raises the loud KuboRpcError naming endpoint + status when the file is missing', async () => {
		const mock = new MockKuboApi().on('files/read', {
			status: 500,
			text: 'file does not exist',
		});
		const client = clientWith(mock);
		await expect(
			client.filesRead('/sites/mysite/metadata.json'),
		).rejects.toThrow(KuboRpcError);
		try {
			await client.filesRead('/sites/mysite/metadata.json');
		} catch (e) {
			const err = e as KuboRpcError;
			expect(err.endpoint).toBe('files/read');
			expect(err.status).toBe(500);
			// Kubo's own message is passed through, so "absent" is legible.
			expect(err.message).toContain('file does not exist');
		}
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
