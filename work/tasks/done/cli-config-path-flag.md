---
title: Add a global `--config <path>` flag to the pinnace CLI (default ./pinnace.json)
slug: cli-config-path-flag
spec: pinnace
blockedBy: []
covers: [19]
---

## What to build

Let the operator point the CLI at a `pinnace.json` anywhere, instead of only `./pinnace.json`. Today `defaultLoadConfigFile()` hardcodes `readFileSync('pinnace.json')` relative to the cwd, and there is NO way to override the path, so a config kept in e.g. `runbook/pinnace.json` is invisible unless you `cd` there or symlink. Add a global `--config <path>` flag.

- `--config <path>` is a GLOBAL flag: it may appear BEFORE the command (e.g. `pinnace --config runbook/pinnace.json deploy ./site my-id`). Consume it in `run()` (strip it from the argv handed to the per-verb parsers) and thread the resolved path into config loading.
- Default is UNCHANGED: with no `--config`, load `./pinnace.json` (cwd-relative), and an ABSENT default file stays a benign empty config (current behaviour — a config file is optional).
- When `--config <path>` IS given, the file MUST exist and parse: a missing / unreadable / invalid-JSON explicitly-named path FAILS LOUD (a named error mentioning the path + exit 1), NOT a silent empty config. Rationale: an operator who explicitly named a file has made a claim it exists; silently ignoring a typo'd path would resolve to an empty config and produce confusing "no hosts configured" errors downstream. (Contrast the default: absence there is legitimate "no config file", so it stays benign.)
- Precedence is unchanged (CLI arg > env > file); `--config` only chooses WHICH file is the file layer. It does NOT introduce a path for the master or any secret (master/token stay env-only).
- The flag threads through the existing injectable `RunContext.loadConfigFile` seam so it stays unit-testable (a test passes a fake loader / a temp file, never reads a real `./pinnace.json`).

## Acceptance criteria

- [ ] `pinnace --config <path> <command> ...` loads the config from `<path>`; the flag is accepted BEFORE the command and is stripped so it does not confuse per-verb arg parsing.
- [ ] With no `--config`, behaviour is unchanged: `./pinnace.json` is read if present, and its ABSENCE is a benign empty config.
- [ ] An explicitly-given `--config <path>` that is missing / unreadable / invalid JSON fails LOUD (error names the path, exit 1) rather than silently resolving to an empty config.
- [ ] Precedence (arg > env > file) is unchanged; no secret (master/token) gains a file path.
- [ ] Test-first: failing tests for (a) `--config` selects the given file, (b) missing named path fails loud, (c) no-flag default still reads `./pinnace.json` and tolerates its absence — all via the injectable loader / a temp file, isolating the real cwd config.
- [ ] Tests do not read or mutate the operator's real `./pinnace.json` or real env.

## Blocked by

- None — `cli-command-wrapper` + `config-resolution` are in `tasks/done/`; this extends the CLI's config-load seam.

## Prompt

> Goal: add a global `--config <path>` flag to the `pinnace` CLI so a config file can live anywhere (e.g. `runbook/pinnace.json`), not just `./pinnace.json`. Read the done tasks `cli-command-wrapper` (the `RunContext` / `loadConfigFile` seam + `run()` dispatch) and `config-resolution` (precedence). Read CONTEXT.md `config resolution`.
>
> Today `defaultLoadConfigFile()` hardcodes `readFileSync('pinnace.json')` and `resolveContext` calls it before command parsing. Make `--config <path>` a GLOBAL flag parsed in `run()` (before the command, stripped from the per-verb argv), threaded into config loading via the existing injectable `RunContext.loadConfigFile` seam.
>
> Keep the default behaviour: no `--config` => read `./pinnace.json`, and its ABSENCE stays a benign empty config (a config file is optional). But an EXPLICITLY named `--config <path>` that is missing / unreadable / invalid JSON must FAIL LOUD (name the path, exit 1) — a named-but-missing file is an operator error, not "no config". Precedence (arg > env > file) is unchanged and no secret gains a file path (master/token stay env-only).
>
> Test-first (repo policy on): failing tests for `--config` selecting the file, the loud failure on a missing named path, and the unchanged no-flag default — all via the injectable loader or a temp file, never touching the real `./pinnace.json` or real env. Done means an operator can run `pinnace --config runbook/pinnace.json deploy ...` and a typo'd path errors loudly instead of silently emptying the config.
