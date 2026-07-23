#!/usr/bin/env node
/**
 * The `pinnace` CLI bin — a thin wrapper over the library core.
 *
 * It parses/formats only; ALL behaviour lives in the core (imported from
 * `../index.js`). Client verbs (provision, deploy, install-ci, status, derive)
 * and the on-box `pinnace node <verb>` subcommands are added by later tasks;
 * this stub only establishes the core-vs-cli seam.
 */
import {run} from './run.js';

run(process.argv.slice(2)).then(
	(code) => process.exit(code),
	(err) => {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	},
);
