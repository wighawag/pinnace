import {describe, it, expect} from 'vitest';
import {
	resolveConfig,
	resolveMasterSecret,
	resolveHostToken,
	hostTokenEnvVar,
	MissingHostTokenError,
	CLI_ENDPOINT_HOST_NAME,
	cliReplicaHostName,
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

	it('parses a typed pinnace.json schema for hosts + gateways (INFRA only)', () => {
		const cfg = resolveConfig({file: fileConfig, env: {}, cli: {}});
		expect(cfg.hosts[0].role).toBe('publisher');
		expect(cfg.hosts[0].publisherEndpoint).toBe('https://a.example/records');
		expect(cfg.gateways).toEqual(['https://dweb.link']);
	});
});

describe('pinnace.json is INFRA only — sites live in MFS, not in the config', () => {
	it('IGNORES a `sites` array in the file (it never surfaces on the resolved config)', () => {
		// A stale config from the old model: the sites array must be inert, exactly
		// as a stray `master`/`token` field is (the site + its per-site metadata are
		// the node's MFS wrapper, not a config surface).
		const staleFile = {
			...fileConfig,
			sites: [{id: 'mysite', mode: 'ipns', sourceDir: './dist'}],
		} as unknown as PinnaceConfigFile;
		const cfg = resolveConfig({file: staleFile, env: {}, cli: {}});
		expect((cfg as unknown as {sites?: unknown}).sites).toBeUndefined();
		// hosts/gateways are unchanged by the stale key.
		expect(cfg.hosts.map((h) => h.name)).toEqual(['a']);
		expect(cfg.gateways).toEqual(['https://dweb.link']);
	});
});

describe('the config file is OPTIONAL — a CLI endpoint yields a single-node target', () => {
	it('with NO file at all, a CLI endpoint resolves ONE publisher host', () => {
		const cfg = resolveConfig({
			file: {},
			env: {},
			cli: {endpoint: 'https://solo.example'},
		});
		expect(cfg.hosts.length).toBe(1);
		expect(cfg.hosts[0]).toMatchObject({
			name: CLI_ENDPOINT_HOST_NAME,
			endpoint: 'https://solo.example',
			role: 'publisher',
		});
	});

	it('its token stays env-only, under the SAME PINNACE_HOST_<NAME>_TOKEN convention', () => {
		const envVar = hostTokenEnvVar(CLI_ENDPOINT_HOST_NAME);
		expect(envVar).toBe('PINNACE_HOST_PUBLISHER_TOKEN');
		const token = resolveHostToken({
			hostName: CLI_ENDPOINT_HOST_NAME,
			env: {[envVar]: 'solo-token'},
		});
		expect(token).toBe('solo-token');
		// And with no env token it is the same LOUD, named failure as any host.
		expect(() =>
			resolveHostToken({hostName: CLI_ENDPOINT_HOST_NAME, env: {}}),
		).toThrow(MissingHostTokenError);
	});

	it('--replica-endpoint adds keyless replicas, numbered in the order given', () => {
		const cfg = resolveConfig({
			file: {},
			env: {},
			cli: {
				endpoint: 'https://pub.example',
				replicaEndpoints: ['https://r1.example', 'https://r2.example'],
			},
		});
		// A whole multi-node setup, expressed with args alone (the CI case).
		expect(cfg.hosts).toEqual([
			{
				name: 'publisher',
				endpoint: 'https://pub.example',
				role: 'publisher',
			},
			{
				name: cliReplicaHostName(0),
				endpoint: 'https://r1.example',
				role: 'replica',
				publisherEndpoint: 'https://pub.example',
			},
			{
				name: cliReplicaHostName(1),
				endpoint: 'https://r2.example',
				role: 'replica',
				publisherEndpoint: 'https://pub.example',
			},
		]);
		// Each one's token is env-only under the ORDINARY naming rule, so the
		// ORDER of the flags is what decides which secret is which.
		expect(hostTokenEnvVar(cfg.hosts[1].name)).toBe(
			'PINNACE_HOST_REPLICA_1_TOKEN',
		);
		expect(hostTokenEnvVar(cfg.hosts[2].name)).toBe(
			'PINNACE_HOST_REPLICA_2_TOKEN',
		);
	});

	it('ignores replicas with no CLI endpoint (there is no arg-tier list to extend)', () => {
		// The CLI refuses this combination loudly before the resolver is reached;
		// the resolver simply never half-applies them to the FILE's hosts.
		const cfg = resolveConfig({
			file: fileConfig,
			env: {},
			cli: {replicaEndpoints: ['https://r1.example']},
		});
		expect(cfg.hosts.map((h) => h.name)).toEqual(
			fileConfig.hosts!.map((h) => h.name),
		);
	});

	it('a CLI endpoint WINS over the file hosts (arg > file), narrowing to that node', () => {
		const cfg = resolveConfig({
			file: fileConfig,
			env: {PINNACE_HOST_A_ENDPOINT: 'https://env.example'},
			cli: {endpoint: 'https://solo.example'},
		});
		expect(cfg.hosts.map((h) => h.endpoint)).toEqual(['https://solo.example']);
		// The rest of the file layer still applies (only hosts are replaced).
		expect(cfg.gateways).toEqual(['https://dweb.link']);
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
	it('the `id` ARG derives the pinned golden-vector id (frozen KDF unchanged)', () => {
		// The golden vector: (master, id) = (test-master-secret, mysite) -> k51...
		// The id now comes from the command line (there is no config site entry to
		// look it up in); it feeds the frozen derivation unchanged.
		const siteId = 'mysite';
		const id = deriveIpnsId({master: 'test-master-secret', keyId: siteId});
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
