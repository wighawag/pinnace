import {describe, it, expect} from 'vitest';
import {
	CHECK_NO,
	CHECK_YES,
	CheckUnavailableError,
	checkAnswer,
	checkState,
	checkUnknown,
	isYes,
	unavailableReason,
} from '../../src/status/check-outcome.js';

/**
 * The three-valued check vocabulary is a pure leaf module: no clock, no
 * network, no imports of its own. These tests pin the ONE property the whole
 * convention rests on — a check that could not RUN never reads as a negative.
 */

describe('CheckOutcome — a check that RAN carries its answer', () => {
	it('turns a definite answer into yes / no', () => {
		expect(checkAnswer(true)).toEqual({state: 'yes'});
		expect(checkAnswer(false)).toEqual({state: 'no'});
		expect(CHECK_YES).toEqual({state: 'yes'});
		expect(CHECK_NO).toEqual({state: 'no'});
	});

	it('reads yes as the only positive: no and unknown are both not-yes', () => {
		expect(isYes(checkAnswer(true))).toBe(true);
		expect(isYes(checkAnswer(false))).toBe(false);
		expect(isYes(checkUnknown('http 429'))).toBe(false);
		expect(isYes(undefined)).toBe(false);
	});
});

describe('CheckOutcome — a check that could NOT run is unknown, with a reason', () => {
	it('carries the reason it could not be made', () => {
		expect(checkUnknown('http 429')).toEqual({
			state: 'unknown',
			reason: 'http 429',
		});
	});

	it('never degrades to `no`: unknown is its own state', () => {
		const outcome = checkUnknown('no peer id');
		expect(outcome.state).toBe('unknown');
		expect(outcome).not.toEqual(CHECK_NO);
	});

	it('always has SOME reason, even when handed an empty one', () => {
		expect(checkUnknown('').reason).toBe('could not check');
		expect(checkUnknown('   ').reason).toBe('could not check');
	});

	it('reads an ABSENT outcome as unknown, never as a negative', () => {
		// A report that carries no verdict for a check did not run it; rendering
		// that as `no` is the same lie the three states exist to remove.
		expect(checkState(undefined)).toBe('unknown');
		expect(checkState(checkAnswer(false))).toBe('no');
		expect(checkState(checkAnswer(true))).toBe('yes');
		expect(checkState(checkUnknown('boom'))).toBe('unknown');
	});
});

describe('unavailableReason — a short, single-line reason from a failure', () => {
	it('names the could-not-check case explicitly (CheckUnavailableError)', () => {
		const error = new CheckUnavailableError('http 429');
		expect(error).toBeInstanceOf(Error);
		expect(error.reason).toBe('http 429');
		expect(error.message).toBe('http 429');
		expect(unavailableReason(error)).toBe('http 429');
	});

	it('falls back to a thrown error message (collapsed to one line)', () => {
		expect(unavailableReason(new Error('fetch failed'))).toBe('fetch failed');
		expect(unavailableReason(new Error('dns\nlookup\tfailed'))).toBe(
			'dns lookup failed',
		);
	});

	it('truncates a runaway message so a status line stays readable', () => {
		const reason = unavailableReason(new Error('x'.repeat(500)));
		expect(reason.length).toBeLessThanOrEqual(120);
		expect(reason.endsWith('...')).toBe(true);
	});

	it('still yields a reason for a non-Error / empty throw', () => {
		expect(unavailableReason(undefined)).toBe('could not check');
		expect(unavailableReason('')).toBe('could not check');
		expect(unavailableReason({})).toBe('could not check');
	});
});
