import {describe, it, expect} from 'vitest';
import {parse as parseYaml} from 'yaml';
import {readFileSync} from 'node:fs';
import {
	emitCi,
	emittedDeployArgv,
	githubCiProvider,
	CI_SYSTEMS,
	CI_EMIT_TARGETS,
	PACKAGE_MANAGERS,
	DEPLOY_ACTION_PATH,
	type EmitCiInput,
} from '../../src/ci/ci-emit.js';
import {hostTokenEnvVar} from '../../src/config/config-resolution.js';

/**
 * The CI emitter is a PURE function of its input (no filesystem, no network):
 * it returns the emitted YAML (path + contents) and the required repo secrets.
 * The CLI wrapper prints it, and writes it only on `--write`.
 *
 * These tests deliberately assert MORE than a golden string. The emitter's
 * first version passed its own snapshot while emitting a workflow that could
 * not deploy at all (it named `IPFS_API`/`IPFS_TOKEN`/`SITE_NAME`, which
 * nothing in the CLI reads. See
 * `work/notes/findings/install-ci-emits-a-workflow-the-cli-cannot-execute.md`).
 * So the checks below hold the emitted YAML against its REAL counterparties:
 * a YAML parser, the token env-var rule in `config-resolution`, the composite
 * action's declared inputs, and (in `cli/install-ci.test.ts`) the CLI's own
 * `deploy` dispatch.
 */

function baseInput(overrides: Partial<EmitCiInput> = {}): EmitCiInput {
	return {
		system: 'github',
		site: 'mysite.eth',
		outputDir: 'dist',
		endpoint: 'https://ipfs-a.example.com',
		...overrides,
	};
}

/** The composite action this repo ships, as the emitted step `uses:`. */
function actionDefinition(): {
	inputs: Record<string, {required?: boolean; default?: string}>;
	outputs: Record<string, unknown>;
} {
	return parseYaml(
		readFileSync(
			new URL('../../../../actions/deploy/action.yml', import.meta.url),
			'utf8',
		),
	);
}

describe('emitCi: the CIProvider seam', () => {
	it('emits GitHub Actions as the first (v1) implementation', () => {
		const result = emitCi(baseInput());
		expect(result.system).toBe('github');
		expect(result.emit).toBe('workflow');
		expect(result.workflow.path).toBe('.github/workflows/pinnace-deploy.yml');
	});

	it('lists exactly `github` as the only v1 CI system', () => {
		expect(CI_SYSTEMS).toEqual(['github']);
	});

	it('rejects an unimplemented CI system loudly (the seam exists, impls do not)', () => {
		expect(() => emitCi(baseInput({system: 'gitlab' as never}))).toThrow(
			/gitlab/i,
		);
	});

	it('refuses to guess what it was not told (site, output dir, lone replicas)', () => {
		expect(() => emitCi(baseInput({site: ''}))).toThrow(/site/i);
		expect(() => emitCi(baseInput({outputDir: ''}))).toThrow(/outputDir/i);
		// A guessed output dir would silently deploy the wrong directory.
		expect(() => emitCi(baseInput({outputDir: ''}))).toThrow(/never guessed/i);
		expect(() =>
			emitCi(
				baseInput({
					endpoint: undefined,
					replicaEndpoints: ['https://b.example'],
				}),
			),
		).toThrow(/publisher/i);
		expect(() => emitCi(baseInput({emit: 'nonsense' as never}))).toThrow(
			/emit target/i,
		);
	});
});

describe('emitCi: the emitted pipeline speaks the CLI’s real surface', () => {
	it('bakes the nodes as ARGS and asks only for token secrets', () => {
		const result = emitCi(
			baseInput({
				replicaEndpoints: ['https://ipfs-b.example.com'],
				mode: 'ipfs',
			}),
		);
		// Infrastructure is in the file, not in CI settings.
		expect(result.workflow.contents).toContain(
			'endpoint: https://ipfs-a.example.com',
		);
		expect(result.workflow.contents).toContain('https://ipfs-b.example.com');
		expect(result.workflow.contents).toContain('site: mysite.eth');
		// No CI-only env contract survives anywhere.
		expect(result.workflow.contents).not.toMatch(
			/IPFS_API|SITE_NAME|IPFS_TOKEN/,
		);
		expect(result.vars).toEqual([]);
		// The ONLY secrets are the per-host tokens, named by the CLI's own rule.
		expect(result.secrets.map((s) => s.name)).toEqual([
			hostTokenEnvVar('publisher'),
			hostTokenEnvVar('replica-1'),
		]);
	});

	it('names each token secret exactly as config-resolution reads it', () => {
		const result = emitCi(
			baseInput({
				replicaEndpoints: ['https://b.example', 'https://c.example'],
			}),
		);
		for (const host of ['publisher', 'replica-1', 'replica-2']) {
			const envVar = hostTokenEnvVar(host);
			expect(result.workflow.contents).toContain(
				`${envVar}: \${{ secrets.${envVar} }}`,
			);
		}
	});

	it('emits the deploy argv the CLI actually accepts (args, not env)', () => {
		expect(
			emittedDeployArgv(
				baseInput({
					replicaEndpoints: ['https://b.example'],
					mode: 'ipfs',
					outputDir: 'web/build',
					site: 'mandalas.eth',
				}),
			),
		).toEqual([
			'deploy',
			'--json',
			'--endpoint',
			'https://ipfs-a.example.com',
			'--replica-endpoint',
			'https://b.example',
			'--set-mode',
			'ipfs',
			'web/build',
			'mandalas.eth',
		]);
	});

	it('states no mode when none was chosen, so each deploy PRESERVES', () => {
		const argv = emittedDeployArgv(baseInput());
		expect(argv).not.toContain('--set-mode');
		expect(emitCi(baseInput()).workflow.contents).not.toContain('mode:');
	});

	it('offers PINNACE_MASTER as optional (authorize once is the CI path)', () => {
		const ipns = emitCi(baseInput({mode: 'ipns'}));
		const master = ipns.secrets.find((s) => s.name === 'PINNACE_MASTER')!;
		expect(master.optional).toBe(true);
		expect(master.description).toMatch(/authorize/);
		// An ipfs-mode site signs nothing, so it is never asked for at all.
		expect(
			emitCi(baseInput({mode: 'ipfs'})).secrets.map((s) => s.name),
		).not.toContain('PINNACE_MASTER');
	});

	it('with no endpoint, defers to a committed pinnace.json and says so', () => {
		const result = emitCi(baseInput({endpoint: undefined}));
		expect(emittedDeployArgv(baseInput({endpoint: undefined}))).not.toContain(
			'--endpoint',
		);
		expect(result.workflow.contents).toMatch(/pinnace\.json/);
		expect(result.secrets[0]!.name).toBe('PINNACE_HOST_<NAME>_TOKEN');
	});
});

describe('emitCi: the emitted YAML is valid and matches the action', () => {
	for (const emit of CI_EMIT_TARGETS) {
		it(`parses as YAML (${emit})`, () => {
			const {contents} = emitCi(baseInput({emit})).workflow;
			expect(() => parseYaml(contents)).not.toThrow();
		});
	}

	it('wires a workflow GitHub can run (on/jobs/steps, node 22 by default)', () => {
		const parsed = parseYaml(emitCi(baseInput()).workflow.contents);
		expect(parsed.name).toBe('Deploy to IPFS');
		expect(parsed.jobs.deploy['runs-on']).toBe('ubuntu-latest');
		const steps = parsed.jobs.deploy.steps as Array<Record<string, unknown>>;
		const setup = steps.find((s) => String(s.uses).includes('setup-node'))!;
		expect((setup.with as {'node-version': number})['node-version']).toBe(22);
		const deploy = steps.at(-1)!;
		expect(deploy.uses).toBe(`${DEPLOY_ACTION_PATH}@main`);
		expect(deploy.id).toBe('deploy');
	});

	it('passes only inputs the composite action declares, and all required ones', () => {
		const action = actionDefinition();
		const parsed = parseYaml(
			emitCi(baseInput({replicaEndpoints: ['https://b.example'], mode: 'ipfs'}))
				.workflow.contents,
		);
		const deploy = (
			parsed.jobs.deploy.steps as Array<Record<string, unknown>>
		).at(-1)!;
		const given = Object.keys(deploy.with as Record<string, unknown>);
		for (const key of given) expect(Object.keys(action.inputs)).toContain(key);
		const required = Object.entries(action.inputs)
			.filter(([, spec]) => spec.required)
			.map(([key]) => key);
		for (const key of required) expect(given).toContain(key);
	});

	it('exposes the outputs the summary and later steps rely on', () => {
		const action = actionDefinition();
		expect(Object.keys(action.outputs)).toEqual(
			expect.arrayContaining(['cid', 'ipns', 'mode', 'contenthash', 'url']),
		);
	});

	it('the steps fragment is the deploy step ALONE, and is not a file', () => {
		const result = emitCi(baseInput({emit: 'steps'}));
		expect(result.writable).toBe(false);
		const steps = parseYaml(result.workflow.contents) as Array<
			Record<string, unknown>
		>;
		expect(Array.isArray(steps)).toBe(true);
		expect(steps).toHaveLength(1);
		expect(steps[0]!.uses).toBe(`${DEPLOY_ACTION_PATH}@main`);
		// It owns no build: that is the caller's existing workflow.
		expect(result.workflow.contents).not.toContain('actions/checkout');
		expect(result.workflow.contents).not.toContain('Install deps');
	});

	it('passes promote-to through, for the summary’s publish recipe', () => {
		const result = emitCi(
			baseInput({
				site: 'mysite-staging',
				promoteTo: 'mysite.eth',
				mode: 'ipfs',
			}),
		);
		const parsed = parseYaml(result.workflow.contents);
		const deploy = (
			parsed.jobs.deploy.steps as Array<Record<string, unknown>>
		).at(-1)!;
		expect((deploy.with as {'promote-to': string})['promote-to']).toBe(
			'mysite.eth',
		);
		// And it is a real input of the action, not a name only the emitter knows.
		expect(Object.keys(actionDefinition().inputs)).toContain('promote-to');
	});

	it('refuses a promotion target that makes no sense', () => {
		// ipns re-signs its own name: there is nothing to promote.
		expect(() =>
			emitCi(baseInput({promoteTo: 'mysite.eth', mode: 'ipns'})),
		).toThrow(/ipns/);
		// Staging into itself is not staging.
		expect(() =>
			emitCi(baseInput({site: 'mysite.eth', promoteTo: 'mysite.eth'})),
		).toThrow(/two\s+different ids/);
	});

	it('pins the action to a chosen ref', () => {
		expect(
			emitCi(baseInput({actionRef: 'abc123'})).workflow.contents,
		).toContain(`${DEPLOY_ACTION_PATH}@abc123`);
	});
});

describe('emitCi: the build is knobs, never hardcoded npm', () => {
	it('installs with the chosen package manager (and sets its cache)', () => {
		const expectations: Record<
			(typeof PACKAGE_MANAGERS)[number],
			{install: string; cache: string}
		> = {
			npm: {install: 'npm ci', cache: 'npm'},
			pnpm: {install: 'pnpm install --frozen-lockfile', cache: 'pnpm'},
			yarn: {install: 'yarn install --immutable', cache: 'yarn'},
		};
		for (const pm of PACKAGE_MANAGERS) {
			const parsed = parseYaml(
				emitCi(baseInput({packageManager: pm})).workflow.contents,
			);
			const steps = parsed.jobs.deploy.steps as Array<Record<string, unknown>>;
			const install = steps.find((s) => s.name === 'Install deps')!;
			expect(install.run).toBe(expectations[pm].install);
			const setup = steps.find((s) => String(s.uses).includes('setup-node'))!;
			expect((setup.with as {cache: string}).cache).toBe(
				expectations[pm].cache,
			);
		}
	});

	it('sets pnpm up BEFORE setup-node (its cache needs the binary)', () => {
		const parsed = parseYaml(
			emitCi(baseInput({packageManager: 'pnpm'})).workflow.contents,
		);
		const steps = parsed.jobs.deploy.steps as Array<Record<string, unknown>>;
		const pnpmAt = steps.findIndex((s) =>
			String(s.uses).includes('pnpm/action-setup'),
		);
		const nodeAt = steps.findIndex((s) =>
			String(s.uses).includes('setup-node'),
		);
		expect(pnpmAt).toBeGreaterThanOrEqual(0);
		expect(pnpmAt).toBeLessThan(nodeAt);
		// pnpm's own action reads `packageManager`; pinning both is an error.
		expect(parsed.jobs.deploy.steps[pnpmAt].with).toBeUndefined();
	});

	it('honours a custom build command, branch and node version', () => {
		const parsed = parseYaml(
			emitCi(
				baseInput({
					buildCommand: 'pnpm build mainnet',
					branch: 'release',
					nodeVersion: '24',
				}),
			).workflow.contents,
		);
		const steps = parsed.jobs.deploy.steps as Array<Record<string, unknown>>;
		expect(steps.find((s) => s.name === 'Build')!.run).toBe(
			'pnpm build mainnet',
		);
		expect(parsed.on.push.branches).toEqual(['release']);
		const setup = steps.find((s) => String(s.uses).includes('setup-node'))!;
		expect((setup.with as {'node-version': number})['node-version']).toBe(24);
	});
});

describe('emitCi: snapshot of the generated workflow', () => {
	it('snapshots a two-node ipfs-mode pnpm workflow', () => {
		const result = emitCi(
			baseInput({
				site: 'mandalas.eth',
				outputDir: 'web/build',
				mode: 'ipfs',
				packageManager: 'pnpm',
				buildCommand: 'pnpm build mainnet',
				replicaEndpoints: ['https://ipfs-b.example.com'],
			}),
		);
		expect(result.workflow.contents).toMatchInlineSnapshot(`
			"# =============================================================================
			# pinnace: deploy a static site to your self-hosted IPFS node(s) on push.
			#
			# Generated by \`pinnace install-ci --system github\`.
			#
			# Your nodes are ARGS below (endpoints + site id are not secrets, so they are
			# in the file, not in CI settings). The only repo secrets are the bearer
			# tokens, under Settings -> Secrets and variables -> Actions:
			#   PINNACE_HOST_PUBLISHER_TOKEN
			#   PINNACE_HOST_REPLICA_1_TOKEN
			# =============================================================================
			name: Deploy to IPFS

			on:
			  push:
			    branches: [main]
			  workflow_dispatch: {}

			concurrency:
			  group: pinnace-deploy
			  cancel-in-progress: true

			jobs:
			  deploy:
			    runs-on: ubuntu-latest
			    steps:
			      - uses: actions/checkout@v4

			      - uses: pnpm/action-setup@v4

			      - uses: actions/setup-node@v4
			        with:
			          node-version: 22
			          cache: pnpm

			      - name: Install deps
			        run: pnpm install --frozen-lockfile

			      - name: Build
			        run: pnpm build mainnet

			      - name: Deploy to IPFS
			        id: deploy
			        uses: wighawag/pinnace/actions/deploy@main
			        with:
			          endpoint: https://ipfs-a.example.com
			          replica-endpoints: |
			            https://ipfs-b.example.com
			          site: mandalas.eth
			          mode: ipfs
			          dir: web/build
			        env:
			          PINNACE_HOST_PUBLISHER_TOKEN: \${{ secrets.PINNACE_HOST_PUBLISHER_TOKEN }}
			          PINNACE_HOST_REPLICA_1_TOKEN: \${{ secrets.PINNACE_HOST_REPLICA_1_TOKEN }}
			"
		`);
	});

	it('githubCiProvider is the same emitter reachable directly via the seam', () => {
		const viaSeam = githubCiProvider.emit(baseInput());
		const viaDispatch = emitCi(baseInput());
		expect(viaSeam.workflow.contents).toBe(viaDispatch.workflow.contents);
		expect(viaSeam.secrets).toEqual(viaDispatch.secrets);
	});
});
