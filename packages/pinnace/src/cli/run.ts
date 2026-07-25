/**
 * The CLI dispatch surface, separated from the executable shebang entry
 * (bin.ts) so it is unit-testable without spawning a process. It is a THIN
 * wrapper: it parses/validates args, resolves config (arg > env > file), calls
 * the core, and formats the result. ALL behaviour lives in the core (CONTEXT.md
 * `core vs cli`); nothing here re-implements domain logic.
 *
 * The client-facing verbs (provision, deploy, install-ci, status, derive) and
 * the config/env layer dispatch through an injectable {@link RunContext} seam:
 *  - {@link RunContext.deps} are the core functions each verb calls (defaults to
 *    the real core; tests inject stubs to assert dispatch + resolved args),
 *  - {@link RunContext.env} + {@link RunContext.loadConfigFile} are the env and
 *    `pinnace.json` layers (defaults read the real `process.env` + file; tests
 *    inject in-memory values so the operator's real environment/config is never
 *    read or mutated — mirroring the `NodeCommandOps` injectable-ops pattern in
 *    node-commands and the explicit-`env` resolver in config-resolution).
 *
 * The on-box `pinnace node <verb>` and the `pinnace site <verb>` namespaces are
 * validated here for surface coherence (one CLI), but their full dispatch is
 * wired by their own tasks (node-agent-commands, site-management).
 */
import {readFileSync} from 'node:fs';
import {name} from '../index.js';
import {NODE_VERBS, type NodeVerb} from '../node/node-commands.js';
import {SITE_VERBS, type SiteVerb} from '../site/site-management.js';
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
}

/** The real core, used when a caller does not inject stubs. */
const DEFAULT_DEPS: ClientDeps = {
	provision: coreProvision,
	deploy: coreDeploy,
	emitCi: coreEmitCi,
	statusReport: coreStatusReport,
	deriveIpnsId: coreDeriveIpnsId,
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
 * Routes the client verbs (provision/deploy/install-ci/status/derive), the
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
 */
function parseArgs(argv: readonly string[]): ParsedArgs {
	const flags: Record<string, string> = {};
	const positionals: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (token.startsWith('--')) {
			const key = token.slice(2);
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
 * `deploy [--mode <m>] <dir> <id>` -> core {@link ClientDeps.deploy}. Resolves
 * every configured host into a {@link DeployTarget} (each host's OWN token
 * resolved env-only, LAZILY, via {@link resolveHostToken} — CLI > env, no file),
 * and the site's `mode` from the matching `pinnace.json` site entry (overridable
 * with `--mode`). A host with no resolvable token FAILS LOUD naming its exact
 * env var. Prints the resulting CID / per-node breakdown.
 */
async function runDeploy(
	argv: readonly string[],
	rc: ResolvedRunContext,
): Promise<number> {
	const {flags, positionals} = parseArgs(argv);
	const [dir, siteId] = positionals;
	if (!dir || !siteId) {
		rc.err(
			'pinnace deploy: usage: pinnace deploy [--mode ipfs|ipns] <dir> <id>',
		);
		return 1;
	}

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
	const input: DeployInput = {sourceDir: dir, id: siteId, mode, targets};

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

// ---------------------------------------------------------------------------
// Shared helpers.
// ---------------------------------------------------------------------------

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
 * Parse `pinnace site <verb>` and validate the verb. The full context (Kubo
 * client from config-resolution, the site name / CID args) is assembled by the
 * CLI wiring in the site-management task; this thin router validates the verb
 * belongs to the `site` namespace. The three verbs (list/remove/add) are
 * implemented in `../site/site-management.ts`.
 */
function runSiteCli(argv: readonly string[], rc: ResolvedRunContext): number {
	const [verb] = argv;
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
	return 0;
}

/**
 * Parse `pinnace node <verb>` and validate the verb. The full on-box context
 * (local Kubo client, role, on-box paths) is assembled by the cloud-init /
 * config-resolution wiring in the node-agent-commands task; this thin router
 * only validates the verb belongs to the `node` namespace.
 */
function runNodeCli(argv: readonly string[], rc: ResolvedRunContext): number {
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
	return 0;
}
