import {describe, it, expect} from 'vitest';
import {KuboRpcClient} from '../../src/rpc/kubo-rpc-client.js';
import {MockKuboApi} from '../../src/rpc/mock-kubo.js';
import {readRecordSequence} from '../../src/publisher/ipns-sequence.js';

/**
 * The sequence READ, tested entirely against the recording mock: no live
 * daemon, no network. The invariant under test throughout is the one the
 * finding `ipns-sequence-resets-to-zero-on-a-new-signer` is about: a sequence
 * we could not read must NEVER surface as a number, and least of all as 0.
 */

function clientWith(mock: MockKuboApi) {
	return new KuboRpcClient({
		baseUrl: mock.baseUrl,
		token: 'seq-token',
		fetchImpl: mock.fetchImpl,
	});
}

/** A mock whose routing/get returns a record body and name/inspect decodes it. */
function mockWith(record: string, inspect: unknown): MockKuboApi {
	return new MockKuboApi()
		.on('routing/get', {text: record})
		.on('name/inspect', {json: inspect});
}

describe('readRecordSequence', () => {
	it('reads the sequence out of the inspected record', async () => {
		const mock = mockWith('raw-record-bytes', {
			Entry: {Value: '/ipfs/bafyroot', Sequence: 7},
		});
		const seq = await readRecordSequence(clientWith(mock), 'k51alice');
		expect(seq).toEqual({state: 'known', sequence: 7});
	});

	it('reads a real sequence of 0 as KNOWN (a first publish is not a failure)', async () => {
		// The mirror image of the guard below: 0 is a legitimate sequence for a name
		// published once and never changed, so it must survive as a number. Only an
		// unreadable sequence is `unknown`.
		const mock = mockWith('raw', {Entry: {Sequence: 0}});
		const seq = await readRecordSequence(clientWith(mock), 'k51alice');
		expect(seq).toEqual({state: 'known', sequence: 0});
	});

	it('fetches the record for the right name and inspects it as multipart, without a hex dump', async () => {
		const mock = mockWith('raw-record-bytes', {Entry: {Sequence: 3}});
		await readRecordSequence(clientWith(mock), 'k51alice');

		const get = mock.requests.find((r) => r.path === 'routing/get')!;
		expect(get.query.get('arg')).toBe('/ipns/k51alice');

		const inspect = mock.requests.find((r) => r.path === 'name/inspect')!;
		// Kubo declares the record as a FileArg: a raw body is refused.
		expect(inspect.contentType).toMatch(/multipart\/form-data/);
		expect(inspect.fileParts?.[0]?.field).toBe('file');
		expect(new TextDecoder().decode(inspect.fileParts![0]!.bytes)).toBe(
			'raw-record-bytes',
		);
		// We never read the hex dump, and it would be hauled per site.
		expect(inspect.query.get('dump')).toBe('false');
	});

	it('reports UNKNOWN with the reason when routing/get fails, never a number', async () => {
		const mock = new MockKuboApi().on('routing/get', {
			status: 500,
			text: 'routing: not found',
		});
		const seq = await readRecordSequence(clientWith(mock), 'k51alice');
		expect(seq.state).toBe('unknown');
		if (seq.state === 'unknown') expect(seq.reason).not.toBe('');
	});

	it('reports UNKNOWN when name/inspect fails', async () => {
		const mock = new MockKuboApi()
			.on('routing/get', {text: 'raw'})
			.on('name/inspect', {status: 500, text: 'boom'});
		const seq = await readRecordSequence(clientWith(mock), 'k51alice');
		expect(seq.state).toBe('unknown');
	});

	it('reports UNKNOWN on an empty record body', async () => {
		const mock = mockWith('', {Entry: {Sequence: 4}});
		const seq = await readRecordSequence(clientWith(mock), 'k51alice');
		expect(seq).toEqual({state: 'unknown', reason: 'empty record'});
	});

	it('reports UNKNOWN — NOT 0 — when the inspect result carries no sequence', async () => {
		// The load-bearing case: `name/inspect` is EXPERIMENTAL, so a changed shape
		// must degrade to "could not read". Defaulting a missing field to 0 would
		// reproduce, in the REPORTING layer, the very bug this surfaces.
		const mock = mockWith('raw', {Entry: {Value: '/ipfs/bafyroot'}});
		const seq = await readRecordSequence(clientWith(mock), 'k51alice');
		expect(seq).toEqual({state: 'unknown', reason: 'no sequence in record'});
	});

	it('reports UNKNOWN when the sequence is not a finite number', async () => {
		const mock = mockWith('raw', {Entry: {Sequence: 'seven'}});
		const seq = await readRecordSequence(clientWith(mock), 'k51alice');
		expect(seq.state).toBe('unknown');
	});

	it('never throws: every failure is an outcome the caller can render', async () => {
		// status calls this per site; a throw would take down the whole report.
		const mock = new MockKuboApi().on('routing/get', {status: 503, text: ''});
		await expect(
			readRecordSequence(clientWith(mock), 'k51alice'),
		).resolves.toMatchObject({state: 'unknown'});
	});
});
