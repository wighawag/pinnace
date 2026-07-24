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
 *
 * SECOND ENV-ONLY SECRET (the bearer TOKEN). A node's bearer `token` is the
 * SAME CLASS as the master: a secret that must NEVER live in `pinnace.json`.
 * So {@link HostConfig} has NO `token` field at all (structurally impossible to
 * leak one via config, exactly like the master), and the token is resolved
 * ONLY from `CLI > env(PINNACE_HOST_<NAME>_TOKEN)` by {@link resolveHostToken}.
 * A host with no resolvable token is a LOUD, specific error naming the missing
 * env var (never a silent `""` that turns into a downstream 401).
 *
 * EAGER-VS-LAZY (decided): the token failure is LAZY, not eager. `resolveConfig`
 * does NOT demand a token for every configured host up front (a host no
 * operation touches must not block unrelated work); instead a caller resolves a
 * host's token via {@link resolveHostToken} at the moment it actually builds
 * that host's client (deploy target / status client), so only hosts an
 * operation USES must have a token set. See the `## Decisions` block in the
 * done record.
 */

/** A node/host role. */
export type HostRole = 'publisher' | 'replica';

/** A per-site publish mode. */
export type SiteMode = 'ipfs' | 'ipns';

/**
 * A host/node entry as it appears in `pinnace.json`.
 *
 * NOTE there is DELIBERATELY no `token` field: the bearer token is env-only by
 * construction (see the module doc), resolved via {@link resolveHostToken}. A
 * stray `token` in a file object is ignored, exactly as a stray `master` is.
 */
export interface HostConfig {
	/** Stable host name (used to key env/CLI token + endpoint overrides). */
	name: string;
	/** The node's Kubo RPC endpoint. */
	endpoint: string;
	/** publisher (holds a key, signs) or replica (keyless, re-announces). */
	role: HostRole;
	/** For replicas: where to fetch the publisher's exported record. */
	publisherEndpoint?: string;
}

/**
 * A site entry as it appears in `pinnace.json`.
 *
 * A site is identified by ONE value: {@link SiteConfig.id}. It is BOTH the MFS
 * entry (`/sites/<id>`) AND the KDF input fed to the frozen derivation (see
 * `../derive/ipns-key-derivation.ts` / ADR-0001). There is no separate `name`
 * and no separate `keyId` — one `id` is the whole identity surface.
 */
export interface SiteConfig {
	/**
	 * The site's SINGLE identifier: both its MFS entry (`/sites/<id>`) and the KDF
	 * input for its per-site IPNS key. Frozen once a name is live (changing it
	 * moves the derived id, per ADR-0001). NOT the ENS name.
	 */
	id: string;
	/** ipfs (land+pin+MFS) or ipns (also publish/refresh). */
	mode: SiteMode;
	/** The site source directory to build a CAR from. */
	sourceDir: string;
	/**
	 * OPTIONAL eth.limo-warming hint: when set, the site is ALSO warmed via
	 * `https://<ensName>.limo`. It is NOT part of identity and NEVER an input to
	 * the key derivation — purely an opt-in warming lever.
	 */
	ensName?: string;
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
		const endpoint =
			cli.hostEndpoint?.[h.name] ??
			env[envKey('PINNACE_HOST', h.name, 'ENDPOINT')] ??
			h.endpoint;
		// The token is NOT resolved here — it is env-only and resolved lazily, per
		// host, at the moment an operation builds that host's client (see
		// resolveHostToken + the module doc). Copy only the non-secret fields.
		return {
			name: h.name,
			endpoint,
			role: h.role,
			...(h.publisherEndpoint !== undefined
				? {publisherEndpoint: h.publisherEndpoint}
				: {}),
		};
	});

	const gateways =
		cli.gateways ?? splitList(env['PINNACE_GATEWAYS']) ?? file.gateways ?? [];

	return {
		hosts,
		sites: file.sites ?? [],
		gateways,
	};
}

/**
 * The env var name a host's bearer token is read from: `PINNACE_HOST_<NAME>_TOKEN`
 * (uppercased, non-alphanumerics collapsed to `_`). Exposed so error messages
 * and callers name the EXACT var an operator must set.
 */
export function hostTokenEnvVar(hostName: string): string {
	return envKey('PINNACE_HOST', hostName, 'TOKEN');
}

/**
 * A loud, specific failure when a host has no resolvable bearer token. Names the
 * exact missing env var so the operator knows precisely what to set (never a
 * silent empty token / downstream 401).
 */
export class MissingHostTokenError extends Error {
	constructor(
		/** The host whose token could not be resolved. */
		readonly hostName: string,
		/** The exact env var that would supply it. */
		readonly envVar: string,
	) {
		super(
			`host '${hostName}' has no token; set ${envVar} ` +
				`(the token is env-only, never read from pinnace.json)`,
		);
		this.name = 'MissingHostTokenError';
	}
}

/** Inputs to {@link resolveHostToken}. */
export interface ResolveHostTokenInput {
	/** The host whose token to resolve (its `name` keys the env/CLI override). */
	hostName: string;
	/** The env layer (the ONLY file-less source of the token). */
	env: EnvRecord;
	/** CLI overrides (highest precedence): `hostToken[hostName]`. */
	cli?: CliOverrides;
}

/**
 * Resolve ONE host's bearer token with precedence `CLI > env` (there is
 * DELIBERATELY no file layer — the token is env-only, like the master). Throws
 * {@link MissingHostTokenError} (naming the exact env var) when neither layer
 * supplies it, so a missing token is a LOUD config error, never a silent `""`.
 *
 * Callers invoke this LAZILY — only for hosts an operation actually uses (see
 * the eager-vs-lazy decision in the module doc) — so a configured-but-unused
 * host never blocks unrelated work.
 */
export function resolveHostToken(input: ResolveHostTokenInput): string {
	const envVar = hostTokenEnvVar(input.hostName);
	const token = input.cli?.hostToken?.[input.hostName] ?? input.env[envVar];
	if (token === undefined || token === '') {
		throw new MissingHostTokenError(input.hostName, envVar);
	}
	return token;
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
