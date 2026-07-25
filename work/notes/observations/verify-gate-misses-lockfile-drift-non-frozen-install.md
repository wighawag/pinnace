---
title: The verify gate misses pnpm-lock.yaml drift because it uses a non-frozen install
date: 2026-07-25
status: open
---

## What was observed

The `pinnace@0.3.0` release failed on its first run at the CI **Install** step:

```
ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because
pnpm-lock.yaml is not up to date with packages/pinnace/package.json
* 1 dependencies were added: ldenv@^0.3.16
```

The `cli-loadenv-dotenv-startup` task added `ldenv` to the `pinnace` package's
`dependencies` but did NOT update `pnpm-lock.yaml`. The task passed its verify
gate locally and merged, then broke the release.

## Root cause

The verify gate's `prepare` runs `pnpm install` (NON-frozen), which SILENTLY
UPDATES the lockfile in the build worktree to match `package.json`. So a
dependency added without a committed lockfile update still passes verify (the
gate regenerates the lock in memory, never asserting the committed one is
current). CI's release workflow uses `pnpm install --frozen-lockfile`, which
does the opposite — it FAILS if the committed lockfile is stale. So the drift is
invisible until a frozen install runs (release, or any `--frozen-lockfile` CI).

This is the same shape as the changeset-check gap
(`changeset-check-not-wired-into-verify-gate.md`): a repo convention that is not
actually enforced by the gate.

## Suggested disposition

A small task: make the gate catch lockfile drift. Options:
- Run `pnpm install --frozen-lockfile` in `prepare`/verify (so a stale lockfile
  fails the gate exactly as it fails CI). Caveat: this means a dep change MUST
  commit the lockfile update, which is the desired discipline.
- Or add an explicit `pnpm install --frozen-lockfile` (or `pnpm-lock` up-to-date
  check) step to `verify`.
Confirm it does not false-fail a legitimate first install. Until then, any task
that changes a package.json dependency MUST also commit the regenerated
`pnpm-lock.yaml`, and reviewers must check for it.
