/**
 * The CLI dispatch surface, separated from the executable shebang entry
 * (bin.ts) so it is unit-testable without spawning a process. It is a thin
 * wrapper: it reads args and calls the core, formatting the result.
 */
import {name} from '../index.js';

/**
 * Dispatch a pinnace CLI invocation. Returns the process exit code.
 *
 * Only a `--version`/`version` stub exists at scaffold time; later tasks wire
 * the real client verbs (provision/deploy/install-ci/status/derive) and the
 * on-box `node` subcommands over this same seam.
 */
export async function run(argv: readonly string[]): Promise<number> {
	const [command] = argv;
	if (command === 'version' || command === '--version' || command === '-v') {
		console.log(name());
		return 0;
	}
	console.log(`${name()}: no command given`);
	return 0;
}
