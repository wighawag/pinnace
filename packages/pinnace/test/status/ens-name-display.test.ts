import {describe, it, expect} from 'vitest';
import {ensNameDisplay} from '../../src/status/ens-name-display.js';

/**
 * The classifier both status renderers share: the STORED three-valued `ensName`
 * plus the ALREADY-RESOLVED `ensNameToWarm` in, one of four display states out.
 * Pure: no daemon, no clock, no resolution of its own.
 */
describe('ensNameDisplay — the four states an ENS name reads as', () => {
	it('reports a STORED name as stored (an override of any `.eth` id)', () => {
		expect(
			ensNameDisplay({ensName: 'named.eth', ensNameToWarm: 'named.eth'}),
		).toEqual({kind: 'stored', name: 'named.eth'});
		// The stored name wins even over a different `.eth` id's inference.
		expect(
			ensNameDisplay({ensName: 'other.eth', ensNameToWarm: 'other.eth'}),
		).toEqual({kind: 'stored', name: 'other.eth'});
	});

	it('reports an ABSENT name the report RESOLVED as inferred', () => {
		expect(ensNameDisplay({ensNameToWarm: 'ronan.eth'})).toEqual({
			kind: 'inferred',
			name: 'ronan.eth',
		});
	});

	it('reports the `""` opt-out as opted-out, never as a name or as none', () => {
		expect(ensNameDisplay({ensName: ''})).toEqual({kind: 'opted-out'});
		// `""` is TOTAL: it opts out even if something else resolved a name.
		expect(ensNameDisplay({ensName: '', ensNameToWarm: 'ronan.eth'})).toEqual({
			kind: 'opted-out',
		});
	});

	it('reports nothing stored AND nothing resolved as none', () => {
		expect(ensNameDisplay({})).toEqual({kind: 'none'});
	});

	it('RESOLVES nothing itself: a `.eth` id is not its input', () => {
		// The `.eth` inference is the report's job (resolveEnsNameToWarm); this
		// classifier is handed the RESULT and never re-derives it, so it cannot
		// disagree with what the box will actually warm. A site whose id WOULD
		// infer one still reads as none until the report resolves it.
		const siteWithEthId = {id: 'ronan.eth'};
		expect(ensNameDisplay(siteWithEthId)).toEqual({kind: 'none'});
	});
});
