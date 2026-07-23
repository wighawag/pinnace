/**
 * pinnace library core — the public TypeScript API.
 *
 * All logic lives in the core (see CONTEXT.md `core vs cli`); the `pinnace`
 * CLI bin (src/cli/bin.ts) is a thin wrapper that imports from here, so every
 * operation is equally usable as a TypeScript API. Subsequent tracer-bullet
 * tasks (Kubo RPC client, CAR build, key derivation, cloud-init, CI emitter,
 * status, config, deploy, site management, CLI) hang off this entrypoint.
 */

/** The package name, exposed so the CLI and API can report a consistent identity. */
export const PINNACE = 'pinnace';

/** Returns the pinnace package name (a trivial seam proving the toolchain is wired). */
export function name(): string {
	return PINNACE;
}
