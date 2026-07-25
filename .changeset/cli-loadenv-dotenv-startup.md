---
'pinnace': minor
---

Auto-load `.env` / `.env.local` from the cwd at CLI startup via `ldenv`'s `loadEnv()`, so a global `npm install -g pinnace` gets the env-only secrets model with no `pnpm ldenv` dev wrapper.

- The `pinnace` bin now calls a thin startup shim (`src/cli/startup.ts` `main()`) that runs `loadEnv()` (reads `.env` then `.env.local` from the cwd, `.env.local` overriding, MUTATES `process.env`) BEFORE `run()` reads env. `loadEnv()` does NOT override an already-exported value, so an explicitly exported env var still wins over the file.
- Effective precedence is now **CLI arg > exported `process.env` > `.env.local` > `.env` > `pinnace.json`** — dotenv slots BELOW exported env and ABOVE the config file, keeping the documented "env > file" rule intact. The master + host tokens stay env-only; `.env.local` is only a file SOURCE for those env vars, never a `pinnace.json` field.
- `ldenv` is now a runtime `dependency` of the `pinnace` package (a published global install needs it at runtime; it was only a root devDependency before).
- The pure `run(argv, {env})` path stays hermetic: the `loadEnv()` side effect lives ONLY in the startup shim, so unit tests inject `env` and never read a real `.env`.
- README (package): documents that the bin auto-loads `.env.local` from the cwd for global users and the effective precedence.

Tests isolate cwd to a temp fixture dir (with a fixture `.env.local`) and assert its vars reach the resolver, that an exported value wins over the file, that `.env` layers below `.env.local`, that an absent dotenv is a no-op, and that `run()` never reads a real `.env` (only the injected env). Every touched `process.env` key is captured + restored so no test leaks env.

## Decisions

- **The `loadEnv()` call lives in a new bin/startup shim (`src/cli/startup.ts` `main()`), NOT inside `run()`.** `run(argv, {env})` is the hermetically-injected pure path (config resolution reads the injected `env`); putting the one impure, filesystem-touching step (dotenv load) in front of it keeps that path testable without a real cwd/`.env`. Alternative considered: calling `loadEnv()` at the top of `run()` (rejected: it would make every `run()` caller — including unit tests — read a real `.env`, breaking hermeticity). The shim exposes an injectable `loadDotEnv` seam purely so the ordering (loadEnv-before-run) is unit-testable; production always uses the real `ldenv.loadEnv`. Touches: `src/cli/bin.ts` (now calls `main`), the `run()` seam (unchanged, still pure).
- **CONTEXT.md `config resolution` glossary left as `CLI arg > env (ldenv) > pinnace.json`.** dotenv is not a NEW layer — it is the `ldenv` env layer already named there; `.env.local` / `.env` are just file SOURCES that populate `process.env`, and "already-exported wins" preserves the "env > file" ordering. So this introduces no new domain concept and does not re-mean `env`. The fuller chain (exported > `.env.local` > `.env`) is documented in the package README where operators read it, not in the glossary. Touches: the shared `config resolution` vocabulary (deliberately unchanged).
