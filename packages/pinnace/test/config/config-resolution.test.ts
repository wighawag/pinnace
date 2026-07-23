import {describe, it, expect} from 'vitest';
import {
	resolveConfig,
	resolveMasterSecret,
	type PinnaceConfigFile,
} from '../../src/config/config-resolution.js';

/**
 * These tests ISOLATE the environment: they build an explicit `env` record and
 * pass it into the resolver rather than reading `process.env`, and they pass an
 * in-memory config object rather than reading any real `pinnace.json`. So the
 * operator's real environment and real config file are never read or mutated.
 * The env lever is `env` (a resolver argument that stands in for the ldenv/env
 * layer, resolved in-process here so the test process's own process.env is
 * untouched).
 */

const fileConfig: PinnaceConfigFile = {
	hosts: [
		{
			name: 'a',
			endpoint: 'https://a.example',
			token: 'file-token',
			role: 'publisher',
			publisherEndpoint: 'https://a.example/records',
		},
	],
	sites: [
		{
			name: 'mysite',
			mode: 'ipns',
			keyId: 'kid-1',
			ensName: 'mysite.eth',
			sourceDir: './dist',
		},
	],
	gateways: ['https://dweb.link'],
};

describe('config resolution precedence: CLI arg > env > pinnace.json', () => {
	it('takes the file value when neither CLI nor env is set', () => {
		const cfg = resolveConfig({file: fileConfig, env: {}, cli: {}});
		expect(cfg.hosts[0].token).toBe('file-token');
	});

	it('env overrides the file value', () => {
		const cfg = resolveConfig({
			file: fileConfig,
			env: {PINNACE_HOST_A_TOKEN: 'env-token'},
			cli: {},
		});
		expect(cfg.hosts[0].token).toBe('env-token');
	});

	it('CLI arg overrides both env and file', () => {
		const cfg = resolveConfig({
			file: fileConfig,
			env: {PINNACE_HOST_A_TOKEN: 'env-token'},
			cli: {hostToken: {a: 'cli-token'}},
		});
		expect(cfg.hosts[0].token).toBe('cli-token');
	});

	it('parses a typed pinnace.json schema for hosts and sites', () => {
		const cfg = resolveConfig({file: fileConfig, env: {}, cli: {}});
		expect(cfg.hosts[0].role).toBe('publisher');
		expect(cfg.hosts[0].publisherEndpoint).toBe('https://a.example/records');
		expect(cfg.sites[0].mode).toBe('ipns');
		expect(cfg.sites[0].keyId).toBe('kid-1');
		expect(cfg.sites[0].ensName).toBe('mysite.eth');
		expect(cfg.gateways).toEqual(['https://dweb.link']);
	});
});

describe('master secret is env-only (security invariant)', () => {
	it('reads the master from env', () => {
		const master = resolveMasterSecret({
			env: {PINNACE_MASTER: 'the-real-master'},
		});
		expect(master).toBe('the-real-master');
	});

	it('IGNORES a `master` field placed in pinnace.json (never surfaces from the resolver)', () => {
		// A decoy master in the file must never be read.
		const decoyFile = {
			...fileConfig,
			master: 'DECOY-SHOULD-BE-IGNORED',
		} as PinnaceConfigFile;
		const cfg = resolveConfig({file: decoyFile, env: {}, cli: {}});
		// The resolved config object exposes no master field at all.
		expect((cfg as unknown as {master?: string}).master).toBeUndefined();
		// And the master resolver, given ONLY the file's decoy in env-less form,
		// returns undefined — it has no file path for the master by construction.
		const master = resolveMasterSecret({env: {}});
		expect(master).toBeUndefined();
	});

	it('a decoy master in the file does not leak even when env master is set', () => {
		const decoyFile = {...fileConfig, master: 'DECOY'} as PinnaceConfigFile;
		resolveConfig({file: decoyFile, env: {PINNACE_MASTER: 'real'}, cli: {}});
		const master = resolveMasterSecret({env: {PINNACE_MASTER: 'real'}});
		expect(master).toBe('real');
		expect(master).not.toBe('DECOY');
	});
});
