/**
 * Config resolution for pinnace.
 *
 * Every setting resolves with precedence **CLI arg > env (via `ldenv`) >
 * `pinnace.json`** (CONTEXT.md "config resolution"). This module owns the typed
 * `pinnace.json` schema and the resolver.
 *
 * SECURITY INVARIANT (hard): the **master secret is env-only**. The resolver
 * has NO file path for the master — a `master` field placed in `pinnace.json`
 * is structurally impossible to surface here. Reading the master goes through
 * {@link resolveMasterSecret}, which consults ONLY env. A compromised node or a
 * leaked config file therefore cannot leak the master.
 *
 * `ldenv` is the env layer in production; to keep tests hermetic (and to keep
 * the operator's real environment untouched), the resolver takes an explicit
 * `env` record rather than reading `process.env` directly. A thin production
 * caller passes `ldenv`-loaded values in.
 */

/** A node/host role. */
export type HostRole = 'publisher' | 'replica';

/** A per-site publish mode. */
export type SiteMode = 'ipfs' | 'ipns';

/** A host/node entry as it appears in `pinnace.json`. */
export interface HostConfig {
	/** Stable host name (used to key env/CLI overrides). */
	name: string;
	/** The node's Kubo RPC endpoint. */
	endpoint: string;
	/** The node's bearer token (may be overridden by env/CLI). */
	token: string;
	/** publisher (holds a key, signs) or replica (keyless, re-announces). */
	role: HostRole;
	/** For replicas: where to fetch the publisher's exported record. */
	publisherEndpoint?: string;
}

/** A site entry as it appears in `pinnace.json`. */
export interface SiteConfig {
	/** The site name (its MFS entry under `/sites/<name>`). */
	name: string;
	/** ipfs (land+pin+MFS) or ipns (also publish/refresh). */
	mode: SiteMode;
	/** Frozen, internal KDF input for the per-site IPNS key. NOT the ENS name. */
	keyId: string;
	/** The (mutable) `<name>.eth` the site publishes under. */
	ensName?: string;
	/** The site source directory to build a CAR from. */
	sourceDir: string;
	/**
	 * An optional externally-owned key (the escape hatch): when set, this site's
	 * IPNS key is NOT derived from the master but supplied here.
	 */
	externalKey?: string;
}

/**
 * The typed `pinnace.json` shape. Note there is DELIBERATELY no `master` field
 * in the resolved config — see the module doc. If a raw file object carries a
 * stray `master`, it is ignored (never copied into the resolved config).
 */
export interface PinnaceConfigFile {
	hosts?: HostConfig[];
	sites?: SiteConfig[];
	/** Public gateways to warm (dweb.link, eth.limo, ...). */
	gateways?: string[];
}

/** The fully resolved config the rest of pinnace consumes. */
export interface ResolvedConfig {
	hosts: HostConfig[];
	sites: SiteConfig[];
	gateways: string[];
}

/** An env record (name → value). In production these come from `ldenv`. */
export type EnvRecord = Record<string, string | undefined>;

/** CLI overrides. Keyed by host name for per-host values. */
export interface CliOverrides {
	/** hostName → token override. */
	hostToken?: Record<string, string>;
	/** hostName → endpoint override. */
	hostEndpoint?: Record<string, string>;
	/** Gateways override (replaces the file/env list). */
	gateways?: string[];
}

/** Inputs to {@link resolveConfig}. */
export interface ResolveConfigInput {
	/** The parsed `pinnace.json` object (lowest precedence). */
	file: PinnaceConfigFile;
	/** The env layer (middle precedence). */
	env: EnvRecord;
	/** CLI args (highest precedence). */
	cli: CliOverrides;
}

/** Uppercase + non-alphanumeric → `_`, for building env var names. */
function envKey(...parts: string[]): string {
	return parts
		.map((p) => p.toUpperCase().replace(/[^A-Z0-9]+/g, '_'))
		.join('_');
}

/**
 * Resolve the full pinnace config with precedence CLI arg > env > file.
 *
 * A stray `master` field on the file object is NEVER read here — the master is
 * env-only via {@link resolveMasterSecret}.
 */
export function resolveConfig(input: ResolveConfigInput): ResolvedConfig {
	const {file, env, cli} = input;

	const hosts: HostConfig[] = (file.hosts ?? []).map((h) => {
		const token =
			cli.hostToken?.[h.name] ??
			env[envKey('PINNACE_HOST', h.name, 'TOKEN')] ??
			h.token;
		const endpoint =
			cli.hostEndpoint?.[h.name] ??
			env[envKey('PINNACE_HOST', h.name, 'ENDPOINT')] ??
			h.endpoint;
		return {...h, token, endpoint};
	});

	const gateways =
		cli.gateways ?? splitList(env['PINNACE_GATEWAYS']) ?? file.gateways ?? [];

	return {
		hosts,
		sites: file.sites ?? [],
		gateways,
	};
}

/** Split a comma-separated env list, or return undefined if unset/empty. */
function splitList(value: string | undefined): string[] | undefined {
	if (!value) return undefined;
	const list = value
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	return list.length > 0 ? list : undefined;
}

/** Inputs to {@link resolveMasterSecret}. */
export interface ResolveMasterInput {
	/** The env layer. This is the ONLY source of the master. */
	env: EnvRecord;
	/** The env var name to read (default `PINNACE_MASTER`). */
	envVar?: string;
}

/**
 * Resolve the master secret. It is read ONLY from env (there is deliberately no
 * `file` parameter): the master must never come from `pinnace.json`. Returns
 * undefined when the env var is unset.
 */
export function resolveMasterSecret(
	input: ResolveMasterInput,
): string | undefined {
	const envVar = input.envVar ?? 'PINNACE_MASTER';
	return input.env[envVar];
}
