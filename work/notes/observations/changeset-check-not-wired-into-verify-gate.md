---
title: The changeset check is NOT wired into the verify gate, despite CONTEXT.md requiring it
date: 2026-07-25
status: open
---

## What was observed

CONTEXT.md "Conventions" says: "Every change requires a changeset (`pnpm
changeset`). For enforcement, wire a check (e.g. `changeset status --since=main`)
into the `dorfl.json` `verify` gate."

But `dorfl.json` `verify` is:

```
"verify": "pnpm format:check && pnpm build && pnpm test"
```

`changeset:check` (`changeset status --since=main`, defined as a root script) is
NOT in the chain. So the every-change-needs-a-changeset rule is NOT enforced by
the gate. Evidence: three landed tasks shipped code with NO changeset and passed
the gate (`kubo-multipart-file-uploads`, `kubo-routing-put-multipart-value-file`,
`cloud-init-fix-reprovider-to-provide`) — their changesets had to be backfilled by
hand before the 0.1.0 release so the fixes appeared in the changelog.

## Why this matters / the subtlety

Wiring `changeset status --since=main` into `verify` naively would break the
release flow: the "Version Packages" PR (and any post-release main state)
legitimately has NO pending changesets, so `changeset status` there must NOT be
treated as a failure. So the enforcement needs to fire on FEATURE branches
(a code change with no changeset = fail) but tolerate the no-changeset state on
main / the version PR. Options:
- Wire it only in the per-task/PR gate, not the release path.
- Use `changeset status --since=main` (compares against main), which on main
  itself reports "no changesets" cleanly (exit 0) and only flags a branch that
  changed code without adding one — verify this exit-code behaviour before wiring.
- Or accept it as advisory (the changesets ACTION already blocks a release-time
  gap) and rely on review to catch a missing changeset.

## Suggested disposition

A small task: decide the enforcement point + wire `changeset:check` into the
appropriate gate (per-change, not release), confirming it does not false-fail on
main / the Version PR. Until then, missing changesets must be caught in review
(as happened here at release time).
