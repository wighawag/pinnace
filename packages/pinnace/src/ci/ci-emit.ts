/**
 * The **CI emitter** behind the `CIProvider` seam (CONTEXT.md `CI provider
 * seam`). `install-ci` asks the core for a deploy pipeline: an emitter WRITES a
 * deploy workflow for a CI system and REPORTS the repo secrets/vars the
 * operator must set. GitHub Actions is the FIRST (and, in v1, only)
 * implementation; other CI systems are Out of Scope but slot in behind this
 * same seam later (spec "Out of Scope"; user stories 16, 17).
 *
 * This module is PURE: {@link emitCi} takes a plain input and returns the
 * workflow file (path + contents) plus the secrets/vars report as data. It does
 * NOT touch the filesystem or the network — the CLI wrapper (`cli-command-
 * wrapper` task) is what writes the file to `.github/workflows/` and prints the
 * report. Keeping the emit pure lets it be snapshot-tested as a string with no
 * fixtures (test-first policy) and reused as a TypeScript API (CONTEXT.md `core
 * vs cli`).
 *
 * BEHAVIOUR PORTED (not copied) from the reference GitHub Action
 * `~/searches/ipfs-hetzner/github-workflow.yml`: the shape is checkout ->
 * setup-node -> install -> build -> a `deploy` step reading the multi-node env
 * contract (`IPFS_API`/`IPFS_TOKEN` comma-separated, publisher first),
 * `SITE_NAME`, `SITE_MODE` -> a run-summary. Two deliberate CORRECTIONS vs the
 * reference: (1) the deploy step invokes `pinnace deploy` (this tool now OWNS
 * deploy) instead of a copied `deploy-car.mjs` script — one implementation, no
 * bash/TS drift; (2) the same env contract carries the MULTI-NODE + per-site
 * `mode` semantics (same CID to all nodes; the publisher publishes the record,
 * replicas mirror) which the deploy core (`deploy-multi-target` +
 * `publisher-replica-model` tasks) enforces — the workflow just passes the env
 * through.
 */

/** The CI systems pinnace can emit for. v1 = GitHub Actions ONLY. */
export type CiSystem = 'github';

/** The CI systems, in a stable order (help text / iteration / validation). */
export const CI_SYSTEMS: readonly CiSystem[] = ['github'];

/** One required repo secret or variable the operator must set for the pipeline. */
export interface RequiredCiSetting {
	/** The env/secret/var NAME as referenced in the workflow (e.g. `IPFS_API`). */
	name: string;
	/**
	 * `secret` (masked, e.g. tokens) or `var` (plain repo variable, e.g. URLs /
	 * names). GitHub stores these separately; the report tells the operator
	 * which panel each belongs in.
	 */
	kind: 'secret' | 'var';
	/** A human-readable note (what it is, format, an example). */
	description: string;
	/**
	 * True when the value is a COMMA-SEPARATED list, one per target node with
	 * the PUBLISHER FIRST (the multi-node contract). `IPFS_API`/`IPFS_TOKEN` are
	 * multi-node; `SITE_NAME`/`SITE_MODE` are single values.
	 */
	multiNode: boolean;
	/** An example value, shown in the report to make the format concrete. */
	example: string;
}

/** Inputs to {@link emitCi}: which system + how the site builds. */
export interface EmitCiInput {
	/** Which CI system to emit for (v1: `github`). */
	system: CiSystem;
	/** The build command that produces the static output dir (e.g. `npm run build`). */
	buildCommand: string;
	/** The directory the build outputs the static site to (e.g. `dist`). */
	outputDir: string;
	/** The branch to deploy on push (default `main`). */
	branch?: string;
	/** The Node.js version the workflow sets up (default `20`). */
	nodeVersion?: string;
}

/** A single emitted file: where it goes + what it contains. */
export interface EmittedFile {
	/** The repo-relative path to write the file at. */
	path: string;
	/** The full file contents. */
	contents: string;
}

/**
 * What an emitter returns: the workflow file plus the secrets/vars the operator
 * must set. `secrets` and `vars` are split so the CLI can tell the operator
 * exactly which GitHub settings panel each value belongs in.
 */
export interface EmittedCi {
	/** Which system this was emitted for (echoed for the caller). */
	system: CiSystem;
	/** The deploy workflow file (path + contents). */
	workflow: EmittedFile;
	/** The required masked SECRETS (Settings -> Secrets). */
	secrets: RequiredCiSetting[];
	/** The required repo VARIABLES (Settings -> Variables). */
	vars: RequiredCiSetting[];
}

/**
 * The `CIProvider` seam: one method that emits a deploy pipeline + its required
 * settings for a given input. v1 has a single implementation
 * ({@link githubCiProvider}); adding GitLab CI / others later means adding
 * another provider here and an entry in {@link CI_SYSTEMS} — deploy/publish
 * logic is untouched (spec user story 21).
 */
export interface CIProvider {
	/** The system this provider emits for. */
	readonly system: CiSystem;
	/** Emit the workflow + secrets/vars report for the given input. */
	emit(input: EmitCiInput): EmittedCi;
}

/**
 * The multi-node + per-site-mode env contract, shared by the reported
 * secrets/vars and the workflow's deploy step (single source so they never
 * drift). Order is stable: publisher-first multi-node inputs, then the site
 * name/mode. `IPFS_TOKEN` is the sole secret; the rest are plain vars.
 */
const IPFS_API_SETTING: RequiredCiSetting = {
	name: 'IPFS_API',
	kind: 'var',
	multiNode: true,
	description:
		'Kubo RPC endpoint(s). One URL, or comma-separated for MULTIPLE nodes ' +
		'(publisher first, replicas after). Same CID lands on every node.',
	example: 'https://ipfs-a.you.com,https://ipfs-b.you.com',
};

const IPFS_TOKEN_SETTING: RequiredCiSetting = {
	name: 'IPFS_TOKEN',
	kind: 'secret',
	multiNode: true,
	description:
		'Bearer token(s) guarding the RPC API. One token, or comma-separated ' +
		'tokens in the SAME order as IPFS_API (publisher first).',
	example: 'tokenA,tokenB',
};

const SITE_NAME_SETTING: RequiredCiSetting = {
	name: 'SITE_NAME',
	kind: 'var',
	multiNode: false,
	description: 'The site name / ENS name this deploy targets.',
	example: 'mysite.eth',
};

const SITE_MODE_SETTING: RequiredCiSetting = {
	name: 'SITE_MODE',
	kind: 'var',
	multiNode: false,
	description:
		"Per-site mode: 'ipfs' (immutable, ENS ipfs://<cid> per deploy) or " +
		"'ipns' (mutable, publisher publishes the record, replicas mirror). " +
		"Defaults to 'ipns'.",
	example: 'ipns',
};

/** All settings in report order (drives both the report split and validation). */
const ALL_SETTINGS: readonly RequiredCiSetting[] = [
	IPFS_API_SETTING,
	IPFS_TOKEN_SETTING,
	SITE_NAME_SETTING,
	SITE_MODE_SETTING,
];

/**
 * Render the GitHub Actions deploy workflow. Ports the reference Action's shape
 * (checkout -> setup-node -> install -> build -> deploy reading the env
 * contract -> run summary), but the deploy step calls `pinnace deploy` (this
 * tool owns deploy) and the env carries the multi-node + per-site-mode
 * semantics the deploy core enforces. Deterministic: same input -> byte-
 * identical output (snapshot-locked).
 */
function renderGithubWorkflow(input: EmitCiInput): string {
	const branch = input.branch ?? 'main';
	const nodeVersion = input.nodeVersion ?? '20';
	const buildCommand = input.buildCommand;
	const outputDir = input.outputDir;

	return `# =============================================================================
# pinnace: deploy a static site to your self-hosted IPFS node(s) on push.
#
# Generated by \`pinnace install-ci --system github\`. Edit BUILD/OUTPUT below
# for your stack; the deploy step is owned by the \`pinnace\` CLI.
#
# Set these in your repo (Settings -> Secrets and variables -> Actions):
#   IPFS_API    (variable) one URL, OR comma-separated for MULTIPLE nodes,
#               publisher first (e.g. https://ipfs-a.you.com,https://ipfs-b.you.com)
#   IPFS_TOKEN  (secret)   matching token(s), comma-separated in the SAME order
#   SITE_NAME   (variable) e.g. mysite.eth
#   SITE_MODE   (variable) ipfs | ipns  (default ipns)
#
# Multiple nodes serve the SAME CID (redundancy). In ipns mode the PUBLISHER
# (first in IPFS_API) publishes the signed record; replicas mirror it.
# =============================================================================
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

      - uses: actions/setup-node@v4
        with:
          node-version: ${nodeVersion}
          cache: npm

      - name: Install deps
        run: npm ci

      - name: Build
        run: ${buildCommand}

      - name: Deploy to IPFS node(s)
        id: deploy
        env:
          IPFS_API: \${{ vars.IPFS_API }}
          IPFS_TOKEN: \${{ secrets.IPFS_TOKEN }}
          SITE_NAME: \${{ vars.SITE_NAME }}
          SITE_MODE: \${{ vars.SITE_MODE || 'ipns' }}
        run: |
          npx pinnace deploy --mode "$SITE_MODE" "${outputDir}" "$SITE_NAME"

      - name: Summary
        if: always()
        run: |
          echo "### IPFS deploy" >> "$GITHUB_STEP_SUMMARY"
          echo "" >> "$GITHUB_STEP_SUMMARY"
          echo "- CID:  \\\`\${{ steps.deploy.outputs.cid }}\\\`" >> "$GITHUB_STEP_SUMMARY"
          echo "- IPNS: \\\`\${{ steps.deploy.outputs.ipns }}\\\`" >> "$GITHUB_STEP_SUMMARY"
          echo "- Preview: https://\${{ steps.deploy.outputs.cid }}.ipfs.dweb.link/" >> "$GITHUB_STEP_SUMMARY"
`;
}

/**
 * The GitHub Actions provider — the first implementation of {@link CIProvider}.
 * Emits the deploy workflow to the conventional GitHub path and reports the
 * secrets/vars split into the two GitHub settings panels.
 */
export const githubCiProvider: CIProvider = {
	system: 'github',
	emit(input: EmitCiInput): EmittedCi {
		return {
			system: 'github',
			workflow: {
				path: '.github/workflows/pinnace-deploy.yml',
				contents: renderGithubWorkflow(input),
			},
			secrets: ALL_SETTINGS.filter((s) => s.kind === 'secret'),
			vars: ALL_SETTINGS.filter((s) => s.kind === 'var'),
		};
	},
};

/** The provider registry (system -> provider). v1 has a single entry. */
const PROVIDERS: Record<CiSystem, CIProvider> = {
	github: githubCiProvider,
};

/**
 * Emit a deploy pipeline for the requested CI system: dispatches to the
 * matching {@link CIProvider} and returns its workflow + secrets/vars report.
 * Throws LOUDLY on an unknown/unimplemented system (the seam exists so callers
 * can add systems later, but v1 only ships `github`) — never a silent no-op.
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
	return provider.emit(input);
}
