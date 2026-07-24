/**
 * The CLI dispatch surface, separated from the executable shebang entry
 * (bin.ts) so it is unit-testable without spawning a process. It is a thin
 * wrapper: it reads args and calls the core, formatting the result.
 */
import {name} from '../index.js';
import {NODE_VERBS, type NodeVerb} from '../node/node-commands.js';
import {SITE_VERBS, type SiteVerb} from '../site/site-management.js';

/**
 * Dispatch a pinnace CLI invocation. Returns the process exit code.
 *
 * `version` is the scaffold stub; the `node` namespace routes the on-box verbs
 * (`pinnace node <verb>`). The real client verbs
 * (provision/deploy/install-ci/status/derive) wire over this same seam in
 * later tasks.
 */
export async function run(argv: readonly string[]): Promise<number> {
	const [command, ...rest] = argv;
	if (command === 'version' || command === '--version' || command === '-v') {
		console.log(name());
		return 0;
	}
	if (command === 'node') {
		return runNodeCli(rest);
	}
	if (command === 'site') {
		return runSiteCli(rest);
	}
	console.log(`${name()}: no command given`);
	return 0;
}

/**
 * Parse `pinnace site <verb>` and validate the verb. The full context (Kubo
 * client from config-resolution, the site name / CID args) is assembled by the
 * CLI wiring in a later task; this thin router validates the verb belongs to
 * the `site` namespace, keeping the CLI a parse/format layer over the core
 * (CONTEXT.md `core vs cli`). The three verbs (list/remove/add) are implemented
 * in `../site/site-management.ts`.
 */
function runSiteCli(argv: readonly string[]): number {
	const [verb] = argv;
	if (!verb) {
		console.error(`pinnace site: expected a verb (${SITE_VERBS.join(', ')})`);
		return 1;
	}
	if (!SITE_VERBS.includes(verb as SiteVerb)) {
		console.error(
			`pinnace site: unknown verb '${verb}'; expected one of ${SITE_VERBS.join(', ')}`,
		);
		return 1;
	}
	return 0;
}

/**
 * Parse `pinnace node <verb>` and validate the verb. The full on-box context
 * (local Kubo client, role, on-box paths) is assembled by the cloud-init /
 * config-resolution wiring in a later task; this thin router only validates the
 * verb belongs to the `node` namespace and reports the surface, keeping the
 * CLI a parse/format layer over the core (CONTEXT.md `core vs cli`).
 */
function runNodeCli(argv: readonly string[]): number {
	const [verb] = argv;
	if (!verb) {
		console.error(`pinnace node: expected a verb (${NODE_VERBS.join(', ')})`);
		return 1;
	}
	if (!NODE_VERBS.includes(verb as NodeVerb)) {
		console.error(
			`pinnace node: unknown verb '${verb}'; expected one of ${NODE_VERBS.join(', ')}`,
		);
		return 1;
	}
	return 0;
}
