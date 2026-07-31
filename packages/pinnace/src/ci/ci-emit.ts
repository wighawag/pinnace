/**
 * The **CI emitter** behind the `CIProvider` seam (CONTEXT.md `CI provider
 * seam`). `install-ci` asks the core for a deploy pipeline: an emitter WRITES a
 * deploy workflow for a CI system and REPORTS the repo secrets the operator
 * must set. GitHub Actions is the FIRST (and, in v1, only) implementation;
 * other CI systems are Out of Scope but slot in behind this same seam later
 * (spec "Out of Scope"; user stories 16, 17).
 *
 * This module is PURE: {@link emitCi} takes a plain input and returns the file
 * (path + contents) plus the secrets report as data. It does NOT touch the
 * filesystem or the network. The CLI wrapper prints it, and writes it only
 * when asked (`--write`).
 *
 * WHAT THE EMITTED PIPELINE ACTUALLY DOES (and what it deliberately does not):
 *
 * 1. INFRASTRUCTURE IS ARGS, NOT ENV. The nodes are baked into the emitted YAML
 *    as literal `--endpoint` / `--replica-endpoint` args, and the site id as a
 *    literal positional. Endpoints and site ids are not secrets, so they belong
 *    in the diffable file rather than in a CI settings panel, and a workflow
 *    that names its own nodes needs no committed `pinnace.json`. The ONLY repo
 *    secrets are the per-host bearer tokens, whose env var names follow the
 *    CLI's ordinary `PINNACE_HOST_<NAME>_TOKEN` rule (`publisher`, `replica-1`,
 *    ... being the names `--endpoint`/`--replica-endpoint` synthesise). There is
 *    no CI-only env contract: an emitted pipeline speaks exactly the surface an
 *    operator speaks at their own shell.
 *
 *    Emitting with NO endpoint is legal and means "this repo commits a
 *    `pinnace.json`": the deploy line then carries no host args at all and the
 *    CLI resolves the file as usual (and fails loudly at run time if there is
 *    none). The report says so, and cannot name the token secrets, because only
 *    that file knows the host names.
 *
 * 2. ONE DEPLOY STEP, SHARED. Both emit targets ({@link CiEmitTarget}) render
 *    the SAME step, a `uses:` of the composite action this repo ships at
 *    `actions/deploy`. The action owns the `npx pinnace deploy --json` call, the
 *    step outputs (`cid`, `ipns`, `contenthash`) and the job summary, so the
 *    generated YAML cannot drift from the CLI behind it, and a fix to either
 *    reaches every repo on the next `@ref` bump instead of needing every
 *    generated workflow to be regenerated.
 *
 * 3. IT DOES NOT OWN YOUR BUILD. `emit: 'steps'` renders the deploy step ALONE,
 *    to paste into a workflow that already checks out, installs and builds
 *    however that repo builds (monorepo filters, env vars, matrixes, PR jobs).
 *    That is the composable target, and the honest one: no emitter can model
 *    every build. `emit: 'workflow'` renders a whole starter workflow for a
 *    greenfield repo, and even then the build is two knobs (a package manager
 *    for the install/cache steps, a build command) rather than a hardcoded
 *    `npm ci`.
 *
 * 4. THE OUTPUT DIRECTORY IS STATED, NEVER GUESSED. `outputDir` is required and
 *    baked literally. Auto-detection (`dist` / `build` / `out` / `public`) would
 *    silently deploy the wrong directory the day a repo has two of them.
 *
 * HISTORY. The first version of this emitter was ported from a reference
 * GitHub Action and invented an `IPFS_API` / `IPFS_TOKEN` / `SITE_NAME` env
 * contract that NOTHING in the CLI read, so the workflow it produced could not
 * deploy at all; its snapshot test only ever compared the string to itself. See
 * `work/notes/findings/install-ci-emits-a-workflow-the-cli-cannot-execute.md`.
 * The acceptance test for this module therefore asserts the emitted deploy
 * ARGV against the real `run()` dispatch, not only against a golden string.
 */
import type {SiteMode} from '../config/config-resolution.js';

/** The CI systems pinnace can emit for. v1 = GitHub Actions ONLY. */
export type CiSystem = 'github';

/** The CI systems, in a stable order (help text / iteration / validation). */
export const CI_SYSTEMS: readonly CiSystem[] = ['github'];

/**
 * WHAT to emit:
 *  - `workflow`: a complete starter workflow (checkout -> install -> build ->
 *    deploy) for a repo that has no CI yet.
 *  - `steps`: the deploy step ALONE, to paste into an existing workflow after
 *    whatever that repo already does to build. The composable target.
 */
export type CiEmitTarget = 'workflow' | 'steps';

/** The emit targets, in a stable order. */
export const CI_EMIT_TARGETS: readonly CiEmitTarget[] = ['workflow', 'steps'];

/** The package managers the full-workflow target knows how to install with. */
export type PackageManager = 'npm' | 'pnpm' | 'yarn';

/** The package managers, in a stable order. */
export const PACKAGE_MANAGERS: readonly PackageManager[] = [
	'npm',
	'pnpm',
	'yarn',
];

/** The repo path of the composite action the emitted step uses. */
export const DEPLOY_ACTION_PATH = 'wighawag/pinnace/actions/deploy';

/**
 * The default git ref the emitted step pins the composite action to.
 *
 * `main` rather than the CLI's own version tag because this repo's release tags
 * are named `pinnace@<version>`, and a `uses:` value is `owner/repo/path@ref`:
 * a ref containing `@` is not worth betting a generated file on. Pin it
 * yourself with `--action-ref <sha>` when you want an immutable one.
 */
export const DEFAULT_ACTION_REF = 'main';

/** The Node major the emitted workflow sets up (pinnace itself needs >= 22). */
export const DEFAULT_NODE_VERSION = '22';

/** One required repo secret the operator must set for the pipeline. */
export interface RequiredCiSetting {
	/** The env/secret NAME as referenced in the workflow. */
	name: string;
	/**
	 * `secret` (masked, e.g. bearer tokens) or `var` (a plain repo variable).
	 * Everything an emitted pipeline needs today is a secret: the non-secret
	 * infrastructure is baked into the file as args.
	 */
	kind: 'secret' | 'var';
	/** A human-readable note (what it is, where it comes from). */
	description: string;
	/** True when the setting is only needed in some setups (see the note). */
	optional?: boolean;
}

/** Inputs to {@link emitCi}: which system, which nodes, how the site builds. */
export interface EmitCiInput {
	/** Which CI system to emit for (v1: `github`). */
	system: CiSystem;
	/** What to emit (default `workflow`). */
	emit?: CiEmitTarget;
	/**
	 * The PUBLISHER node's Kubo RPC url, baked into the deploy step as
	 * `--endpoint`. Omitted => the emitted pipeline carries no host args and the
	 * repo must commit a `pinnace.json` (see the module doc).
	 */
	endpoint?: string;
	/**
	 * The REPLICA nodes' urls, baked as repeated `--replica-endpoint` args in
	 * this order (which is what names them `replica-1`, `replica-2`, ... and so
	 * decides their token secrets). Only meaningful with {@link endpoint}.
	 */
	replicaEndpoints?: string[];
	/** The site id to deploy (the MFS home + IPNS key input). REQUIRED. */
	site: string;
	/**
	 * The LIVE site id this one STAGES for, when {@link site} is a staging id.
	 *
	 * It changes no behaviour: it makes the job summary print the two steps that
	 * publish the build (`pin --from-site` then the ENS record), with the ids and
	 * the cid filled in. That is worth a flag because those are the steps a tool
	 * cannot take for you, and the summary is where someone is already looking.
	 *
	 * Meaningless in `ipns` mode, where the deploy re-signs the name itself and
	 * there is nothing to promote.
	 */
	promoteTo?: string;
	/**
	 * The mode to STATE on every deploy (`--set-mode`). Omitted => the emitted
	 * command states nothing, so each deploy PRESERVES the mode the site already
	 * stores. That is the rule the CLI has, not a CI-specific default.
	 */
	mode?: SiteMode;
	/** The directory the build outputs the static site to. REQUIRED. */
	outputDir: string;
	/** The build command (full-workflow target only). */
	buildCommand?: string;
	/** The package manager driving install + cache (full-workflow target). */
	packageManager?: PackageManager;
	/** The branch to deploy on push (full-workflow target; default `main`). */
	branch?: string;
	/** The Node.js version to set up (full-workflow target; default `22`). */
	nodeVersion?: string;
	/** The git ref the composite action is pinned to (default `main`). */
	actionRef?: string;
}

/** A single emitted file: where it goes + what it contains. */
export interface EmittedFile {
	/** The repo-relative path to write the file at. */
	path: string;
	/** The full file contents. */
	contents: string;
}

/**
 * What an emitter returns: the emitted YAML plus the secrets the operator must
 * set. `secrets` and `vars` stay split so the CLI can name the right settings
 * panel; `vars` is empty today because non-secret infrastructure is baked into
 * the file as args rather than read from CI variables.
 */
export interface EmittedCi {
	/** Which system this was emitted for (echoed for the caller). */
	system: CiSystem;
	/** What was emitted (echoed for the caller). */
	emit: CiEmitTarget;
	/** The emitted file (path + contents). For `steps`, a paste-in fragment. */
	workflow: EmittedFile;
	/** Whether the emitted file is a whole file that can be WRITTEN as-is. */
	writable: boolean;
	/** The required masked SECRETS (Settings -> Secrets). */
	secrets: RequiredCiSetting[];
	/** The required repo VARIABLES (Settings -> Variables). Empty today. */
	vars: RequiredCiSetting[];
}

/**
 * The `CIProvider` seam: one method that emits a deploy pipeline + its required
 * settings for a given input. v1 has a single implementation
 * ({@link githubCiProvider}); adding GitLab CI / others later means adding
 * another provider here and an entry in {@link CI_SYSTEMS}; deploy/publish
 * logic is untouched (spec user story 21).
 */
export interface CIProvider {
	/** The system this provider emits for. */
	readonly system: CiSystem;
	/** Emit the pipeline + secrets report for the given input. */
	emit(input: EmitCiInput): EmittedCi;
}

/**
 * The env var a host's bearer token is read from, duplicated from
 * `config-resolution`'s rule ONLY as a name renderer (uppercase, non-alphanumerics
 * to `_`). It is the same rule because the emitted workflow must set the exact
 * variable the CLI reads; the acceptance test asserts the two agree.
 */
function tokenEnvVar(hostName: string): string {
	return `PINNACE_HOST_${hostName.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_TOKEN`;
}

/** The host names the emitted args synthesise, publisher first. */
function hostNames(input: EmitCiInput): string[] {
	if (!input.endpoint) return [];
	return [
		'publisher',
		...(input.replicaEndpoints ?? []).map((_, i) => `replica-${i + 1}`),
	];
}

/**
 * The secrets an emitted pipeline needs: one bearer token per node it names,
 * plus the master ONLY when it might be needed.
 *
 * The master is reported as OPTIONAL on purpose. An `ipns` deploy needs a key,
 * but the publisher normally ALREADY holds it (`pinnace authorize <id>`, run
 * once from the operator's own machine), which is the whole point of that verb:
 * CI deploys forever with no master in the pipeline. So the report offers the
 * master as the alternative to authorizing, never as a requirement, and says
 * nothing at all for an `ipfs`-mode site, which signs nothing.
 */
function requiredSecrets(input: EmitCiInput): RequiredCiSetting[] {
	const names = hostNames(input);
	const secrets: RequiredCiSetting[] = names.map((name, i) => ({
		name: tokenEnvVar(name),
		kind: 'secret',
		description:
			i === 0
				? `Bearer token for the publisher node (${input.endpoint}).`
				: `Bearer token for ${name} (${(input.replicaEndpoints ?? [])[i - 1]}).`,
	}));
	if (names.length === 0) {
		secrets.push({
			name: 'PINNACE_HOST_<NAME>_TOKEN',
			kind: 'secret',
			description:
				'One bearer token per host in your committed pinnace.json, named ' +
				'after that host (host `publisher` -> PINNACE_HOST_PUBLISHER_TOKEN). ' +
				'Emit with --endpoint/--replica-endpoint instead and the exact names ' +
				'are reported here.',
		});
	}
	if (input.mode !== 'ipfs') {
		secrets.push({
			name: 'PINNACE_MASTER',
			kind: 'secret',
			description:
				'ONLY if this site is `ipns` mode AND the publisher does not already ' +
				'hold its key. Prefer running `pinnace authorize ' +
				`${input.site}\` once from your own machine, which leaves the master ` +
				'out of CI entirely.',
			optional: true,
		});
	}
	return secrets;
}

/** Render the deploy args exactly as the emitted step passes them. */
function deployArgs(input: EmitCiInput): string[] {
	const args = ['deploy', '--json'];
	if (input.endpoint) args.push('--endpoint', input.endpoint);
	for (const replica of input.replicaEndpoints ?? [])
		args.push('--replica-endpoint', replica);
	if (input.mode) args.push('--set-mode', input.mode);
	args.push(input.outputDir, input.site);
	return args;
}

/**
 * The emitted deploy args as the CLI would receive them, EXPOSED so the
 * acceptance test can feed them straight to `run()` and prove a generated
 * pipeline actually deploys (the check the original emitter never had).
 */
export function emittedDeployArgv(input: EmitCiInput): string[] {
	return deployArgs(input);
}

/** Indent every non-empty line of a block by `spaces`. */
function indent(block: string, spaces: number): string {
	const pad = ' '.repeat(spaces);
	return block
		.split('\n')
		.map((line) => (line.length > 0 ? pad + line : line))
		.join('\n');
}

/**
 * The ONE deploy step both targets render, as an unindented YAML list item.
 *
 * The node args are the action's INPUTS (visible, diffable infrastructure) and
 * the tokens are `env:` (secrets, referenced by the CLI's own variable names).
 * `env:` on a `uses:` step is inherited by the composite action's own run steps,
 * which is why the action needs no token inputs at all: it never handles a
 * secret value, it just runs a CLI that reads the environment.
 */
function renderDeployStep(input: EmitCiInput): string {
	const ref = input.actionRef ?? DEFAULT_ACTION_REF;
	const replicas = input.replicaEndpoints ?? [];
	const lines: string[] = [
		'- name: Deploy to IPFS',
		'  id: deploy',
		`  uses: ${DEPLOY_ACTION_PATH}@${ref}`,
		'  with:',
	];
	if (input.endpoint) lines.push(`    endpoint: ${input.endpoint}`);
	if (replicas.length > 0) {
		lines.push('    replica-endpoints: |');
		for (const replica of replicas) lines.push(`      ${replica}`);
	}
	lines.push(`    site: ${input.site}`);
	if (input.mode) lines.push(`    mode: ${input.mode}`);
	lines.push(`    dir: ${input.outputDir}`);
	if (input.promoteTo) lines.push(`    promote-to: ${input.promoteTo}`);
	const names = hostNames(input);
	if (names.length > 0) {
		lines.push('  env:');
		for (const name of names) {
			const env = tokenEnvVar(name);
			lines.push(`    ${env}: \${{ secrets.${env} }}`);
		}
	} else {
		// Fully COMMENTED, including the `env:` key itself: a mapping with only
		// comments under it parses as null, which GitHub rejects. The operator
		// uncomments one line per host in their pinnace.json.
		lines.push(
			'  # env: one secret per host in your committed pinnace.json, e.g.',
			'  #   PINNACE_HOST_PUBLISHER_TOKEN: ${{ secrets.PINNACE_HOST_PUBLISHER_TOKEN }}',
		);
	}
	return lines.join('\n');
}

/** The install + cache shape per package manager (full-workflow target). */
interface PackageManagerSteps {
	/** Steps that must precede `setup-node` (pnpm needs its own setup). */
	preSetup: string;
	/** The `cache:` value passed to setup-node. */
	cache: string;
	/** The install command. */
	install: string;
}

function packageManagerSteps(pm: PackageManager): PackageManagerSteps {
	switch (pm) {
		case 'pnpm':
			return {
				// No `version:` on purpose: pnpm's own action reads the repo's
				// `packageManager` field, and specifying both is an error
				// (ERR_PNPM_BAD_PM_VERSION).
				preSetup: '- uses: pnpm/action-setup@v4\n\n',
				cache: 'pnpm',
				install: 'pnpm install --frozen-lockfile',
			};
		case 'yarn':
			return {preSetup: '', cache: 'yarn', install: 'yarn install --immutable'};
		case 'npm':
		default:
			return {preSetup: '', cache: 'npm', install: 'npm ci'};
	}
}

/** The header comment both targets carry: what to set, and where it came from. */
function renderHeader(input: EmitCiInput, target: CiEmitTarget): string {
	const secrets = requiredSecrets(input);
	const lines = [
		'# =============================================================================',
		target === 'steps'
			? '# pinnace deploy step: paste into your existing workflow, after your build.'
			: '# pinnace: deploy a static site to your self-hosted IPFS node(s) on push.',
		'#',
		`# Generated by \`pinnace install-ci --system ${input.system}\`.`,
		'#',
		'# Your nodes are ARGS below (endpoints + site id are not secrets, so they are',
		'# in the file, not in CI settings). The only repo secrets are the bearer',
		'# tokens, under Settings -> Secrets and variables -> Actions:',
	];
	for (const secret of secrets) {
		lines.push(
			`#   ${secret.name}${secret.optional ? '  (only if needed)' : ''}`,
		);
	}
	if (!input.endpoint) {
		lines.push(
			'#',
			'# No --endpoint was given, so the deploy below reads your committed',
			'# pinnace.json for the node list (and fails loudly if there is none).',
		);
	}
	lines.push(
		'# =============================================================================',
	);
	return lines.join('\n');
}

/**
 * Render the GitHub Actions starter workflow: checkout -> package-manager setup
 * -> install -> build -> the shared deploy step. Deterministic: same input ->
 * byte-identical output (snapshot-locked).
 */
function renderGithubWorkflow(input: EmitCiInput): string {
	const branch = input.branch ?? 'main';
	const nodeVersion = input.nodeVersion ?? DEFAULT_NODE_VERSION;
	const pm = packageManagerSteps(input.packageManager ?? 'npm');
	const buildCommand = input.buildCommand ?? 'npm run build';

	return `${renderHeader(input, 'workflow')}
name: Deploy to IPFS

on:
  push:
    branches: [${branch}]
  workflow_dispatch: {}

concurrency:
  group: pinnace-deploy
  cancel-in-progress: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      ${pm.preSetup ? `${pm.preSetup}      ` : ''}- uses: actions/setup-node@v4
        with:
          node-version: ${nodeVersion}
          cache: ${pm.cache}

      - name: Install deps
        run: ${pm.install}

      - name: Build
        run: ${buildCommand}

${indent(renderDeployStep(input), 6)}
`;
}

/** Render the paste-in fragment: the header, then the deploy step alone. */
function renderGithubSteps(input: EmitCiInput): string {
	return `${renderHeader(input, 'steps')}
# Indented for a job's \`steps:\` list. The step's outputs are available to later
# steps as \${{ steps.deploy.outputs.cid }} / .ipns / .contenthash.

${indent(renderDeployStep(input), 6)}
`;
}

/**
 * The GitHub Actions provider: the first implementation of {@link CIProvider}.
 */
export const githubCiProvider: CIProvider = {
	system: 'github',
	emit(input: EmitCiInput): EmittedCi {
		const target = input.emit ?? 'workflow';
		const workflow: EmittedFile =
			target === 'steps'
				? {
						path: 'pinnace-deploy.steps.yml',
						contents: renderGithubSteps(input),
					}
				: {
						path: '.github/workflows/pinnace-deploy.yml',
						contents: renderGithubWorkflow(input),
					};
		return {
			system: 'github',
			emit: target,
			workflow,
			// A fragment is not a file: it is YAML to paste INTO one, so writing it
			// would produce a workflow GitHub cannot run.
			writable: target === 'workflow',
			secrets: requiredSecrets(input),
			vars: [],
		};
	},
};

/** The provider registry (system -> provider). v1 has a single entry. */
const PROVIDERS: Record<CiSystem, CIProvider> = {
	github: githubCiProvider,
};

/**
 * Emit a deploy pipeline for the requested CI system: dispatches to the
 * matching {@link CIProvider} and returns its file + secrets report. Throws
 * LOUDLY on an unknown/unimplemented system, an unknown emit target, or a
 * missing `site`/`outputDir`. Never a silent no-op, and never a guessed
 * output directory.
 */
export function emitCi(input: EmitCiInput): EmittedCi {
	const provider = PROVIDERS[input.system];
	if (!provider) {
		throw new Error(
			`unsupported CI system '${input.system}'; v1 emits only ${CI_SYSTEMS.join(
				', ',
			)} (other systems are Out of Scope but the CIProvider seam exists)`,
		);
	}
	if (input.emit && !CI_EMIT_TARGETS.includes(input.emit)) {
		throw new Error(
			`unknown emit target '${input.emit}'; expected one of ${CI_EMIT_TARGETS.join(', ')}`,
		);
	}
	if (!input.site) {
		throw new Error(
			'emitCi requires a `site`: the id the pipeline deploys (its MFS home ' +
				'and, in ipns mode, its key-derivation input)',
		);
	}
	if (!input.outputDir) {
		throw new Error(
			'emitCi requires an `outputDir`: the directory your build writes the ' +
				'static site to. It is never guessed: a repo with both a `dist` and ' +
				'a `build` would deploy the wrong one silently',
		);
	}
	if (input.promoteTo && input.mode === 'ipns') {
		throw new Error(
			`emitCi got promoteTo '${input.promoteTo}' with mode 'ipns': an ipns ` +
				'deploy re-signs its own name, so there is no staging build to ' +
				'promote. Staging exists for `ipfs` mode, where the address changes ' +
				'with every build and only a human can move the record',
		);
	}
	if (input.promoteTo && input.promoteTo === input.site) {
		throw new Error(
			`emitCi got promoteTo '${input.promoteTo}' equal to the site it ` +
				'deploys: a staging site and the live site it promotes into are two ' +
				'different ids (that is the whole point of staging)',
		);
	}
	if ((input.replicaEndpoints ?? []).length > 0 && !input.endpoint) {
		throw new Error(
			'emitCi got `replicaEndpoints` with no `endpoint`: replicas are the ' +
				'replicas OF a publisher, so the emitted pipeline would name nodes it ' +
				'has no publisher for (the same pairing the CLI enforces)',
		);
	}
	return provider.emit(input);
}
