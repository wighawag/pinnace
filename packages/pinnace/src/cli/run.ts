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
 * the `promote` verb, dispatch through the SAME {@link RunContext}/
 * {@link ClientDeps} seam (they are NOT a forked dispatch idiom): the on-box
 * `node` verbs assemble a {@link NodeCommandContext} from the box env
 * (`/etc/pinnace-node.env`, exported into `process.env` by the systemd timer's
 * `EnvironmentFile`) and call the core `runNodeCommand`; `site`/`promote`
 * assemble a per-host {@link KuboRpcClient} from the resolved config and call
 * the site / promote core.
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
	type EnsNameIntent,
} from '../site/site-wrapper.js';
import {makeStatusOp} from '../status/status-report.js';
import {
	promoteReplicaToPublisher as corePromoteReplicaToPublisher,
	type PromoteReplicaInput,
	type PromoteReplicaResult,
} from '../publisher/record-sequence.js';
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
	type DeployInput,
	type DeployResult,
	type DeployTarget,
} from '../deploy/deploy.js';
import {
	pinExternal as corePinExternal,
	PinSourceResolveError,
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
	type SiteMode,
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
	/** `promote` -> derive the per-site key material from the master + `id`. */
	deriveIpnsKey(input: DeriveIpnsKeyInput): DerivedIpnsKey;
	/** `promote` -> import the key + flip the node's role to publisher (story 14). */
	promoteReplicaToPublisher(
		input: PromoteReplicaInput,
	): Promise<PromoteReplicaResult>;
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
	promoteReplicaToPublisher: corePromoteReplicaToPublisher,
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
 * the config from `configPath` (the operator's explicit `--config`, or
 * `undefined` for the `./pinnace.json` default) through the loader seam.
 */
function resolveContext(
	context: RunContext,
	configPath?: string,
): ResolvedRunContext {
	return {
		env: context.env ?? (process.env as EnvRecord),
		file: (context.loadConfigFile ?? defaultLoadConfigFile)(configPath),
		deps: context.deps ?? DEFAULT_DEPS,
		out: context.out ?? ((line) => console.log(line)),
		err: context.err ?? ((line) => console.error(line)),
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
 * A GLOBAL `--config <path>` flag may appear BEFORE the command; it is consumed
 * here (stripped from the per-verb argv) and threaded into config loading via
 * the {@link RunContext.loadConfigFile} seam. With no `--config`, the default
 * `./pinnace.json` is read and its absence is benign; an explicitly-named path
 * that is missing/unreadable/invalid JSON fails loud (names the path, exit 1).
 */
export async function run(
	argv: readonly string[],
	context: RunContext = {},
): Promise<number> {
	const {configPath, rest: postGlobal} = takeConfigFlag(argv);

	const err = context.err ?? ((line) => console.error(line));
	let rc: ResolvedRunContext;
	try {
		rc = resolveContext(context, configPath);
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
	if (command === 'promote') {
		return runPromote(rest, rc);
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
 * `deploy [--mode <m>] [--set-ens-name [<name>] | --unset-ens-name] <dir> <id>`
 * -> core {@link ClientDeps.deploy}. Resolves every configured host into a
 * {@link DeployTarget} (each host's OWN token resolved env-only, LAZILY, via
 * {@link resolveHostToken} — CLI > env, no file), and the site's `mode` from
 * the matching `pinnace.json` site entry (overridable with `--mode`). A host
 * with no resolvable token FAILS LOUD naming its exact env var. Prints the
 * resulting CID / per-node breakdown.
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
	const [dir, siteId] = positionals;
	if (!dir || !siteId) {
		rc.err(
			'pinnace deploy: usage: pinnace deploy [--mode ipfs|ipns] ' +
				'[--set-ens-name [<name>] | --unset-ens-name] <dir> <id>',
		);
		return 1;
	}
	const ensName = ensNameIntent('pinnace deploy', flags, siteId, rc);
	if (!ensName) return 1; // ensNameIntent already emitted the loud error.

	const cli = cliOverridesFromFlags(flags);
	const cfg = resolveConfig({file: rc.file, env: rc.env, cli});

	// The site's mode: --mode arg > matching site entry (config precedence).
	const siteEntry = cfg.sites.find((s) => s.id === siteId);
	const mode = (flags['mode'] as SiteMode | undefined) ?? siteEntry?.mode;
	if (mode !== 'ipfs' && mode !== 'ipns') {
		rc.err(
			`pinnace deploy: mode for '${siteId}' is unset or invalid; pass --mode ipfs|ipns or add the site to pinnace.json`,
		);
		return 1;
	}
	if (cfg.hosts.length === 0) {
		rc.err('pinnace deploy: no hosts configured (add hosts to pinnace.json)');
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
	const input: DeployInput = {
		sourceDir: dir,
		id: siteId,
		mode,
		targets,
		ensName,
	};

	const result = await rc.deps.deploy(input);
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
	const cli = cliOverridesFromFlags(flags);
	const cfg = resolveConfig({file: rc.file, env: rc.env, cli});
	if (cfg.hosts.length === 0) {
		rc.err('pinnace status: no hosts configured (add hosts to pinnace.json)');
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
				`  ${site.id}: cid ${site.cid}${site.ipns ? ` ipns ${site.ipns}` : ''} announced=${site.announced} gatewayServes=${site.gatewayServes}`,
			);
		}
	}
	return 0;
}

/**
 * `derive <id>` (a.k.a. `ipns-id`) -> core {@link ClientDeps.deriveIpnsId}.
 * Prints the site's `k51...` IPNS id from the master + the site's single `id`
 * (the KDF input), with NO deploy (user story 22). The master is env-ONLY (via
 * {@link resolveMasterSecret}); the `id` is either the positional argument
 * verbatim or, if it names a `pinnace.json` site entry, that entry's `id` (they
 * are the same value — one identifier). Fails loudly if the master is unset.
 */
function runDerive(argv: readonly string[], rc: ResolvedRunContext): number {
	const {positionals} = parseArgs(argv);
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

	// The single `id` IS the KDF input. The positional is the id directly; a
	// matching site entry carries the same value (no separate keyId to look up).
	const cfg = resolveConfig({file: rc.file, env: rc.env, cli: {}});
	const id = cfg.sites.find((s) => s.id === siteId)?.id ?? siteId;

	const printed = rc.deps.deriveIpnsId({master, keyId: id});
	rc.out(printed);
	return 0;
}

/** The two forms of the `pin` verb: one source each, never both, never neither. */
const PIN_USAGE =
	'usage: pinnace pin <cid> --as <name> [--mode ipfs|ipns] [--host <name>] [--no-recursive] [--set-ens-name [<name>] | --unset-ens-name]\n' +
	'   or: pinnace pin --from-ipns <source-ipns-name> --as <name> [--mode ipfs|ipns] [--host <name>] [--no-recursive] [--set-ens-name [<name>] | --unset-ens-name]';

/**
 * `pin <cid> --as <name> [--mode ipfs|ipns] [--host <name>] [--no-recursive]` ->
 * core {@link ClientDeps.pinExternal}. Pins an EXTERNAL network CID (content the
 * operator has only the CID for) on EVERY configured node by default — the same
 * redundancy `deploy` gives — and tracks it in MFS at `/sites/<name>` so it
 * shows on the dashboard and gets gateway-warmed.
 *
 * A pin takes EXACTLY ONE source, the positional `<cid>` XOR `--from-ipns
 * <name>`; giving both or neither is a usage error. `--from-ipns` MIGRATES from
 * an existing IPNS name: the core resolves that SOURCE name to the cid it points
 * at right now and pins THAT (reported as `resolved ipns <src> -> <cid>`), so
 * `pin --from-ipns <src> --as ronan --mode ipns` is the one-command ENS
 * migration: the source's current content on the operator's nodes, published
 * under the OPERATOR's own `ipns://<id>`. It is a SNAPSHOT, not a follow: the CLI
 * says so, and pulling a newer one is re-running the same command (the name is
 * stable; only the cid it points at moves). A source name that resolves nowhere
 * is a loud {@link PinSourceResolveError} (exit 1), never a silent success.
 *
 * `--mode` is the SAME per-site mode `deploy` takes (CONTEXT.md `mode`), here
 * defaulting to `ipfs` (pin + MFS only; the pin is addressed by the immutable
 * `ipfs://<cid>`). `--mode ipns` ADDS the operator's OWN stable name for the
 * mirrored content: the key derived from the env-ONLY master + the `--as <name>`
 * id (the same single-`id`-is-the-KDF-input rule as `derive`/`promote`) is
 * imported onto the PUBLISHER, which then signs `name/publish` for the pinned
 * cid. Re-pinning a newer cid under the same name moves that name.
 *
 * Two loud refusals guard the ipns path HERE, before the core is called, so the
 * message can name what the operator typed: an unset master (env-only, never
 * from `pinnace.json`), and a target set with no publisher in it (`--host` a
 * replica, or a publisher-less config) — a replica is keyless and never signs.
 * The core repeats the second check for library callers
 * ({@link PinPublisherRequiredError}).
 *
 * `--host <name>` NARROWS the fan-out to that one node (note this differs from
 * `site`/`promote`, where `--host` SELECTS the single node it acts on and is
 * required with several hosts; here omitting it means ALL nodes, matching
 * `deploy`). Each host's token is resolved env-only and LAZILY, so a host with
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

	// The mode surface is an explicit allow-list (same two values as a site's).
	const mode = (flags['mode'] ?? 'ipfs') as SiteMode;
	if (mode !== 'ipfs' && mode !== 'ipns') {
		rc.err(
			`pinnace pin: --mode must be 'ipfs' (pin + MFS only, the default) or 'ipns' (also publish the pin under your derived key)`,
		);
		return 1;
	}

	const cli = cliOverridesFromFlags(flags);
	const cfg = resolveConfig({file: rc.file, env: rc.env, cli});
	if (cfg.hosts.length === 0) {
		rc.err('pinnace pin: no hosts configured (add hosts to pinnace.json)');
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
	let derived: DerivedIpnsKey | undefined;
	if (mode === 'ipns') {
		const master = resolveMasterSecret({env: rc.env});
		if (!master) {
			rc.err(
				'pinnace pin: --mode ipns needs the master secret — export PINNACE_MASTER (env-only; never read from pinnace.json)',
			);
			return 1;
		}
		if (!hosts.some((h) => h.role === 'publisher')) {
			rc.err(
				`pinnace pin: --mode ipns needs a publisher to sign the name, but ` +
					`${hosts.map((h) => `${h.name} (${h.role})`).join(', ')} cannot — a ` +
					`replica is keyless and only re-announces the publisher's record. ` +
					`Pin with --mode ipfs, or target the publisher.`,
			);
			return 1;
		}
		// The `--as <name>` IS the site id AND the KDF input (one identifier).
		derived = rc.deps.deriveIpnsKey({master, keyId: pinName});
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
			mode,
			ensName,
			...(derived ? {derived} : {}),
		});
	} catch (error) {
		// The one failure the CLI cannot pre-check: the SOURCE name resolved on no
		// node, so there is no cid to pin (Kubo's own words come through).
		if (error instanceof PinSourceResolveError) {
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
 */
function cliOverridesFromFlags(flags: Record<string, string>): CliOverrides {
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

	const cli = cliOverridesFromFlags(flags);
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

/**
 * `pinnace promote <id> [--host <name>]` -> {@link
 * ClientDeps.promoteReplicaToPublisher} (spec user story 14). Derives the
 * per-site key from the env-only master + the site `id` (the KDF input,
 * {@link ClientDeps.deriveIpnsKey}), assembles the chosen host's client, and
 * promotes it: import the key + flip the role to publisher, recovering the name
 * within the record's validity window without content downtime. The master is
 * env-ONLY (never from `pinnace.json`); its absence is a LOUD error.
 */
async function runPromote(
	argv: readonly string[],
	rc: ResolvedRunContext,
): Promise<number> {
	const {flags, positionals} = parseArgs(argv);
	const [siteId] = positionals;
	if (!siteId) {
		rc.err('pinnace promote: usage: pinnace promote <id> [--host <name>]');
		return 1;
	}

	const master = resolveMasterSecret({env: rc.env});
	if (!master) {
		rc.err(
			'pinnace promote: master secret not set — export PINNACE_MASTER (env-only; never read from pinnace.json)',
		);
		return 1;
	}

	const cli = cliOverridesFromFlags(flags);
	const cfg = resolveConfig({file: rc.file, env: rc.env, cli});
	const host = pickHost('pinnace promote', flags['host'], cfg, rc);
	if (!host) return 1;
	const client = clientForHost('pinnace promote', host, rc, cli);
	if (!client) return 1;

	// The single `id` IS the KDF input (no separate keyId), matching `derive`.
	const id = cfg.sites.find((s) => s.id === siteId)?.id ?? siteId;
	const derived = rc.deps.deriveIpnsKey({master, keyId: id});
	const result = await rc.deps.promoteReplicaToPublisher({
		client,
		currentRole: host.role,
		keyName: id,
		derived,
	});
	rc.out(
		`promoted ${result.keyName} to ${result.role}${result.ipns ? ` (ipns ${result.ipns})` : ''}`,
	);
	return 0;
}

// ---------------------------------------------------------------------------
// Host selection + client assembly (shared by site + promote).
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
		rc.err(`${prefix}: no hosts configured (add hosts to pinnace.json)`);
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
