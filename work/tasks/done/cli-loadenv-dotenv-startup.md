---
title: Load .env/.env.local at CLI startup via ldenv loadEnv (so global installs get it too)
slug: cli-loadenv-dotenv-startup
spec: pinnace
blockedBy: []
covers: [10, 19]
---

## What to build

Make the `pinnace` CLI load `.env` / `.env.local` from the current directory PROGRAMMATICALLY at startup, via `ldenv`'s `loadEnv()`. Today `.env.local` is only picked up when the operator runs the dev wrapper `pnpm ldenv node …bin.js`; a GLOBAL install (`npm install -g pinnace`, then `pinnace …`) gets NO dotenv loading, so the operator must manually export `PINNACE_MASTER` + the `PINNACE_HOST_*_TOKEN`s. Calling `loadEnv()` in the bin makes the env-only secrets model ergonomic for EVERY user, not just the repo-local dev flow.

Design (verified against `ldenv@0.3.16`):
- `loadEnv()` (from `ldenv`) reads `.env` then `.env.local` from the cwd (`.env.local` overriding `.env`), MUTATES `process.env`, and — importantly — does NOT override a value ALREADY set in `process.env`. So an explicitly EXPORTED env var still wins over a dotenv file.
- Call `loadEnv()` ONCE at the executable entry (`src/cli/bin.ts`), BEFORE any config resolution runs (config resolution + `resolveMasterSecret` read `process.env`). It must run before `run()` reads env.
- Add `ldenv` to the PACKAGE's own `dependencies` (it is currently only a root devDependency; a published global install needs it at runtime).
- Preserve the resolution contract: the effective precedence becomes **CLI arg > exported process.env > `.env.local` > `.env` > `pinnace.json`** — i.e. dotenv slots in BELOW exported env and ABOVE the config file, which is consistent with the documented "env > file" rule (dotenv is just a convenience env layer). The master + tokens stay env-only; `loadEnv` gives them a file SOURCE (`.env.local`) but they are still resolved from `process.env`, never from `pinnace.json`.
- Keep it OPT-OUTABLE / non-surprising: loading is silent, cwd-based, and only augments env. Do not load from a global/home location (cwd only, like the dev wrapper), so it never reaches outside the project. Consider honoring a `--no-env-file` style escape hatch only if trivial; otherwise the "already-exported wins" behaviour is enough.
- Because `run()` is unit-tested with an INJECTED `env` (not `process.env`), the `loadEnv()` call belongs in the bin wrapper (or a thin startup shim), so the pure `run(argv, {env})` path stays hermetic and tests do NOT read a real `.env`. Tests for this behaviour isolate cwd to a temp dir with a fixture `.env.local` and assert (a) its vars reach the resolver and (b) an exported value wins over the file.

## Acceptance criteria

- [ ] The `pinnace` bin calls `ldenv`'s `loadEnv()` at startup (before config resolution), so a GLOBAL install auto-loads `.env` / `.env.local` from the cwd — no `pnpm ldenv` wrapper needed.
- [ ] `ldenv` is declared in the `pinnace` package's own `dependencies` (runtime), not only the root devDependencies.
- [ ] Precedence is preserved: CLI arg > exported `process.env` > `.env.local` > `.env` > `pinnace.json`. A test asserts an EXPORTED env var wins over a `.env.local` value, and that a `.env.local` value is used when the var is not exported.
- [ ] The master + host tokens remain env-only (resolved from `process.env`, never from `pinnace.json`); `.env.local` is just a file source for those env vars.
- [ ] The pure `run(argv, {env})` path stays hermetic: the `loadEnv()` call is in the bin/startup shim, and unit tests do NOT read a real `.env` (they isolate cwd + inject env).
- [ ] Tests isolate cwd to a temp fixture dir and assert no real `.env`/home location is read or mutated.
- [ ] README updated: a global-install user can put secrets in `.env.local` and just run `pinnace …`; document the effective precedence.

## Blocked by

- None — `config-resolution` + `cli-command-wrapper` are in `tasks/done/`; this adds a startup env-file load in front of them.

## Prompt

> Goal: make `pinnace` load `.env`/`.env.local` from the cwd at startup via `ldenv`'s `loadEnv()`, so EVERY user (including a global `npm install -g pinnace`) benefits from the env-only secrets model without the `pnpm ldenv` dev wrapper. Read CONTEXT.md (`config resolution`, `master key`), the done tasks `config-resolution` (env-only master/tokens) and `cli-command-wrapper` (the `RunContext`/`run()` seam).
>
> `ldenv` (already a dep) exports `loadEnv()`: it reads `.env` then `.env.local` from cwd (local overrides), mutates `process.env`, and does NOT override an already-exported value. Call it ONCE in `src/cli/bin.ts` BEFORE `run()` (config resolution reads `process.env`). Add `ldenv` to the pinnace package's own runtime `dependencies`. Keep the pure `run(argv, {env})` path hermetic — the `loadEnv()` call lives in the bin/startup shim, not in `run()`, so unit tests inject env and never read a real `.env`.
>
> Preserve precedence: CLI arg > exported env > `.env.local` > `.env` > `pinnace.json`; master + tokens stay env-only (a `.env.local` source, never the config file). Test-first: with cwd isolated to a temp dir + a fixture `.env.local`, assert its vars reach the resolver AND that an exported value wins over the file; assert no real `.env`/home is touched. Update the README (global users can use `.env.local`). Done means a global-installed `pinnace` auto-loads `.env.local` from the project dir.
