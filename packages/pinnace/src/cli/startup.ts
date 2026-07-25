/**
 * The `pinnace` CLI STARTUP shim: the thin process-entry glue that runs BEFORE
 * the pure {@link run} dispatch. Its whole job is to make the env-only secrets
 * model (CONTEXT.md `master key` / `token`) ergonomic for EVERY user, including
 * a global `npm install -g pinnace`, by loading `.env` / `.env.local` from the
 * cwd into `process.env` at startup, so no `pnpm ldenv` dev wrapper is needed.
 *
 * WHY a shim (and not inside {@link run}): `run(argv, {env})` is pure and
 * hermetically unit-tested with an INJECTED `env` record; it must never read a
 * real `.env` / touch a real cwd. So the ONE impure, filesystem-touching step
 * (`ldenv`'s {@link loadEnv}) lives HERE, in the bin/startup layer, in front of
 * `run()`. Config resolution + {@link resolveMasterSecret} read `process.env`,
 * so `loadEnv()` must have mutated it BEFORE `run()` runs.
 *
 * PRECEDENCE (preserved, not changed). `loadEnv()` reads `.env` then
 * `.env.local` (local overriding default) and MUTATES `process.env`, but it
 * does NOT override a value ALREADY set in `process.env`. So dotenv slots in
 * BELOW an explicitly-exported env var and ABOVE `pinnace.json`, keeping the
 * documented "env > file" rule intact. The effective chain becomes:
 * **CLI arg > exported `process.env` > `.env.local` > `.env` > `pinnace.json`**.
 * The master + host tokens stay env-only: `.env.local` is merely a FILE SOURCE
 * for those env vars, never a `pinnace.json` field.
 *
 * The `loadEnv` call is injected (defaulting to the real `ldenv` one) purely so
 * the shim is unit-testable; production always uses the real `ldenv.loadEnv`,
 * which is cwd-based only (never a global/home location), silent, and only
 * AUGMENTS env — an already-exported value is left untouched.
 */
import {loadEnv} from 'ldenv';
import {run} from './run.js';

/** Injectable seams for the startup shim (defaulted to the real ones). */
export interface StartupOptions {
	/**
	 * Load `.env` / `.env.local` from the cwd into `process.env`. Defaults to
	 * `ldenv`'s `loadEnv` (reads `.env` then `.env.local`, local overriding,
	 * never overriding an already-exported value). Injected only for tests.
	 */
	loadDotEnv?: () => void;
}

/**
 * The CLI startup entry: load the cwd's `.env` / `.env.local` into
 * `process.env` (so a global install gets the env-only secrets), THEN dispatch
 * `run()` over the process argv. Returns the process exit code.
 *
 * This is what the `pinnace` bin calls. It keeps the `loadEnv()` side effect
 * out of the pure `run()` path so `run(argv, {env})` stays hermetic.
 */
export async function main(
	argv: readonly string[] = process.argv.slice(2),
	options: StartupOptions = {},
): Promise<number> {
	const loadDotEnv = options.loadDotEnv ?? (() => void loadEnv());
	// Load the cwd's dotenv files BEFORE run() reads process.env. This only
	// augments process.env; an already-exported value still wins.
	loadDotEnv();
	return run(argv);
}
