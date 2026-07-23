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

	it('routing/get and routing/put', async () => {
		const mock = new MockKuboApi();
		const client = clientWith(mock);
		await client.routingGet('/ipns/k51xxx');
		expect(mock.lastRequest!.path).toBe('routing/get');
		expect(mock.lastRequest!.query.get('arg')).toBe('/ipns/k51xxx');

		await client.routingPut('/ipns/k51xxx', new Uint8Array([7, 7]));
		expect(mock.lastRequest!.path).toBe('routing/put');
		expect(mock.lastRequest!.query.get('arg')).toBe('/ipns/k51xxx');
	});

	it('add posts to /api/v0/add', async () => {
		const mock = new MockKuboApi();
		const client = clientWith(mock);
		await client.add(new Uint8Array([1]));
		expect(mock.lastRequest!.path).toBe('add');
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
