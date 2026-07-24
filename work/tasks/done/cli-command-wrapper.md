---
title: Thin pinnace CLI over the core (provision, deploy, install-ci, status, derive)
slug: cli-command-wrapper
spec: pinnace
promptGuidance.testFirst: true
blockedBy: [deploy-multi-target, status-report, cloud-init-generation, ci-emitter-github, ipns-key-derivation, config-resolution, site-management]
covers: [1, 16, 18, 19, 20, 22]
---

## What to build

The thin `pinnace` CLI wrapping the core operations, so the v1 commands are usable at the command line while all behaviour still lives in the core (the CLI only parses args + formats output). v1 client commands: `provision` (emit cloud-init for a host/site/role), `deploy <dir> <site>` (build CAR + import to nodes + per-site mode), `install-ci` (emit CI workflow + report secrets/vars), `status` (per-site report), the site-management verbs (add / remove / list sites), and a `derive`/`ipns-id` command to print a site's IPNS id from master + keyId WITHOUT deploying (user story 22). Config resolution stays arg > env (`ldenv`) > `pinnace.json` at the CLI boundary; the master is env-only.

NOTE: the on-box `pinnace node <verb>` subcommands (republish/mirror/warm/status) are built in `node-agent-commands` — they are part of the same binary but are the box's periodic-agent surface, not client commands, so they are not re-implemented here (this task wires the CLIENT-facing verbs). Keep them coherent as one CLI (shared arg-parsing/help), but their dispatch tests live with their own task.

Keep the CLI genuinely thin: each command parses/validates args, calls the corresponding core function, and formats the result. Test that each command dispatches to the core with the correctly-resolved arguments (using a stubbed/mock core or the mock RPC seam), NOT by re-testing core logic. This proves the core-vs-cli seam and that the same operations are equally a TS API (user story 20).

## Acceptance criteria

- [ ] `pinnace` exposes v1 commands: `provision`, `deploy`, `install-ci`, `status`, and a derive/print-IPNS-id command (no deploy for the latter — user story 22).
- [ ] Each command is a thin wrapper: it parses/validates args, resolves config (arg > env > file, master env-only), calls the core, and formats output — no business logic in the CLI.
- [ ] Tests assert each command dispatches to the correct core function with correctly-resolved arguments (stubbed core / mock RPC), not re-testing core internals.
- [ ] The same operations remain callable as a TS API via the library core (the seam is intact — user story 20).
- [ ] Test-first: the failing dispatch tests are written before the CLI wiring.
- [ ] Tests isolate env/config (temp/scratch values via the `ldenv`/env lever) and assert the operator's real environment/config is untouched.

## Blocked by

- Blocked by `deploy-multi-target`, `status-report`, `cloud-init-generation`, `ci-emitter-github`, `ipns-key-derivation`, and `config-resolution` (the core operations it wraps must exist first).

## Prompt

> Goal: build the thin **`pinnace` CLI** over the library core. CONTEXT.md `core vs cli`: the core owns ALL logic; the CLI is a thin wrapper so the same operations are usable as a TypeScript API (user story 20). v1 commands (spec): `provision` (cloud-init for host/site/role), `deploy <dir> <site>` (CAR build + multi-node import + per-site mode), `install-ci` (emit workflow + report secrets/vars), `status` (per-site report), and a derive/print command that prints a site's IPNS id from master + keyId with NO deploy (user story 22, so ENS contenthash can be set before first deploy).
>
> Config resolution at the CLI boundary is arg > env (`ldenv`) > `pinnace.json` (user story 19); the master secret is env-only. Reuse the `config-resolution` core seam — do not re-implement precedence in the CLI.
>
> Keep it genuinely thin: parse/validate args, call the core, format output. Test that each command DISPATCHES to the right core function with correctly-resolved arguments (stub/mock the core, or use the mock RPC seam) — do NOT re-test core logic through the CLI. Test-first (repo policy on). ISOLATE env/config in tests (temp/scratch, assert the real env/config is untouched — WORK-CONTRACT.md shared-write rule). Done means all v1 commands dispatch correctly and the core remains a usable TS API.
