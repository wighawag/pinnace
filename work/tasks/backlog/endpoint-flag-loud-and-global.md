---
title: Make --endpoint honest — a bare flag REFUSES, and it is accepted before the verb like --config
slug: endpoint-flag-loud-and-global
spec: sites-metadata-in-mfs
promptGuidance.testFirst: true
blockedBy: []
covers: [2]
---

## What to build

`--endpoint <url>` is the flag that makes story 2 real (operate against one node with NO `pinnace.json`). It shipped with two ergonomic defects, one of which contradicts a policy the very same change established.

### 1. A BARE `--endpoint` is silently IGNORED

`cliOverridesFromFlags` does `if (flags['endpoint']) cli.endpoint = flags['endpoint']`, and `parseArgs` assigns `''` to a flag followed by another `--flag`. So `pinnace deploy --endpoint --set-mode ipns ./dist mysite` drops the endpoint and the deploy silently WIDENS back to every host in `pinnace.json` instead of narrowing to the one node the operator asked for. That is the worst shape of failure: the operator's targeting instruction is discarded and the command still succeeds, against MORE nodes than intended.

The same diff that shipped this made a bare `--set-mode` a loud usage error, on the principle that **a flag the operator typed must never mean nothing**. Apply that principle here: a bare `--endpoint` (end-of-args, or immediately followed by another `--flag`) is a loud usage error naming the flag and showing the expected form. Use the existing optional-value/`parseArgs` convention to DETECT the bare form, then refuse it. An empty-string value is the same refusal.

Audit the OTHER value-taking flags reached through `cliOverridesFromFlags` and the verb parsers while you are here: any flag whose bare form is currently swallowed should refuse the same way. Fix the ones that share this exact defect; do NOT redesign the arg parser.

### 2. `--endpoint` is only accepted AFTER the verb, unlike `--config`

`--config` is stripped GLOBALLY (`takeConfigFlag`), so it may precede the command; `--endpoint` is parsed per-verb. So `pinnace --endpoint <url> status` exits 1 with `unknown command '--endpoint'`, while `pinnace status --endpoint <url>` works. Two flags that both read as global behave differently, and the failure blames the flag as if it were a command.

Accept `--endpoint` in BOTH positions (before or after the verb), the way `--config` already is, so the two global-looking flags behave alike. Keep the resolution semantics exactly as they are (arg > env > file; it replaces the file's hosts for that run, while `--host-endpoint.<name>` still overrides the endpoint OF a configured host) — this is about WHERE the flag may appear, not what it means. If a value is somehow given in both positions, refuse loudly rather than silently picking one.

This is recorded in `work/notes/observations/endpoint-flag-not-accepted-before-the-verb.md`; resolve that note as part of this task.

## Acceptance criteria

- [ ] A bare `--endpoint` (at end-of-args, or followed by another `--flag`) is a LOUD usage error naming the flag and the expected form; it never silently widens the run back to the config's hosts (tested for both bare shapes and for an explicit empty value).
- [ ] `pinnace --endpoint <url> status` and `pinnace status --endpoint <url>` behave IDENTICALLY (tested), as `--config` already does in both positions.
- [ ] Supplying `--endpoint` in both positions refuses loudly rather than silently choosing one (tested).
- [ ] Endpoint RESOLUTION semantics are unchanged: arg > env > file, replacing the file hosts for that run, with `--host-endpoint.<name>` still overriding a configured host's endpoint (existing tests stay green).
- [ ] Any other value-taking flag with the same swallowed-bare-form defect is refused the same way (name them in the changeset); the arg parser is not redesigned.
- [ ] The observation `endpoint-flag-not-accepted-before-the-verb.md` is resolved.
- [ ] Test-first, at the CLI seam; env/config isolated; no live daemon. A changeset is included.

## Blocked by

- None — can start immediately. Touches `src/cli/run.ts` only, so it is file-orthogonal to the metadata tasks.

## Prompt

> Goal: make `--endpoint` behave like the global, honest flag it reads as. Read `src/cli/run.ts` (`parseArgs`, `takeConfigFlag`, `cliOverridesFromFlags`, the verb parsers) and the bare-`--set-mode` refusal shipped by `config-drop-sites-and-make-optional` — that is the policy you are extending.
>
> A bare `--endpoint` currently parses as `''` and is silently dropped, so the run widens back to every configured host instead of the single node the operator named. Make it a loud usage error, per the established "a flag the operator typed must never mean nothing" rule, and fix any sibling flag with the identical defect.
>
> `--endpoint` is also only accepted AFTER the verb, while `--config` is stripped globally, so `pinnace --endpoint <url> status` fails with a misleading `unknown command`. Accept it in both positions, refusing loudly if given twice. Do not change what the flag MEANS, only where it may appear and how a valueless one is treated.
