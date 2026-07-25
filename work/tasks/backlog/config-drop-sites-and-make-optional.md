---
title: Config shrink — drop `sites` from pinnace.json (rework its consumers) + make config optional
slug: config-drop-sites-and-make-optional
spec: sites-metadata-in-mfs
promptGuidance.testFirst: true
blockedBy: [deploy-pin-write-site-metadata]
covers: [1, 2]
needsAnswers: true
---

## What to build

Shrink `pinnace.json` to INFRASTRUCTURE only (hosts) and make it OPTIONAL. This is NOT a pure deletion: `cfg.sites` is READ by three live CLI call sites, which must be reworked, not just dropped.

- **Remove `SiteConfig` + `sites` from the config schema** (`PinnaceConfigFile`/`ResolvedConfig` keep `hosts`, `gateways`; lose `sites`).
- **Rework the three `cfg.sites` consumers:**
  1. `deploy` resolves `mode` from the matching site entry when `--mode` is absent (`cfg.sites.find(s => s.id === siteId)?.mode`). With `sites` gone, deploy's mode comes from `--mode` only (arg > a sensible default); the config-based mode fallback is REMOVED. (Metadata is the durable per-site mode home now — the deploy-writes-metadata task already persists it — but deploy at write-time takes it from `--mode`.) State the new mode-source order clearly and error/refuse sensibly if mode is unresolved, matching the current unresolved-mode error shape.
  2. `derive` normalises the id via `cfg.sites.find(s => s.id === siteId)?.id ?? siteId` -> becomes just `siteId` (the arg). Remove the `.find`.
  3. `promote` has the same `?? siteId` fallback -> becomes just `siteId`. Remove the `.find`.
- **Make the config file optional:** a publisher endpoint (+ token, env-only) supplied on the CLI yields a usable single-node target with NO `pinnace.json`. Add the CLI path (e.g. an existing/`--host-endpoint`-style flag or a dedicated `--endpoint`) so `deploy`/`pin`/`status`/`derive`/`promote` can operate against one node without a config file. A missing config file is already tolerated (benign empty) per the `--config` task; this task makes operating WITHOUT one actually work by sourcing the single host from the CLI.

Master + host tokens stay env-only (unchanged). The `--config <path>` behaviour (named-missing fails loud) is unchanged.

## Acceptance criteria

- [ ] `SiteConfig`/`sites` is removed from the `pinnace.json` schema; a `sites` key in a config fixture is ignored (no longer surfaced); `hosts`/`gateways` unchanged.
- [ ] The three `cfg.sites` consumers are reworked: deploy's mode = `--mode` (arg > default) with the config fallback gone and a clear unresolved-mode error; derive + promote use the `id` arg directly (no `.find`).
- [ ] The config file is OPTIONAL: with NO `pinnace.json`, a CLI publisher endpoint + env token yields a working single-node target for deploy/pin/status/derive/promote (a test proves at least one verb operates with no file, endpoint via CLI, token via env).
- [ ] Precedence otherwise unchanged (arg > env > file); master + tokens env-only; `--config` named-missing still fails loud.
- [ ] Test-first; env/config isolated (no real process.env / real pinnace.json read); no live daemon.

## Blocked by

- Blocked by `deploy-pin-write-site-metadata` (deploy must already source `mode` from `--mode`/write it to metadata before the config mode-fallback is removed, so ordering avoids a window where deploy has no mode source).

## Prompt

> Goal: make `pinnace.json` infra-only (hosts) and OPTIONAL, reworking the three live `cfg.sites` consumers. Read the spec `sites-metadata-in-mfs` (stories 1, 2; Impl Decisions "Config shrink is NOT purely additive" — it enumerates the consumers), the done tasks `config-resolution`, `cli-command-wrapper`, `cli-config-path-flag`, and the sibling `deploy-pin-write-site-metadata`.
>
> Remove `SiteConfig`/`sites` from the schema. Rework: (1) deploy's `mode` now comes from `--mode` (arg > default), the `cfg.sites.find(...)?.mode` fallback REMOVED, with a clear unresolved-mode error; (2) derive and (3) promote drop their `cfg.sites.find(...)?.id ?? siteId` to just `siteId`. Make the file optional: a CLI publisher endpoint + env token yields a single-node target with no `pinnace.json` (add the CLI endpoint path). Keep arg>env>file precedence, master/tokens env-only, `--config` named-missing loud. Test-first, env/config isolated, no live daemon. Done means config carries only hosts, is optional, and the three consumers work under the new model.

## Requeue 2026-07-25

Gate 2 (the PR/code review) failed to LAUNCH on the previous run — an infrastructure failure, not a code failure: the acceptance gate was fully green (format:check + build + 336 tests) on the rebased tip. The work on work/task-config-drop-sites-and-make-optional is believed complete. CONTINUE from that branch: re-verify the task's acceptance criteria against what is already there, change only what is actually missing or wrong, and do not redo work that already landed.
