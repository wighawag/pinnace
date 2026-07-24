#!/usr/bin/env node
/**
 * The `pinnace` CLI bin — a thin wrapper over the library core.
 *
 * It parses/formats only; ALL behaviour lives in the core (imported from
 * `../index.js`). It wires the client verbs (provision, deploy, install-ci,
 * status, derive) over the injectable `RunContext` seam in `./run.ts`; the
 * on-box `pinnace node <verb>` subcommands share this same binary but are wired
 * by their own task. Config/env/core are all injectable there so the dispatch
 * is unit-tested without a process or the operator's real env/config.
 */
import {run} from './run.js';

run(process.argv.slice(2)).then(
	(code) => process.exit(code),
	(err) => {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	},
);
