import {describe, it, expect} from 'vitest';
import {
	resolveConfig,
	resolveMasterSecret,
	resolveHostToken,
	hostTokenEnvVar,
	MissingHostTokenError,
	type PinnaceConfigFile,
} from '../../src/config/config-resolution.js';
import {deriveIpnsId} from '../../src/derive/ipns-key-derivation.js';

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
			role: 'publisher',
			publisherEndpoint: 'https://a.example/records',
		},
	],
	sites: [
		{
			id: 'mysite',
			mode: 'ipns',
			ensName: 'mysite.eth',
			sourceDir: './dist',
		},
	],
	gateways: ['https://dweb.link'],
};

describe('config resolution precedence: CLI arg > env > pinnace.json', () => {
	it('takes the file endpoint when neither CLI nor env is set', () => {
		const cfg = resolveConfig({file: fileConfig, env: {}, cli: {}});
		expect(cfg.hosts[0].endpoint).toBe('https://a.example');
	});

	it('env overrides the file endpoint', () => {
		const cfg = resolveConfig({
			file: fileConfig,
			env: {PINNACE_HOST_A_ENDPOINT: 'https://env.example'},
			cli: {},
		});
		expect(cfg.hosts[0].endpoint).toBe('https://env.example');
	});

	it('CLI arg overrides both env and file (endpoint)', () => {
		const cfg = resolveConfig({
			file: fileConfig,
			env: {PINNACE_HOST_A_ENDPOINT: 'https://env.example'},
			cli: {hostEndpoint: {a: 'https://cli.example'}},
		});
		expect(cfg.hosts[0].endpoint).toBe('https://cli.example');
	});

	it('parses a typed pinnace.json schema for hosts and sites (single site `id`)', () => {
		const cfg = resolveConfig({file: fileConfig, env: {}, cli: {}});
		expect(cfg.hosts[0].role).toBe('publisher');
		expect(cfg.hosts[0].publisherEndpoint).toBe('https://a.example/records');
		expect(cfg.sites[0].id).toBe('mysite');
		expect(cfg.sites[0].mode).toBe('ipns');
		expect(cfg.sites[0].ensName).toBe('mysite.eth');
		expect(cfg.gateways).toEqual(['https://dweb.link']);
		// A site has NO `name`/`keyId` surface: the identity is one `id`.
		const site0 = cfg.sites[0] as unknown as Record<string, unknown>;
		expect(site0.name).toBeUndefined();
		expect(site0.keyId).toBeUndefined();
	});
});

describe('bearer token is env-only (never a pinnace.json field, like the master)', () => {
	it('resolves the token from env(PINNACE_HOST_<NAME>_TOKEN)', () => {
		const token = resolveHostToken({
			hostName: 'a',
			env: {PINNACE_HOST_A_TOKEN: 'env-token'},
		});
		expect(token).toBe('env-token');
	});

	it('a CLI override takes precedence over env (CLI > env, no file layer)', () => {
		const token = resolveHostToken({
			hostName: 'a',
			env: {PINNACE_HOST_A_TOKEN: 'env-token'},
			cli: {hostToken: {a: 'cli-token'}},
		});
		expect(token).toBe('cli-token');
	});

	it('IGNORES a `token` field placed in a host entry in pinnace.json (never surfaces)', () => {
		// A decoy token in the file must never be read — there is no file layer for
		// the token, exactly like the master.
		const decoyFile = {
			hosts: [
				{
					name: 'a',
					endpoint: 'https://a.example',
					role: 'publisher',
					token: 'DECOY-TOKEN-IN-FILE',
				},
			],
		} as unknown as PinnaceConfigFile;
		// The resolved host carries no token field at all.
		const cfg = resolveConfig({file: decoyFile, env: {}, cli: {}});
		const host0 = cfg.hosts[0] as unknown as Record<string, unknown>;
		expect(host0.token).toBeUndefined();
		// And resolving the token from env-less form fails loud (never returns the decoy).
		expect(() => resolveHostToken({hostName: 'a', env: {}})).toThrow(
			MissingHostTokenError,
		);
	});

	it('a missing token is a LOUD error naming the exact env var (no silent empty token)', () => {
		try {
			resolveHostToken({hostName: 'publisher', env: {}});
			expect.unreachable('should have thrown MissingHostTokenError');
		} catch (error) {
			expect(error).toBeInstanceOf(MissingHostTokenError);
			const message = (error as Error).message;
			expect(message).toContain('PINNACE_HOST_PUBLISHER_TOKEN');
			expect(message).toContain("host 'publisher'");
		}
		expect(hostTokenEnvVar('publisher')).toBe('PINNACE_HOST_PUBLISHER_TOKEN');
	});

	it('an EMPTY-string token is treated as unresolved (loud error, never a silent "")', () => {
		expect(() =>
			resolveHostToken({hostName: 'a', env: {PINNACE_HOST_A_TOKEN: ''}}),
		).toThrow(MissingHostTokenError);
	});
});

describe('single site `id` is BOTH the MFS entry and the frozen KDF input', () => {
	it('an `id`-declared site derives the pinned golden-vector id (frozen KDF unchanged)', () => {
		// The golden vector: (master, id) = (test-master-secret, mysite) -> k51...
		// The config surface passes the single `id` straight into the derivation.
		const site = {id: 'mysite', mode: 'ipns', sourceDir: './dist'} as const;
		const id = deriveIpnsId({master: 'test-master-secret', keyId: site.id});
		expect(id).toBe(
			'k51qzi5uqu5dkkob0ou1d9xbkr1yskaj07trqc5czn58kvkos6n7y2yid3u4n5',
		);
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
