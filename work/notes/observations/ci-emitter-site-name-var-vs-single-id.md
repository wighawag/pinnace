---
title: CI emitter still calls its deploy var SITE_NAME (+ "site name / ENS name" wording) after the single-`id` change
date: 2026-07-24
status: open
---

## What was observed

While doing `config-token-env-only-and-single-site-id` (site is now ONE `id`, no
`name`/`keyId`; CLI is `pinnace deploy <dir> <id>`), the GitHub CI emitter
(`packages/pinnace/src/ci/ci-emit.ts`) still names its deploy variable `SITE_NAME`
and describes it as "The site name / ENS name this deploy targets." (line ~141),
and the emitted workflow runs `pinnace deploy --mode "$SITE_MODE" <dir> "$SITE_NAME"`.

Behaviourally this is still correct: `$SITE_NAME` is just the value passed as the
deploy `<id>` positional. But the VARIABLE NAME + description are stale vs the new
single-`id` vocabulary (would ideally be `SITE_ID` / "the site id").

## Why left out of scope here

`SITE_NAME` is the CI-system's repo-variable contract, snapshot-locked and owned
by the `ci-emitter-github` task, NOT the `SiteConfig` surface this task changed.
Renaming it touches that task's snapshot + its secrets/vars report contract, which
is outside `config-token-env-only-and-single-site-id`'s enumerated consumer list
(config schema, CLI, deploy MFS/publish, status, warm, site-management, record
outcomes). Captured here so the naming can be reconciled when the CI emitter is
next revisited (rename `SITE_NAME` -> `SITE_ID`, update the description + snapshot).
