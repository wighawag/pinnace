import {describe, it, expect} from 'vitest';
import {name, PINNACE} from '../src/index.js';
import {run} from '../src/cli/run.js';

describe('pinnace core', () => {
	it('exposes the package name from the library core', () => {
		expect(name()).toEqual('pinnace');
		expect(PINNACE).toEqual('pinnace');
	});
});

describe('pinnace cli seam', () => {
	it('dispatches `version` through to the core name (thin-wrapper seam)', async () => {
		const code = await run(['version']);
		expect(code).toEqual(0);
	});
});
