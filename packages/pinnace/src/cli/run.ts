/**
 * The CLI dispatch surface, separated from the executable shebang entry
 * (bin.ts) so it is unit-testable without spawning a process. It is a THIN
 * wrapper: it parses/validates args, resolves config (arg > env > file), calls
 * the core, and formats the result. ALL behaviour lives in the core (CONTEXT.md
 * `core vs cli`); nothing here re-implements domain logic.
 *
 * The client-facing verbs (provision, deploy, pin, install-ci, status, derive)
 * and the config/env layer dispatch through an injectable {@link RunContext} seam:
 *  - {@link RunContext.deps} are the core functions each verb calls (defaults to
 *    the real core; tests inject stubs to assert dispatch + resolved args),
 *  - {@link RunContext.env} + {@link RunContext.loadConfigFile} are the env and
 *    `pinnace.json` layers (defaults read the real `process.env` + file; tests
 *    inject in-memory values so the operator's real environment/config is never
 *    read or mutated — mirroring the `NodeCommandOps` injectable-ops pattern in
 *    node-commands and the explicit-`env` resolver in config-resolution).
 *
 * The on-box `pinnace node <verb>` and the `pinnace site <verb>` namespaces,
 * the `authorize` verb, dispatch through the SAME {@link RunContext}/
 * {@link ClientDeps} seam (they are NOT a forked dispatch idiom): the on-box
 * `node` verbs assemble a {@link NodeCommandContext} from the box env
 * (`/etc/pinnace-node.env`, exported into `process.env` by the systemd timer's
 * `EnvironmentFile`) and call the core `runNodeCommand`; `site`/`authorize`
 * assemble per-host {@link KuboRpcClient}s from the resolved config and call
 * the site / authorize core.
 */
import {readFileSync} from 'node:fs';
import {name} from '../index.js';
import {
	NODE_VERBS,
	runNodeCommand as coreRunNodeCommand,
	type NodeVerb,
	type NodeCommandContext,
	type NodeCommandResult,
} from '../node/node-commands.js';
import {
	SITE_VERBS,
	listSites as coreListSites,
	removeSite as coreRemoveSite,
	addSite as coreAddSite,
	type SiteVerb,
	type ListSitesInput,
	type SiteListing,
	type RemoveSiteInput,
	type RemoveSiteResult,
	type AddSiteInput,
	type AddSiteResult,
} from '../site/site-management.js';
import {
	assertEnsNameIntent,
	EnsNameInferenceError,
	DEFAULT_SITE_MODE,
	type EnsNameIntent,
	type SiteModeIntent,
} from '../site/site-wrapper.js';
import {makeStatusOp} from '../status/status-report.js';
import {
	authorizePublisher as coreAuthorizePublisher,
	AuthorizeSecondSignerError,
	type AuthorizeInput,
	type AuthorizeResult,
	type AuthorizeHost,
} from '../publisher/authorize.js';
import {KeyImportRoleError} from '../publisher/key-import.js';
import {
	deriveIpnsKey as coreDeriveIpnsKey,
	type DeriveIpnsInput as DeriveIpnsKeyInput,
	type DerivedIpnsKey,
} from '../derive/ipns-key-derivation.js';
import {KuboRpcClient} from '../rpc/kubo-rpc-client.js';
import {
	provision as coreProvision,
	type ProvisionInput,
	type ProvisionResult,
	type HostName,
} from '../provision/cloud-init.js';
import {
	deploy as coreDeploy,
	DeployDerivedKeyRequiredError,
	DeployPublisherRequiredError,
	type DeployInput,
	type DeployResult,
	type DeployTarget,
} from '../deploy/deploy.js';
import {
	pinExternal as corePinExternal,
	PinSourceResolveError,
	PinDerivedKeyRequiredError,
	type PinExternalInput,
	type PinExternalResult,
	type PinTarget,
} from '../pin/pin-external.js';
import {
	emitCi as coreEmitCi,
	type EmitCiInput,
	type EmittedCi,
	type CiSystem,
} from '../ci/ci-emit.js';
import {
	statusReport as coreStatusReport,
	type StatusReportInput,
	type StatusReport,
} from '../status/status-report.js';
import {
	deriveIpnsId as coreDeriveIpnsId,
	type DeriveIpnsInput,
} from '../derive/ipns-key-derivation.js';
import {
	resolveConfig,
	resolveMasterSecret,
	resolveHostToken,
	MissingHostTokenError,
	type PinnaceConfigFile,
	type EnvRecord,
	type CliOverrides,
	type HostRole,
} from '../config/config-resolution.js';

/**
 * The core functions the client verbs dispatch to. This seam is what makes the
 * CLI a THIN wrapper AND independently testable: production wires the real core
 * ({@link DEFAULT_DEPS}); tests inject recording stubs and assert each verb
 * calls the RIGHT function with the correctly-resolved arguments (rather than
 * re-testing the core through the CLI).
 */
export interface ClientDeps {
	/** `provision` -> the cloud-init generator. */
	provision(input: ProvisionInput): ProvisionResult;
	/** `deploy` -> the multi-target CAR deploy. */
	deploy(input: DeployInput): Promise<DeployResult>;
	/** `install-ci` -> the CI workflow emitter. */
	emitCi(input: EmitCiInput): EmittedCi;
	/** `status` -> the per-site status report. */
	statusReport(input: StatusReportInput): Promise<StatusReport>;
	/** `derive` -> the master + site `id` -> IPNS id derivation (no deploy). */
	deriveIpnsId(input: DeriveIpnsInput): string;
	/** `pin` -> fetch + pin an EXTERNAL CID across nodes and track it in MFS. */
	pinExternal(input: PinExternalInput): Promise<PinExternalResult>;
	/** `node <verb>` -> the on-box command runner (context assembled by the CLI). */
	runNodeCommand(
		verb: NodeVerb,
		ctx: NodeCommandContext,
	): Promise<NodeCommandResult>;
	/** `site list` -> enumerate the node's MFS sites. */
	listSites(input: ListSitesInput): Promise<SiteListing[]>;
	/** `site remove` -> drop an MFS site + unpin its content. */
	removeSite(input: RemoveSiteInput): Promise<RemoveSiteResult>;
	/** `site add` -> place an already-imported CID into MFS as a site. */
	addSite(input: AddSiteInput): Promise<AddSiteResult>;
	/** `deploy`/`pin`/`authorize` -> the per-site key material from master + `id`. */
	deriveIpnsKey(input: DeriveIpnsKeyInput): DerivedIpnsKey;
	/** `authorize` -> grant the declared publisher the site key(s), idempotently. */
	authorizePublisher(input: AuthorizeInput): Promise<AuthorizeResult>;
}

/** The real core, used when a caller does not inject stubs. */
const DEFAULT_DEPS: ClientDeps = {
	provision: coreProvision,
	deploy: coreDeploy,
	emitCi: coreEmitCi,
	statusReport: coreStatusReport,
	deriveIpnsId: coreDeriveIpnsId,
	pinExternal: corePinExternal,
	runNodeCommand: coreRunNodeCommand,
	listSites: coreListSites,
	removeSite: coreRemoveSite,
	addSite: coreAddSite,
	deriveIpnsKey: coreDeriveIpnsKey,
	authorizePublisher: coreAuthorizePublisher,
};

/**
 * The CLI run context: the injectable env/config/output/core seams. Everything
 * is optional; omitted fields default to the real process environment, a real
 * `pinnace.json` read, `console` sinks, and the real core. Tests pass explicit
 * in-memory values to stay hermetic.
 */
export interface RunContext {
	/** The env layer (defaults to `process.env`). Tests pass an in-memory record. */
	env?: EnvRecord;
	/**
	 * Load the parsed config file (defaults to reading `./pinnace.json`, or an
	 * empty config if absent). Tests pass an in-memory object.
	 *
	 * `path` is the operator's explicit `--config <path>` when given, else
	 * `undefined` (the `./pinnace.json` default). The default loader treats an
	 * ABSENT default file as a benign empty config, but an explicitly-named path
	 * that is missing / unreadable / invalid JSON must THROW so `run()` can fail
	 * loud naming that path (an operator-named file is a claim it exists).
	 */
	loadConfigFile?: (path?: string) => PinnaceConfigFile;
	/** The core functions to dispatch to (defaults to the real core). */
	deps?: ClientDeps;
	/** stdout sink (defaults to `console.log`). */
	out?: (line: string) => void;
	/** stderr sink (defaults to `console.error`). */
	err?: (line: string) => void;
}

/** A resolved run context: every seam filled in with its default if omitted. */
interface ResolvedRunContext {
	env: EnvRecord;
	file: PinnaceConfigFile;
	deps: ClientDeps;
	out: (line: string) => void;
	err: (line: string) => void;
	/**
	 * The GLOBAL `--endpoint <url>` when the operator gave one (never `''`: a
	 * bare flag is refused in {@link run} before we get here). It is stripped
	 * from the argv, so the verbs read it from HERE rather than from their own
	 * parsed flags, and it reaches the resolver through
	 * {@link cliOverridesFromFlags}.
	 */
	endpoint?: string;
}

/**
 * The GLOBAL flags, stripped off the argv before the command is read: they may
 * appear on EITHER side of the verb (`pinnace --endpoint <url> status` and
 * `pinnace status --endpoint <url>` are the same invocation).
 */
interface GlobalFlags {
	/** `--config <path>`: which `pinnace.json` is the file layer. */
	configPath?: string;
	/** `--endpoint <url>`: the single node this run acts on. */
	endpoint?: string;
}

/**
 * Load a config file.
 *
 * With NO explicit path (`--config` absent), read `./pinnace.json` if present;
 * its ABSENCE (or an unreadable/invalid default file) stays a benign empty
 * config, because a config file is optional.
 *
 * With an EXPLICIT `path` (the operator typed `--config <path>`), the file MUST
 * exist and parse: a missing / unreadable / invalid-JSON named path THROWS
 * (naming the path) so the caller fails loud rather than silently emptying the
 * config — an operator who named a file has claimed it exists.
 */
function defaultLoadConfigFile(path?: string): PinnaceConfigFile {
	if (path === undefined) {
		try {
			return JSON.parse(
				readFileSync('pinnace.json', 'utf8'),
			) as PinnaceConfigFile;
		} catch {
			return {};
		}
	}
	let raw: string;
	try {
		raw = readFileSync(path, 'utf8');
	} catch (cause) {
		throw new ConfigLoadError(path, 'read', cause);
	}
	try {
		return JSON.parse(raw) as PinnaceConfigFile;
	} catch (cause) {
		throw new ConfigLoadError(path, 'parse', cause);
	}
}

/**
 * An explicitly-named `--config <path>` could not be read or parsed. Names the
 * path so `run()` can emit a loud, operator-actionable error (exit 1) instead
 * of silently resolving to an empty config.
 */
export class ConfigLoadError extends Error {
	constructor(
		readonly path: string,
		readonly kind: 'read' | 'parse',
		cause?: unknown,
	) {
		const detail = kind === 'read' ? 'read' : 'parse';
		super(`failed to ${detail} config file '${path}'`, {cause});
		this.name = 'ConfigLoadError';
	}
}

/**
 * Fill in the run context defaults (real env/file/core/console) once, loading
 * the config from `globals.configPath` (the operator's explicit `--config`, or
 * `undefined` for the `./pinnace.json` default) through the loader seam, and
 * carrying the global `--endpoint` through to the verbs.
 */
function resolveContext(
	context: RunContext,
	globals: GlobalFlags,
): ResolvedRunContext {
	return {
		env: context.env ?? (process.env as EnvRecord),
		file: (context.loadConfigFile ?? defaultLoadConfigFile)(globals.configPath),
		deps: context.deps ?? DEFAULT_DEPS,
		out: context.out ?? ((line) => console.log(line)),
		err: context.err ?? ((line) => console.error(line)),
		...(globals.endpoint !== undefined ? {endpoint: globals.endpoint} : {}),
	};
}

/**
 * Dispatch a pinnace CLI invocation. Returns the process exit code.
 *
 * Routes the client verbs (provision/deploy/pin/install-ci/status/derive), the
 * on-box `node` namespace, and the `site` namespace. A missing command is a
 * benign no-op (exit 0); an UNKNOWN command is loud (exit 1) so the surface is
 * an explicit allow-list, not a silent catch-all.
 *
 * Two GLOBAL flags may appear on EITHER side of the command and are consumed
 * here (stripped from the per-verb argv):
 *  - `--config <path>` is threaded into config loading via the
 *    {@link RunContext.loadConfigFile} seam. With no `--config`, the default
 *    `./pinnace.json` is read and its absence is benign; an explicitly-named
 *    path that is missing/unreadable/invalid JSON fails loud (names the path,
 *    exit 1).
 *  - `--endpoint <url>` is carried on {@link ResolvedRunContext.endpoint} to the
 *    verbs. A BARE or REPEATED one is a loud usage error here, BEFORE any
 *    config is loaded or any verb runs ({@link takeEndpointFlag}).
 */
export async function run(
	argv: readonly string[],
	context: RunContext = {},
): Promise<number> {
	// --endpoint is stripped FIRST so its bare form is judged against what the
	// operator actually typed: after --config were stripped, a bare
	// `--endpoint --config <path>` would look like `--endpoint <path>`.
	const endpointFlag = takeEndpointFlag(argv);
	const err = context.err ?? ((line) => console.error(line));
	if (endpointFlag.error !== undefined) {
		// A usage error, refused before any file/network work: the operator typed a
		// targeting instruction we cannot honour, so nothing runs.
		err(`${name()}: ${endpointFlag.error}`);
		return 1;
	}
	const {configPath, rest: postGlobal} = takeConfigFlag(endpointFlag.rest);

	let rc: ResolvedRunContext;
	try {
		rc = resolveContext(context, {
			configPath,
			...(endpointFlag.endpoint !== undefined
				? {endpoint: endpointFlag.endpoint}
				: {}),
		});
	} catch (cause) {
		// A loud, path-named failure only ever comes from an EXPLICIT --config;
		// the default loader swallows an absent ./pinnace.json into an empty config.
		if (cause instanceof ConfigLoadError) {
			err(`${name()}: ${cause.message}`);
			return 1;
		}
		throw cause;
	}
	const [command, ...rest] = postGlobal;

	if (command === undefined) {
		rc.out(`${name()}: no command given`);
		return 0;
	}
	if (command === 'version' || command === '--version' || command === '-v') {
		rc.out(name());
		return 0;
	}
	if (command === 'node') {
		return runNodeCli(rest, rc);
	}
	if (command === 'site') {
		return runSiteCli(rest, rc);
	}
	if (command === 'provision') {
		return runProvision(rest, rc);
	}
	if (command === 'deploy') {
		return runDeploy(rest, rc);
	}
	if (command === 'install-ci') {
		return runInstallCi(rest, rc);
	}
	if (command === 'status') {
		return runStatus(rest, rc);
	}
	if (command === 'derive' || command === 'ipns-id') {
		return runDerive(rest, rc);
	}
	if (command === 'pin') {
		return runPin(rest, rc);
	}
	if (command === 'authorize') {
		return runAuthorize(rest, rc);
	}

	rc.err(`${name()}: unknown command '${command}'`);
	return 1;
}

// ---------------------------------------------------------------------------
// Minimal arg parsing (flags + positionals). Kept tiny + local: the CLI is a
// parse/format layer, so a full arg-parsing dependency would be over-weight.
// ---------------------------------------------------------------------------

/**
 * Split the GLOBAL `--config <path>` flag off the front of the argv.
 *
 * `--config` is a global (not a per-verb) flag: it may precede the command and
 * MUST be stripped before the argv reaches a verb parser, or a per-verb parser
 * would mis-read `--config`/its path as one of its own flags/positionals. This
 * scans the WHOLE argv (so `--config` before the command is found) and removes
 * the flag and its value, returning the chosen path (`undefined` if absent).
 * Only the last `--config` wins if repeated. A trailing `--config` with no
 * value yields an empty path, which the loader then fails loud on.
 */
function takeConfigFlag(argv: readonly string[]): {
	configPath?: string;
	rest: string[];
} {
	const rest: string[] = [];
	let configPath: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--config') {
			const next = argv[i + 1];
			configPath = next !== undefined && !next.startsWith('--') ? next : '';
			if (next !== undefined && !next.startsWith('--')) i++;
			continue;
		}
		rest.push(argv[i]);
	}
	return {configPath, rest};
}

/**
 * Split the GLOBAL `--endpoint <url>` flag off the argv, the way
 * {@link takeConfigFlag} splits `--config`.
 *
 * `--endpoint` READS as global (it names the one node the whole run acts on),
 * so it is accepted on EITHER side of the command: scanning the WHOLE argv is
 * what makes `pinnace --endpoint <url> status` and `pinnace status --endpoint
 * <url>` the same invocation (before this, the leading form died with a
 * misleading `unknown command '--endpoint'`). Stripping it also keeps a verb
 * parser from mis-reading the flag or its url as one of its own
 * flags/positionals. What the flag MEANS is untouched: it is still the arg tier
 * of {@link CliOverrides.endpoint} (arg > env > file), replacing the file's
 * hosts for the run.
 *
 * Two shapes are refused LOUDLY instead of being resolved to something the
 * operator did not type (returned as an `error` string for {@link run} to
 * print, so this stays a pure function):
 *  - a BARE flag (end of argv, immediately followed by another `--flag`, or an
 *    explicit empty value): a flag the operator typed must never mean nothing.
 *    Silently dropping it WIDENED the run back to every host in `pinnace.json`,
 *    i.e. discarded a narrowing instruction and still succeeded.
 *  - a REPEATED flag (typically one before AND one after the verb): there is no
 *    honest winner, even when the two values are identical, so neither is
 *    picked. (`--config` still takes its LAST occurrence: the two globals
 *    differ here on purpose, and the reasoning — with the flag-order one, and
 *    why the verbs that touch no node accept this flag and ignore it — is in
 *    `work/notes/observations/endpoint-flag-loud-and-global-decisions.md`.)
 */
function takeEndpointFlag(argv: readonly string[]): {
	endpoint?: string;
	rest: string[];
	error?: string;
} {
	const rest: string[] = [];
	let endpoint: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] !== '--endpoint') {
			rest.push(argv[i]);
			continue;
		}
		// The same no-value convention parseArgs uses, applied BEFORE the value is
		// swallowed: only a non-flag token is this flag's value.
		const next = argv[i + 1];
		const hasValue = next !== undefined && !next.startsWith('--');
		const value = hasValue ? next : undefined;
		if (hasValue) i++;
		if (value === undefined || value === '') {
			return {
				rest,
				error:
					"--endpoint needs a value: the node's Kubo RPC url, as " +
					'--endpoint <url> (before or after the command); drop the flag to ' +
					'act on the hosts in pinnace.json',
			};
		}
		if (endpoint !== undefined) {
			return {
				rest,
				error:
					`--endpoint given more than once ('${endpoint}' and '${value}'); ` +
					'it names the ONE node this run acts on, so pass it exactly once ' +
					'(either side of the command)',
			};
		}
		endpoint = value;
	}
	return {...(endpoint !== undefined ? {endpoint} : {}), rest};
}

/** A parsed argv split into `--flag value` map + bare positionals. */
interface ParsedArgs {
	flags: Record<string, string>;
	positionals: string[];
}

/**
 * Parse `--flag value` pairs and positionals. Flags are long-form only
 * (`--host hetzner`); a `--flag` at the end with no value is treated as `''`.
 * Positionals are everything that is not a flag or a flag value.
 *
 * `booleanFlags` names the flags that take NO value (`--no-recursive`): without
 * that list a value-taking parser would swallow the following positional as the
 * flag's value (`pin --no-recursive <cid>` would lose the CID). Omitted =>
 * every flag is value-taking, so the other verbs are unaffected.
 */
function parseArgs(
	argv: readonly string[],
	booleanFlags: readonly string[] = [],
): ParsedArgs {
	const flags: Record<string, string> = {};
	const positionals: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (token.startsWith('--')) {
			const key = token.slice(2);
			if (booleanFlags.includes(key)) {
				flags[key] = 'true';
				continue;
			}
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith('--')) {
				flags[key] = next;
				i++;
			} else {
				flags[key] = '';
			}
		} else {
			positionals.push(token);
		}
	}
	return {flags, positionals};
}

// ---------------------------------------------------------------------------
// Client verbs — each: parse/validate -> resolve config -> call core -> format.
// ---------------------------------------------------------------------------

/**
 * `provision --host <h> --api-domain <d> --acme-email <e> --bearer-token <t>
 * --role <r> [--pinnace-version <v>] [--node-major <n>] [--kubo-version <v>]
 * [...]` -> core {@link ClientDeps.provision}. Purely arg-driven (provisioning
 * inputs are per-box and not stored in `pinnace.json`); prints the generated
 * cloud-init to stdout. The pinned pinnace/Node/Kubo versions default to the
 * generator's named knobs and are overridable per-box via these flags.
 */
function runProvision(argv: readonly string[], rc: ResolvedRunContext): number {
	const {flags} = parseArgs(argv);
	if (!refuseBareFlags('pinnace provision', flags, rc)) return 1;
	const host = flags['host'];
	const apiDomain = flags['api-domain'];
	const acmeEmail = flags['acme-email'];
	const bearerToken = flags['bearer-token'];
	const role = flags['role'];
	const missing = missingFlags({
		host,
		'api-domain': apiDomain,
		'acme-email': acmeEmail,
		'bearer-token': bearerToken,
		role,
	});
	if (missing.length > 0) {
		rc.err(
			`pinnace provision: missing required flag(s): ${missing.join(', ')}`,
		);
		return 1;
	}
	if (role !== 'publisher' && role !== 'replica') {
		rc.err(`pinnace provision: --role must be 'publisher' or 'replica'`);
		return 1;
	}

	const input: ProvisionInput = {
		host: host as HostName,
		apiDomain,
		acmeEmail,
		bearerToken,
		role: role as HostRole,
	};
	if (flags['dashboard-domain'])
		input.dashboardDomain = flags['dashboard-domain'];
	if (flags['publisher-endpoint'])
		input.publisherEndpoint = flags['publisher-endpoint'];
	if (flags['kubo-version']) input.kuboVersion = flags['kubo-version'];
	if (flags['pinnace-version']) input.pinnaceVersion = flags['pinnace-version'];
	if (flags['node-major']) input.nodeMajor = flags['node-major'];

	const result = rc.deps.provision(input);
	rc.out(result.cloudInit.contents);
	return 0;
}

/**
 * `deploy [--set-mode <m>] [--set-ens-name [<name>] | --unset-ens-name] <dir>
 * <id>` -> core {@link ClientDeps.deploy}. Resolves every configured host into a
 * {@link DeployTarget} (each host's OWN token resolved env-only, LAZILY, via
 * {@link resolveHostToken} — CLI > env, no file). A host with no resolvable
 * token FAILS LOUD naming its exact env var. Prints the resulting CID /
 * per-node breakdown.
 *
 * MODE SOURCE (the whole order): `--set-mode` > the site's STORED MFS
 * `metadata.json` mode > `{@link DEFAULT_SITE_MODE}`. There is no config source:
 * `pinnace.json` is infra-only, and the durable per-site home of `mode` is the
 * site's metadata, which the core reads (from the publisher) and rewrites. So
 * OMITTING `--set-mode` PRESERVES — exactly like omitting `--set-ens-name` —
 * and the CLI simply states nothing; only an INVALID value is an unresolved
 * mode: a loud refusal naming the site, never a guess.
 *
 * `ipns` MODE PROVISIONS ITS OWN KEY (the same policy `pin --set-mode ipns`
 * has). The key is derived from the env-ONLY master + the site `id` (the single
 * `id` IS the KDF input, as for `derive`/`authorize`/`pin`) and handed to the
 * core, which imports it onto a publisher that holds none. The CLI derives
 * OPTIMISTICALLY — whenever a master is available and the resolved mode COULD be
 * `ipns` — because only the core knows the site's stored mode and what the
 * publisher's keystore holds. Unlike `pin`, a missing master is NOT refused
 * here: a publisher that already holds the key signs with no master in sight,
 * which is exactly how CI deploys. The core makes the loud, pre-flight refusals
 * ({@link DeployDerivedKeyRequiredError}, {@link DeployPublisherRequiredError}),
 * which this prints as a plain exit-1 error.
 *
 * The two ensName verb-flags ({@link ensNameIntentFromFlags}) decide what the
 * deploy writes into the site's MFS `metadata.json`; omitting them leaves the
 * site's existing `ensName` untouched.
 */
async function runDeploy(
	argv: readonly string[],
	rc: ResolvedRunContext,
): Promise<number> {
	const {flags, positionals} = parseArgs(argv, ENS_NAME_BOOLEAN_FLAGS);
	if (!refuseBareFlags('pinnace deploy', flags, rc)) return 1;
	const [dir, siteId] = positionals;
	if (!dir || !siteId) {
		rc.err(
			'pinnace deploy: usage: pinnace deploy [--set-mode ipfs|ipns] ' +
				'[--set-ens-name [<name>] | --unset-ens-name] <dir> <id>',
		);
		return 1;
	}
	const ensName = ensNameIntent('pinnace deploy', flags, siteId, rc);
	if (!ensName) return 1; // ensNameIntent already emitted the loud error.
	// The site's mode: --set-mode > the STORED mode > the default. Only the first
	// tier is the CLI's business; stating nothing is the PRESERVE intent, which
	// the core resolves against the site's MFS metadata.
	const mode = siteModeIntentFromFlags('pinnace deploy', flags, siteId, rc);
	if (!mode) return 1; // siteModeIntentFromFlags already emitted the error.

	const cli = cliOverridesFromFlags(flags, rc.endpoint);
	const cfg = resolveConfig({file: rc.file, env: rc.env, cli});
	if (cfg.hosts.length === 0) {
		rc.err(`pinnace deploy: ${NO_HOSTS_HINT}`);
		return 1;
	}

	// Resolve each host's token env-only (LAZY: only the hosts this deploy uses).
	// A missing token is a loud named error, never a silent "" / downstream 401.
	let targets: DeployTarget[];
	try {
		targets = cfg.hosts.map((h) => ({
			baseUrl: h.endpoint,
			token: resolveHostToken({hostName: h.name, env: rc.env, cli}),
			role: h.role,
		}));
	} catch (error) {
		if (error instanceof MissingHostTokenError) {
			rc.err(`pinnace deploy: ${error.message}`);
			return 1;
		}
		throw error;
	}
	// The key material a resolved `ipns` mode may need, mirroring `pin`: a purely
	// local KDF over the env-ONLY master (no node contact), derived WHENEVER it
	// could be used, because only the CORE (which reads the site's stored mode and
	// the publisher's keystore) knows whether it is needed. A stated `ipfs` deploy
	// derives nothing at all.
	//
	// Deliberately UNLIKE `pin`, an unset master is NOT a CLI refusal here: the
	// publisher may ALREADY hold the key, which is the CI path (`--set-mode ipns`
	// with no master must keep working). The core refuses loudly
	// ({@link DeployDerivedKeyRequiredError}) only when the key is genuinely
	// missing AND unavailable.
	let derived: DerivedIpnsKey | undefined;
	if (mode.kind === 'preserve' || mode.mode === 'ipns') {
		const master = resolveMasterSecret({env: rc.env});
		// The single `id` IS the site id AND the KDF input (as derive/authorize/pin).
		if (master) derived = rc.deps.deriveIpnsKey({master, keyId: siteId});
	}

	const input: DeployInput = {
		sourceDir: dir,
		id: siteId,
		...(mode.kind === 'set' ? {mode: mode.mode} : {}),
		targets,
		ensName,
		...(derived ? {derived} : {}),
	};

	let result: DeployResult;
	try {
		result = await rc.deps.deploy(input);
	} catch (error) {
		// The two `ipns`-mode refusals the CLI cannot pre-check, because both rest
		// on what only the NODES can answer (the site's stored mode, and whether the
		// publisher already holds the key). Both are pre-flight in the core, so
		// nothing was written anywhere.
		if (
			error instanceof DeployDerivedKeyRequiredError ||
			error instanceof DeployPublisherRequiredError
		) {
			rc.err(`pinnace deploy: ${error.message}`);
			return 1;
		}
		throw error;
	}
	rc.out(`cid: ${result.cid}`);
	for (const ok of result.ok) {
		rc.out(
			`  ok  ${ok.baseUrl}${ok.published && ok.ipns ? ` (ipns ${ok.ipns})` : ''}`,
		);
	}
	for (const failure of result.failed) {
		rc.err(`  FAIL ${failure.baseUrl}: ${failure.error.message}`);
	}
	return result.success ? 0 : 1;
}

/**
 * `install-ci --system <s> --build-command <c> --output-dir <d> [--branch <b>]
 * [--node-version <v>]` -> core {@link ClientDeps.emitCi}. Prints the workflow
 * path/contents and reports the secrets/vars the operator must set.
 */
function runInstallCi(argv: readonly string[], rc: ResolvedRunContext): number {
	const {flags} = parseArgs(argv);
	if (!refuseBareFlags('pinnace install-ci', flags, rc)) return 1;
	const system = flags['system'];
	const buildCommand = flags['build-command'];
	const outputDir = flags['output-dir'];
	const missing = missingFlags({
		system,
		'build-command': buildCommand,
		'output-dir': outputDir,
	});
	if (missing.length > 0) {
		rc.err(
			`pinnace install-ci: missing required flag(s): ${missing.join(', ')}`,
		);
		return 1;
	}

	const input: EmitCiInput = {
		system: system as CiSystem,
		buildCommand,
		outputDir,
	};
	if (flags['branch']) input.branch = flags['branch'];
	if (flags['node-version']) input.nodeVersion = flags['node-version'];

	const emitted = rc.deps.emitCi(input);
	rc.out(`workflow: ${emitted.workflow.path}`);
	rc.out(emitted.workflow.contents);
	if (emitted.secrets.length > 0) {
		rc.out('Required secrets (Settings -> Secrets):');
		for (const s of emitted.secrets) rc.out(`  ${s.name} — ${s.description}`);
	}
	if (emitted.vars.length > 0) {
		rc.out('Required variables (Settings -> Variables):');
		for (const v of emitted.vars) rc.out(`  ${v.name} — ${v.description}`);
	}
	return 0;
}

/**
 * `status` -> core {@link ClientDeps.statusReport}, once per configured host
 * (each node reports its OWN sites). Builds each node's Kubo client from the
 * resolved endpoint + token and prints the per-site report.
 */
async function runStatus(
	argv: readonly string[],
	rc: ResolvedRunContext,
): Promise<number> {
	const {flags} = parseArgs(argv);
	if (!refuseBareFlags('pinnace status', flags, rc)) return 1;
	const cli = cliOverridesFromFlags(flags, rc.endpoint);
	const cfg = resolveConfig({file: rc.file, env: rc.env, cli});
	if (cfg.hosts.length === 0) {
		rc.err(`pinnace status: ${NO_HOSTS_HINT}`);
		return 1;
	}

	for (const host of cfg.hosts) {
		let token: string;
		try {
			// Env-only token, resolved LAZILY per host actually used (see deploy).
			token = resolveHostToken({hostName: host.name, env: rc.env, cli});
		} catch (error) {
			if (error instanceof MissingHostTokenError) {
				rc.err(`pinnace status: ${error.message}`);
				return 1;
			}
			throw error;
		}
		const client = new KuboRpcClient({baseUrl: host.endpoint, token});
		const report = await rc.deps.statusReport({client});
		rc.out(`${host.name} (${host.endpoint}) peer ${report.peerId}`);
		for (const site of report.sites) {
			rc.out(
				`  ${site.id}: cid ${site.cid}${site.ipns ? ` ipns ${site.ipns}` : ''}` +
					` mode ${site.mode ?? 'unset'} ensName ${printedEnsName(site.ensName)}` +
					` eth.limo ${site.ensNameToWarm ? `${site.ensNameToWarm}.limo` : 'none'}` +
					` announced=${site.announced} gatewayServes=${site.gatewayServes}`,
			);
		}
	}
	return 0;
}

/**
 * How `status` PRINTS the three-valued stored `ensName`, keeping all three
 * apart on one line: a stored name prints as itself, `""` prints `opted-out`
 * (never warm, even a `.eth` id) and an absent field prints `unset` (the box
 * infers from a `.eth` id). Printing `""` as a bare empty string would read as
 * a rendering bug and erase the very distinction the metadata preserves.
 */
function printedEnsName(ensName: string | undefined): string {
	if (ensName === undefined) return 'unset';
	return ensName === '' ? 'opted-out' : ensName;
}

/**
 * `derive <id>` (a.k.a. `ipns-id`) -> core {@link ClientDeps.deriveIpnsId}.
 * Prints the site's `k51...` IPNS id from the master + the site's single `id`
 * (the KDF input), with NO deploy (user story 22). The master is env-ONLY (via
 * {@link resolveMasterSecret}); the `id` is the positional argument VERBATIM —
 * there is nothing to look it up in (sites are not a config surface) and
 * nothing to look up (the id IS the KDF input). Needs no config file at all.
 * Fails loudly if the master is unset.
 */
function runDerive(argv: readonly string[], rc: ResolvedRunContext): number {
	const {flags, positionals} = parseArgs(argv);
	if (!refuseBareFlags('pinnace derive', flags, rc)) return 1;
	const [siteId] = positionals;
	if (!siteId) {
		rc.err('pinnace derive: usage: pinnace derive <id>');
		return 1;
	}

	const master = resolveMasterSecret({env: rc.env});
	if (!master) {
		rc.err(
			'pinnace derive: master secret not set — export PINNACE_MASTER (env-only; never read from pinnace.json)',
		);
		return 1;
	}

	// The single `id` IS the KDF input: the positional is fed straight in.
	const printed = rc.deps.deriveIpnsId({master, keyId: siteId});
	rc.out(printed);
	return 0;
}

/** The two forms of the `pin` verb: one source each, never both, never neither. */
const PIN_USAGE =
	'usage: pinnace pin <cid> --as <name> [--set-mode ipfs|ipns] [--host <name>] [--no-recursive] [--set-ens-name [<name>] | --unset-ens-name]\n' +
	'   or: pinnace pin --from-ipns <source-ipns-name> --as <name> [--set-mode ipfs|ipns] [--host <name>] [--no-recursive] [--set-ens-name [<name>] | --unset-ens-name]';

/**
 * `pin <cid> --as <name> [--set-mode ipfs|ipns] [--host <name>] [--no-recursive]` ->
 * core {@link ClientDeps.pinExternal}. Pins an EXTERNAL network CID (content the
 * operator has only the CID for) on EVERY configured node by default — the same
 * redundancy `deploy` gives — and tracks it in MFS at `/sites/<name>` so it
 * shows on the dashboard and gets gateway-warmed.
 *
 * A pin takes EXACTLY ONE source, the positional `<cid>` XOR `--from-ipns
 * <name>`; giving both or neither is a usage error. `--from-ipns` MIGRATES from
 * an existing IPNS name: the core resolves that SOURCE name to the cid it points
 * at right now and pins THAT (reported as `resolved ipns <src> -> <cid>`), so
 * `pin --from-ipns <src> --as ronan --set-mode ipns` is the one-command ENS
 * migration: the source's current content on the operator's nodes, published
 * under the OPERATOR's own `ipns://<id>`. It is a SNAPSHOT, not a follow: the CLI
 * says so, and pulling a newer one is re-running the same command (the name is
 * stable; only the cid it points at moves). A source name that resolves nowhere
 * is a loud {@link PinSourceResolveError} (exit 1), never a silent success.
 *
 * `--set-mode` is the SAME per-site mode `deploy` takes (CONTEXT.md `mode`),
 * resolved the same way: stating nothing PRESERVES what the entry is already
 * stored under, and only an entry storing none is `ipfs` (pin + MFS only; the
 * pin is addressed by the immutable `ipfs://<cid>`). `--set-mode ipns` ADDS the
 * operator's OWN stable name for the
 * mirrored content: the key derived from the env-ONLY master + the `--as <name>`
 * id (the same single-`id`-is-the-KDF-input rule as `derive`/`authorize`) is
 * imported onto the PUBLISHER, which then signs `name/publish` for the pinned
 * cid. Re-pinning a newer cid under the same name moves that name.
 *
 * Two loud refusals guard a STATED ipns path HERE, before the core is called,
 * so the message can name what the operator typed: an unset master (env-only,
 * never from `pinnace.json`), and a target set with no publisher in it (`--host`
 * a replica, or a publisher-less config) — a replica is keyless and never signs.
 * The core repeats the second check for library callers
 * ({@link PinPublisherRequiredError}). When the mode is PRESERVED instead, only
 * the core (which reads the stored metadata) knows whether a key is needed, so
 * the CLI derives it WHENEVER a master is available — a purely local KDF, no
 * node contact — and the core refuses loudly
 * ({@link PinDerivedKeyRequiredError}) if a preserved `ipns` entry has none.
 *
 * `--host <name>` NARROWS the fan-out to that one node (note this differs from
 * `site`, where `--host` SELECTS the single node it acts on and is required
 * with several hosts, and from `authorize`, which takes no `--host` at all;
 * here omitting it means ALL nodes, matching `deploy`). Each host's token is resolved env-only and LAZILY, so a host with
 * no resolvable token fails loud naming its exact env var. `--no-recursive`
 * pins the root block only. Exit code follows the core's `success` (a non-empty
 * success subset is still success).
 */
async function runPin(
	argv: readonly string[],
	rc: ResolvedRunContext,
): Promise<number> {
	const {flags, positionals} = parseArgs(argv, [
		'no-recursive',
		...ENS_NAME_BOOLEAN_FLAGS,
	]);
	if (!refuseBareFlags('pinnace pin', flags, rc)) return 1;
	const [cid] = positionals;
	const fromIpns = flags['from-ipns'];
	const pinName = flags['as'];
	if (!pinName) {
		rc.err(`pinnace pin: --as <name> is required\n${PIN_USAGE}`);
		return 1;
	}
	// The pin's `--as <name>` IS the site id, so it is what a bare
	// --set-ens-name infers from (as the site id is for deploy).
	const ensName = ensNameIntent('pinnace pin', flags, pinName, rc);
	if (!ensName) return 1; // ensNameIntent already emitted the loud error.
	// EXACTLY ONE source: the cid the operator has, or the IPNS name to resolve
	// one from. Two sources is a contradiction; none is nothing to pin.
	if (cid && fromIpns) {
		rc.err(
			`pinnace pin: give exactly one source: the positional <cid> ('${cid}') ` +
				`or --from-ipns ('${fromIpns}'), not both\n${PIN_USAGE}`,
		);
		return 1;
	}
	if (!cid && !fromIpns) {
		rc.err(
			'pinnace pin: give exactly one source: a positional <cid>, or ' +
				`--from-ipns <name> to migrate from an existing IPNS name\n${PIN_USAGE}`,
		);
		return 1;
	}

	// The mode surface is an explicit allow-list (same two values as a site's),
	// and stating nothing PRESERVES the entry's stored mode (the core resolves it).
	const mode = siteModeIntentFromFlags('pinnace pin', flags, pinName, rc);
	if (!mode) return 1; // siteModeIntentFromFlags already emitted the error.

	const cli = cliOverridesFromFlags(flags, rc.endpoint);
	const cfg = resolveConfig({file: rc.file, env: rc.env, cli});
	if (cfg.hosts.length === 0) {
		rc.err(`pinnace pin: ${NO_HOSTS_HINT}`);
		return 1;
	}

	// Default: every configured node (redundant). --host narrows to one.
	let hosts = cfg.hosts;
	const hostName = flags['host'];
	if (hostName) {
		const match = cfg.hosts.find((h) => h.name === hostName);
		if (!match) {
			rc.err(
				`pinnace pin: unknown host '${hostName}'; configured hosts: ${cfg.hosts
					.map((h) => h.name)
					.join(', ')}`,
			);
			return 1;
		}
		hosts = [match];
	}

	// ipns mode: the operator's own name for the mirrored content. The master is
	// env-ONLY, and SOMETHING among the targets must be able to sign.
	const statedIpns = mode.kind === 'set' && mode.mode === 'ipns';
	let derived: DerivedIpnsKey | undefined;
	if (statedIpns && !hosts.some((h) => h.role === 'publisher')) {
		rc.err(
			`pinnace pin: --set-mode ipns needs a publisher to sign the name, but ` +
				`${hosts.map((h) => `${h.name} (${h.role})`).join(', ')} cannot — a ` +
				`replica is keyless and only re-announces the publisher's record. ` +
				`Pin with --set-mode ipfs, or target the publisher.`,
		);
		return 1;
	}
	// The key material is needed for a STATED ipns pin, and MAY be needed for a
	// PRESERVED one (only the core, which reads the stored metadata, knows). It is
	// a local KDF over the env-ONLY master — no node contact — so it is derived
	// whenever it could be used; a stated `ipfs` pin never derives at all.
	if (statedIpns || mode.kind === 'preserve') {
		const master = resolveMasterSecret({env: rc.env});
		if (!master && statedIpns) {
			rc.err(
				'pinnace pin: --set-mode ipns needs the master secret — export PINNACE_MASTER (env-only; never read from pinnace.json)',
			);
			return 1;
		}
		// The `--as <name>` IS the site id AND the KDF input (one identifier).
		if (master) derived = rc.deps.deriveIpnsKey({master, keyId: pinName});
	}

	let targets: PinTarget[];
	try {
		targets = hosts.map((h) => ({
			baseUrl: h.endpoint,
			token: resolveHostToken({hostName: h.name, env: rc.env, cli}),
			role: h.role,
		}));
	} catch (error) {
		if (error instanceof MissingHostTokenError) {
			rc.err(`pinnace pin: ${error.message}`);
			return 1;
		}
		throw error;
	}

	let result: PinExternalResult;
	try {
		result = await rc.deps.pinExternal({
			targets,
			...(fromIpns ? {fromIpns} : {cid: cid as string}),
			name: pinName,
			recursive: flags['no-recursive'] === undefined,
			...(mode.kind === 'set' ? {mode: mode.mode} : {}),
			ensName,
			...(derived ? {derived} : {}),
		});
	} catch (error) {
		// The two failures the CLI cannot pre-check, because both are answers only
		// the NODES have: the SOURCE name resolved nowhere (no cid to pin, in Kubo's
		// own words), and a PRESERVED `ipns` entry that needs key material the
		// unset master could not supply.
		if (
			error instanceof PinSourceResolveError ||
			error instanceof PinDerivedKeyRequiredError
		) {
			rc.err(`pinnace pin: ${error.message}`);
			return 1;
		}
		throw error;
	}
	// Migrating: say WHAT the source name currently points at (and whose view).
	if (result.fromIpns) {
		rc.out(
			`resolved ipns ${result.fromIpns} -> ${result.cid}` +
				`${result.resolvedBy ? ` (via ${result.resolvedBy})` : ''}`,
		);
	}
	rc.out(
		`pinned ${result.cid} as ${result.name}${result.recursive ? '' : ' (root block only)'}`,
	);
	for (const ok of result.ok) {
		rc.out(
			`  ok  ${ok.baseUrl}${ok.published && ok.ipns ? ` (ipns ${ok.ipns})` : ''}`,
		);
	}
	for (const failure of result.failed) {
		rc.err(
			`  FAIL ${failure.baseUrl} (${failure.stage}): ${failure.error.message}`,
		);
	}
	// The whole point of ipns mode: the mutable pointer the operator now controls.
	if (result.ipns) rc.out(`ipns://${result.ipns}`);
	// A migrate is a SNAPSHOT, not a follow: nothing watches the source, so say it
	// where the operator is looking rather than only in the docs.
	if (result.fromIpns) {
		rc.out(
			`note: a snapshot of ${result.fromIpns}, not a follow. Re-run this ` +
				`command to pull a newer one (pinnace never tracks the source itself)`,
		);
	}
	return result.success ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Shared helpers.
// ---------------------------------------------------------------------------

/**
 * Turn the `--set-mode` verb-flag into ONE {@link SiteModeIntent} — the mode
 * counterpart of {@link ensNameIntentFromFlags} — or emit the loud error and
 * return undefined (so the verb can `return 1` without dispatching):
 *
 *   `--set-mode ipfs|ipns` -> STATE that mode (it beats the stored one)
 *   omitted                -> PRESERVE the site's stored mode
 *   `--set-mode` (bare)    -> a USAGE ERROR naming the two values
 *   any other value        -> the unresolved-mode refusal, naming the site
 *
 * There is deliberately NO `--unset-mode`: unlike `ensName`, `mode` has no
 * three-valued opt-out to author (an absent stored mode simply means
 * `{@link DEFAULT_SITE_MODE}`), so the flag has two states, stated or preserved.
 * And unlike a bare `--set-ens-name` (which INFERS from a `.eth` id), a bare
 * `--set-mode` has nothing to infer from — hence the loud refusal rather than a
 * guess. BARE is the existing {@link parseArgs} no-value convention (end of
 * argv, or immediately followed by another `--flag`).
 *
 * Decisions behind this resolution order (and its multi-node reading) are
 * recorded in `work/notes/observations/config-drop-sites-decisions.md`.
 */
function siteModeIntentFromFlags(
	prefix: string,
	flags: Record<string, string>,
	siteId: string,
	rc: ResolvedRunContext,
): SiteModeIntent | undefined {
	const stated = flags['set-mode'];
	if (stated === undefined) return {kind: 'preserve'};
	if (stated === '') {
		rc.err(
			`${prefix}: --set-mode needs a value: 'ipfs' or 'ipns' (omit the flag to ` +
				`keep the mode '${siteId}' is already stored under)`,
		);
		return undefined;
	}
	if (stated !== 'ipfs' && stated !== 'ipns') {
		rc.err(
			`${prefix}: mode for '${siteId}' is unresolved ('${stated}'); pass ` +
				`--set-mode ipfs|ipns, or omit it to keep the mode stored in the site's ` +
				`metadata (--set-mode > the stored metadata > '${DEFAULT_SITE_MODE}')`,
		);
		return undefined;
	}
	return {kind: 'set', mode: stated};
}

/**
 * The shared no-hosts refusal. Names BOTH ways to supply a node, because the
 * config file is OPTIONAL: `--endpoint <url>` (one node, token from env) or a
 * `hosts` entry in `pinnace.json` (multi-node / durable setups).
 */
const NO_HOSTS_HINT =
	'no node to act on; pass --endpoint <url> for a single node ' +
	'(its token from PINNACE_HOST_PUBLISHER_TOKEN), or add hosts to pinnace.json';

/**
 * The ensName flags that take NO value, for {@link parseArgs}. Only
 * `--unset-ens-name` is here: `--set-ens-name` takes an OPTIONAL value, so it
 * stays value-taking and its BARE form is the parser's existing no-value case
 * (end of argv, or immediately followed by another `--flag`).
 */
const ENS_NAME_BOOLEAN_FLAGS = ['unset-ens-name'] as const;

/**
 * Turn the two ensName verb-flags into ONE {@link EnsNameIntent} (the core's
 * write intent), or a usage error:
 *
 *   `--set-ens-name <name>`  -> set that name (no `.eth` requirement)
 *   `--set-ens-name` (bare)  -> infer from a `.eth` id (the key is removed)
 *   `--unset-ens-name`       -> the `""` opt-out (never warm)
 *   neither                  -> preserve (leave the site's ensName alone)
 *
 * BARE is the existing {@link parseArgs} no-value convention: `--set-ens-name`
 * at the end of argv, or immediately followed by another `--flag`, parses as an
 * empty value. So `--set-ens-name ""` is ALSO read as bare/infer — the opt-out
 * has its own flag (`--unset-ens-name`) precisely so an empty value never has
 * to mean two things.
 *
 * The two flags are mutually exclusive, and a bare set is checked against the
 * `id` HERE (before hosts/tokens are resolved) so the message can name what the
 * operator typed; the core repeats the check for library callers.
 */
function ensNameIntentFromFlags(
	flags: Record<string, string>,
): EnsNameIntent | undefined {
	const set = flags['set-ens-name'];
	const unset = flags['unset-ens-name'] !== undefined;
	if (set !== undefined && unset) return undefined; // contradictory: a usage error.
	if (unset) return {kind: 'unset'};
	if (set === undefined) return {kind: 'preserve'};
	return set === '' ? {kind: 'infer'} : {kind: 'set', name: set};
}

/**
 * {@link ensNameIntentFromFlags} + the `.eth` precondition, emitting the loud
 * error and returning undefined on either failure (the `buildHostClient`
 * pattern), so the verb can `return 1` without dispatching to the core.
 */
function ensNameIntent(
	prefix: string,
	flags: Record<string, string>,
	id: string,
	rc: ResolvedRunContext,
): EnsNameIntent | undefined {
	const intent = ensNameIntentFromFlags(flags);
	if (!intent) {
		rc.err(
			`${prefix}: --set-ens-name and --unset-ens-name are mutually exclusive ` +
				`(one names the gateway to warm, the other opts out); pass at most one`,
		);
		return undefined;
	}
	try {
		assertEnsNameIntent(intent, id);
	} catch (error) {
		if (error instanceof EnsNameInferenceError) {
			rc.err(`${prefix}: ${error.message}`);
			return undefined;
		}
		throw error;
	}
	return intent;
}

/**
 * The flags exempt from {@link refuseBareFlags}, because their bare form is
 * ALREADY meaningful or already refused, and sweeping them would re-mean or
 * shadow that:
 *  - `set-ens-name` takes an OPTIONAL value: bare = infer from a `.eth` id
 *    ({@link ensNameIntentFromFlags}),
 *  - `set-mode` owns a TAILORED refusal naming its two values
 *    ({@link siteModeIntentFromFlags}).
 * Everything else that takes a value is swept.
 */
const OPTIONAL_VALUE_FLAGS: ReadonlySet<string> = new Set([
	'set-ens-name',
	'set-mode',
]);

/**
 * Refuse every flag the operator typed with NO value, loudly (returns false
 * after emitting, so the verb can `return 1` without dispatching).
 *
 * This is the general form of the rule the bare-`--set-mode` refusal
 * established: A FLAG THE OPERATOR TYPED MUST NEVER MEAN NOTHING. The verbs
 * read optional flags as `if (flags['x'])`, so a bare one (parsed as `''` by
 * {@link parseArgs}: end of argv, immediately followed by another `--flag`, or
 * an explicit empty value) used to be SWALLOWED, silently reverting to the
 * default the operator was trying to override: a bare `--host` widened a `pin`
 * to every node, a bare `--gateways` kept the configured list, a bare
 * `--host-endpoint.<name>` overrode a host's endpoint with `''`. Called by
 * every verb right after {@link parseArgs} (the global `--endpoint` is refused
 * earlier still, in {@link takeEndpointFlag}, since it never reaches a verb).
 *
 * It knows nothing of which flags a verb understands, so a bare UNKNOWN flag is
 * refused too while an unknown flag WITH a value stays ignored as before: the
 * question here is only whether a TYPED flag carries what it needs, and
 * rejecting unknown flags is a separate surface decision (recorded, with the
 * exemption reasoning, in
 * `work/notes/observations/endpoint-flag-loud-and-global-decisions.md`).
 */
function refuseBareFlags(
	prefix: string,
	flags: Record<string, string>,
	rc: ResolvedRunContext,
): boolean {
	const bare = Object.keys(flags).filter(
		(key) => flags[key] === '' && !OPTIONAL_VALUE_FLAGS.has(key),
	);
	if (bare.length === 0) return true;
	const named = bare.map((key) => `--${key}`).join(', ');
	rc.err(
		`${prefix}: ${named} ${bare.length === 1 ? 'needs' : 'need'} a value: ` +
			`pass ${bare.map((key) => `'--${key} <value>'`).join(', ')}, or drop ` +
			`${bare.length === 1 ? 'the flag' : 'them'} (a flag with no value is ` +
			'never read as its default)',
	);
	return false;
}

/** Return the keys whose value is falsy (missing required flags), in order. */
function missingFlags(required: Record<string, string | undefined>): string[] {
	return Object.entries(required)
		.filter(([, value]) => !value)
		.map(([key]) => `--${key}`);
}

/**
 * Build the {@link CliOverrides} the config resolver understands from parsed
 * flags. `--gateways a,b` overrides the gateway list; per-host token/endpoint
 * overrides use the `--host-token.<name>` / `--host-endpoint.<name>` form.
 *
 * `endpoint` is the CONFIG-LESS path: it supplies ONE publisher node directly
 * (its token still env-only, from `PINNACE_HOST_PUBLISHER_TOKEN`), so every
 * node-touching verb works with no `pinnace.json`. Being the arg tier it
 * REPLACES the file's hosts — unlike `--host-endpoint.<name>`, which overrides
 * the endpoint OF a host the file declares. It is passed in SEPARATELY because
 * `--endpoint` is a GLOBAL flag stripped from the argv before any verb parses
 * it ({@link takeEndpointFlag}), and so is carried on
 * {@link ResolvedRunContext.endpoint} rather than in `flags`.
 */
function cliOverridesFromFlags(
	flags: Record<string, string>,
	endpoint?: string,
): CliOverrides {
	const cli: CliOverrides = {};
	const hostToken: Record<string, string> = {};
	const hostEndpoint: Record<string, string> = {};
	for (const [key, value] of Object.entries(flags)) {
		if (key.startsWith('host-token.'))
			hostToken[key.slice('host-token.'.length)] = value;
		else if (key.startsWith('host-endpoint.'))
			hostEndpoint[key.slice('host-endpoint.'.length)] = value;
	}
	if (Object.keys(hostToken).length > 0) cli.hostToken = hostToken;
	if (Object.keys(hostEndpoint).length > 0) cli.hostEndpoint = hostEndpoint;
	if (endpoint) cli.endpoint = endpoint;
	if (flags['gateways'])
		cli.gateways = flags['gateways']
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
	return cli;
}

/**
 * `pinnace site <verb> [args] [--host <name>]` -> the site core
 * ({@link ClientDeps.listSites}/{@link ClientDeps.removeSite}/
 * {@link ClientDeps.addSite}). Assembles a per-host {@link KuboRpcClient} from
 * the resolved config (endpoint) + the host's env-only token, then dispatches:
 *   - `list`            -> listSites({client})
 *   - `remove <id>`     -> removeSite({client, id})
 *   - `add <id> <cid>`  -> addSite({client, id, cid})
 * The `--host <name>` selects which configured node to act on; it may be
 * omitted only when the config has exactly one host (see {@link selectHost}).
 */
async function runSiteCli(
	argv: readonly string[],
	rc: ResolvedRunContext,
): Promise<number> {
	const {flags, positionals} = parseArgs(argv);
	if (!refuseBareFlags('pinnace site', flags, rc)) return 1;
	const [verb, ...verbArgs] = positionals;
	if (!verb) {
		rc.err(`pinnace site: expected a verb (${SITE_VERBS.join(', ')})`);
		return 1;
	}
	if (!SITE_VERBS.includes(verb as SiteVerb)) {
		rc.err(
			`pinnace site: unknown verb '${verb}'; expected one of ${SITE_VERBS.join(', ')}`,
		);
		return 1;
	}

	const cli = cliOverridesFromFlags(flags, rc.endpoint);
	const cfg = resolveConfig({file: rc.file, env: rc.env, cli});
	const client = buildHostClient('pinnace site', flags['host'], cfg, rc, cli);
	if (!client) return 1; // buildHostClient already emitted the loud error.

	if (verb === 'list') {
		const sites = await rc.deps.listSites({client});
		for (const site of sites) {
			rc.out(
				`${site.id}: cid ${site.cid}${site.ipns ? ` ipns ${site.ipns}` : ''}`,
			);
		}
		return 0;
	}
	if (verb === 'remove') {
		const [id] = verbArgs;
		if (!id) {
			rc.err(
				'pinnace site remove: usage: pinnace site remove <id> [--host <name>]',
			);
			return 1;
		}
		const result = await rc.deps.removeSite({client, id});
		rc.out(
			`removed ${result.id}${result.cid ? ` (cid ${result.cid}, unpinned=${result.unpinned})` : ''}`,
		);
		return 0;
	}
	// verb === 'add'
	const [id, cid] = verbArgs;
	if (!id || !cid) {
		rc.err(
			'pinnace site add: usage: pinnace site add <id> <cid> [--host <name>]',
		);
		return 1;
	}
	const result = await rc.deps.addSite({client, id, cid});
	rc.out(`added ${result.id} -> ${result.cid}`);
	return 0;
}

/**
 * `pinnace node <verb>` -> the on-box command core ({@link
 * ClientDeps.runNodeCommand}). This is the load-bearing on-box wiring: the verb
 * runs ON a provisioned box (invoked by the systemd timer, whose
 * `EnvironmentFile=/etc/pinnace-node.env` exports the box config into the
 * environment {@link RunContext.env} reads). It assembles a
 * {@link NodeCommandContext} from that env — a LOCAL Kubo client (127.0.0.1:5001
 * + `RPC_BEARER_TOKEN`), the box `role` (`NODE_ROLE`), and the on-box paths
 * (`RECORDS_DIR`/`CACHE_DIR`/`DASHBOARD_DIR`/`SITES_DIR`), the replica
 * `PUBLISHER_ENDPOINT`, and the `WARM_GATEWAYS` list — and injects the OWNED
 * `status` op ({@link makeStatusOp}, the real per-site announce/gateway report)
 * so the production status path is not the thin default stub. It then invokes
 * the core (NOT a validate-and-return-0). A live run proved that without this
 * the `republish`/`mirror` timers are no-ops. The token is env-only and its
 * absence is a LOUD, named error (never a silent empty bearer / 401).
 */
async function runNodeCli(
	argv: readonly string[],
	rc: ResolvedRunContext,
): Promise<number> {
	const [verb] = argv;
	if (!verb) {
		rc.err(`pinnace node: expected a verb (${NODE_VERBS.join(', ')})`);
		return 1;
	}
	if (!NODE_VERBS.includes(verb as NodeVerb)) {
		rc.err(
			`pinnace node: unknown verb '${verb}'; expected one of ${NODE_VERBS.join(', ')}`,
		);
		return 1;
	}

	const env = rc.env;
	const token = env['RPC_BEARER_TOKEN'];
	if (!token) {
		rc.err(
			'pinnace node: RPC_BEARER_TOKEN not set — the on-box bearer is env-only ' +
				'(read from /etc/pinnace-node.env); never a silent empty token',
		);
		return 1;
	}
	const role = env['NODE_ROLE'];
	if (role !== 'publisher' && role !== 'replica') {
		rc.err(
			"pinnace node: NODE_ROLE must be 'publisher' or 'replica' " +
				'(read from /etc/pinnace-node.env)',
		);
		return 1;
	}

	// The box's OWN daemon: the local Kubo RPC on 127.0.0.1:5001 (Caddy fronts it
	// for external clients, but the on-box agent speaks to it directly).
	const client = new KuboRpcClient({
		baseUrl: 'http://127.0.0.1:5001',
		token,
	});

	const ctx: NodeCommandContext = {
		client,
		role,
		// The production status path uses the OWNED status op (real announce +
		// gateway report), not the thin defaultStatus stand-in.
		ops: {status: makeStatusOp()},
	};
	if (env['SITES_DIR']) ctx.sitesDir = env['SITES_DIR'];
	if (env['RECORDS_DIR']) ctx.recordsDir = env['RECORDS_DIR'];
	if (env['CACHE_DIR']) ctx.cacheDir = env['CACHE_DIR'];
	if (env['DASHBOARD_DIR']) ctx.dashboardDir = env['DASHBOARD_DIR'];
	if (env['PUBLISHER_ENDPOINT'])
		ctx.publisherEndpoint = env['PUBLISHER_ENDPOINT'];
	const gateways = splitWarmGateways(env['WARM_GATEWAYS']);
	if (gateways.length > 0) ctx.gateways = gateways;

	const result = await rc.deps.runNodeCommand(verb as NodeVerb, ctx);
	if (result.skipped) {
		rc.out(`pinnace node ${verb}: skipped (${result.skippedReason})`);
		return 0;
	}
	for (const site of result.sites) {
		rc.out(
			`  ${site.id}${site.cid ? ` cid ${site.cid}` : ''}${site.status ? ` (${site.status})` : ''}`,
		);
	}
	return 0;
}

/** The two forms of `authorize`, and the reason it takes no `--host`. */
const AUTHORIZE_USAGE =
	'usage: pinnace authorize            (every site the publisher holds in MFS)\n' +
	'   or: pinnace authorize <id>       (just that site; it need not exist yet)';

/**
 * `pinnace authorize [<id>]` -> {@link ClientDeps.authorizePublisher}. Grants
 * the config's DECLARED publisher the key MATERIAL for one site (`<id>`) or for
 * every site it holds in MFS (the bare form), so CI can deploy those names
 * forever WITHOUT the master. It changes no role and performs no failover (see
 * the core module doc); re-running it is a safe no-op.
 *
 * There is deliberately NO `--host`: the config already declares who the
 * publisher is, so the flag could only restate it — or contradict it. A typed
 * `--host` is therefore a loud usage error rather than a silently ignored flag
 * (the same "a flag you typed must never mean nothing" rule
 * {@link refuseBareFlags} applies), which is also why `pickHost`'s
 * "--host is mandatory once you have two hosts" friction does not apply here.
 *
 * The refusals, all before any node is touched:
 *  - a missing `PINNACE_MASTER` (env-ONLY, never from `pinnace.json`),
 *  - a config declaring ZERO publishers (nothing to authorize) or MORE THAN ONE
 *    (the model is one publisher per shared IPNS name; picking one silently
 *    would be a coin flip),
 *  - the publisher's own bearer token unset (named env var, as everywhere).
 *
 * `--endpoint <url>` is an ASSERTION, and is honest about it: it MINTS a single
 * synthetic host named `publisher` (`CLI_ENDPOINT_HOST_NAME`) with role
 * `publisher` (see `../config/config-resolution.ts`), so
 * the operator is CLAIMING that node is the publisher. pinnace cannot check it
 * (a box's real role is `NODE_ROLE` in its cloud-init env, unreachable over
 * Kubo RPC), so the zero/multiple/replica guards cannot fire on that path, and
 * with one visible box the second-signer guard has nothing to ask either —
 * exactly as `deploy --endpoint` already works.
 *
 * The OTHER configured hosts are handed to the core for the second-signer
 * guard. A host whose token is unset cannot be asked, so it is reported as
 * unchecked rather than failing the run: that guard is best-effort by
 * construction (it is skipped wholesale under `--endpoint`), and a replica's
 * token is not otherwise this verb's business.
 */
async function runAuthorize(
	argv: readonly string[],
	rc: ResolvedRunContext,
): Promise<number> {
	const {flags, positionals} = parseArgs(argv);
	if (!refuseBareFlags('pinnace authorize', flags, rc)) return 1;
	if (flags['host'] !== undefined) {
		rc.err(
			`pinnace authorize: --host is not accepted; authorize targets the ` +
				`host your config DECLARES \`role: publisher\` (there is exactly one ` +
				`publisher per IPNS name, so there is nothing to choose). Fix the ` +
				`roles in pinnace.json, or pass --endpoint <url> to assert one node.\n` +
				AUTHORIZE_USAGE,
		);
		return 1;
	}
	if (positionals.length > 1) {
		rc.err(
			`pinnace authorize: expected at most one site id, got ` +
				`${positionals.map((p) => `'${p}'`).join(', ')}\n${AUTHORIZE_USAGE}`,
		);
		return 1;
	}
	const [siteId] = positionals;

	const master = resolveMasterSecret({env: rc.env});
	if (!master) {
		rc.err(
			'pinnace authorize: master secret not set — export PINNACE_MASTER ' +
				'(env-only; never read from pinnace.json). Authorizing IS handing the ' +
				'publisher the key derived from it, so this is the one verb that ' +
				'cannot run without it.',
		);
		return 1;
	}

	const cli = cliOverridesFromFlags(flags, rc.endpoint);
	const cfg = resolveConfig({file: rc.file, env: rc.env, cli});
	if (cfg.hosts.length === 0) {
		rc.err(`pinnace authorize: ${NO_HOSTS_HINT}`);
		return 1;
	}
	const publishers = cfg.hosts.filter((h) => h.role === 'publisher');
	if (publishers.length === 0) {
		rc.err(
			`pinnace authorize: no host is declared \`role: publisher\` (configured: ` +
				`${cfg.hosts.map((h) => `${h.name} (${h.role})`).join(', ')}), so there ` +
				`is nothing to authorize — only the publisher holds a key, and a ` +
				`replica is keyless by design.`,
		);
		return 1;
	}
	if (publishers.length > 1) {
		rc.err(
			`pinnace authorize: ${publishers.length} hosts are declared ` +
				`\`role: publisher\` (${publishers.map((h) => h.name).join(', ')}); ` +
				`exactly one node per IPNS name may hold the key, since two signers ` +
				`race the record's sequence numbers. Declare one publisher in ` +
				`pinnace.json, or pass --endpoint <url> to name the node directly.`,
		);
		return 1;
	}
	const publisher = publishers[0];
	const client = clientForHost('pinnace authorize', publisher, rc, cli);
	if (!client) return 1;

	// The OTHER hosts, for the second-signer guard. One with no resolvable token
	// cannot be asked: reported below, never fatal (see the doc above).
	const others: AuthorizeHost[] = [];
	const unaskable: string[] = [];
	for (const host of cfg.hosts) {
		if (host.name === publisher.name) continue;
		try {
			others.push({
				name: host.name,
				client: new KuboRpcClient({
					baseUrl: host.endpoint,
					token: resolveHostToken({hostName: host.name, env: rc.env, cli}),
				}),
			});
		} catch (error) {
			if (error instanceof MissingHostTokenError) unaskable.push(host.name);
			else throw error;
		}
	}

	let result: AuthorizeResult;
	try {
		result = await rc.deps.authorizePublisher({
			publisher: {name: publisher.name, client, role: publisher.role},
			others,
			// The single `id` IS the KDF input (no separate keyId), matching `derive`:
			// the positional arg verbatim, with no config lookup to normalise it. No
			// id at all means the core discovers the publisher's MFS sites.
			...(siteId ? {ids: [siteId]} : {}),
			// The master stays in the CLI: the core asks for material per site.
			deriveKey: (id) => rc.deps.deriveIpnsKey({master, keyId: id}),
		});
	} catch (error) {
		// The two refusals only the NODES can answer: a key for this site already
		// sits on another configured host, and the key-import seam's standing
		// refusal to put a key on anything but a publisher (ADR-0003).
		if (
			error instanceof AuthorizeSecondSignerError ||
			error instanceof KeyImportRoleError
		) {
			rc.err(`pinnace authorize: ${error.message}`);
			return 1;
		}
		throw error;
	}

	rc.out(`publisher ${publisher.name} (${publisher.endpoint})`);
	for (const site of result.sites) {
		rc.out(
			`  ${site.id}: ${site.status}${site.ipns ? ` (ipns ${site.ipns})` : ''}`,
		);
	}
	if (result.sites.length === 0) {
		rc.out(
			`no sites in MFS on ${publisher.name} to authorize; name one ` +
				`(\`pinnace authorize <id>\`) to authorize it before its first deploy`,
		);
	}
	const unchecked = [...result.unchecked, ...unaskable];
	if (unchecked.length > 0) {
		rc.out(
			`note: could not check ${unchecked.join(', ')} for an existing key ` +
				`(unreachable, or no token set); a second node holding this key would ` +
				`race the record's sequence numbers`,
		);
	}
	return 0;
}

// ---------------------------------------------------------------------------
// Host selection + client assembly (shared by the site verbs + authorize).
// ---------------------------------------------------------------------------

/**
 * Pick the configured host to act on. `--host <name>` selects it by name; it
 * may be omitted ONLY when the config has exactly one host (the unambiguous
 * case). Zero hosts, an unknown name, or an omitted name with several hosts is
 * a LOUD, specific error (returns undefined after emitting it).
 */
function pickHost(
	prefix: string,
	hostName: string | undefined,
	cfg: {hosts: Array<{name: string; endpoint: string; role: HostRole}>},
	rc: ResolvedRunContext,
): {name: string; endpoint: string; role: HostRole} | undefined {
	if (cfg.hosts.length === 0) {
		rc.err(`${prefix}: ${NO_HOSTS_HINT}`);
		return undefined;
	}
	if (hostName) {
		const match = cfg.hosts.find((h) => h.name === hostName);
		if (!match) {
			rc.err(
				`${prefix}: unknown host '${hostName}'; configured hosts: ${cfg.hosts
					.map((h) => h.name)
					.join(', ')}`,
			);
			return undefined;
		}
		return match;
	}
	if (cfg.hosts.length > 1) {
		rc.err(
			`${prefix}: multiple hosts configured; pass --host <name> (one of ${cfg.hosts
				.map((h) => h.name)
				.join(', ')})`,
		);
		return undefined;
	}
	return cfg.hosts[0];
}

/**
 * Build a {@link KuboRpcClient} for a chosen host, resolving its bearer token
 * env-only (CLI > env, no file). A missing token is a LOUD, named error
 * (returns undefined after emitting it).
 */
function clientForHost(
	prefix: string,
	host: {name: string; endpoint: string},
	rc: ResolvedRunContext,
	cli: CliOverrides,
): KuboRpcClient | undefined {
	let token: string;
	try {
		token = resolveHostToken({hostName: host.name, env: rc.env, cli});
	} catch (error) {
		if (error instanceof MissingHostTokenError) {
			rc.err(`${prefix}: ${error.message}`);
			return undefined;
		}
		throw error;
	}
	return new KuboRpcClient({baseUrl: host.endpoint, token});
}

/** Pick a host AND build its client in one step (the common site path). */
function buildHostClient(
	prefix: string,
	hostName: string | undefined,
	cfg: {hosts: Array<{name: string; endpoint: string; role: HostRole}>},
	rc: ResolvedRunContext,
	cli: CliOverrides,
): KuboRpcClient | undefined {
	const host = pickHost(prefix, hostName, cfg, rc);
	if (!host) return undefined;
	return clientForHost(prefix, host, rc, cli);
}

/** Split the space-separated `WARM_GATEWAYS` env value into a template list. */
function splitWarmGateways(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(/\s+/)
		.map((s) => s.trim())
		.filter(Boolean);
}
