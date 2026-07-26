---
title: '`changeset:check` (status --since=main) reports "no changesets" for an UNCOMMITTED changeset file'
date: 2026-07-26
status: open
---

Building `site-metadata-write-path-no-silent-loss`, `pnpm changeset:check` (`changeset status --since=main`) failed with "Some packages have been changed but no changesets were found", while a plain `npx changeset status` in the same tree correctly reported `pinnace: patch` from the new `.changeset/site-metadata-write-path-no-silent-loss.md`. The difference is that the file was still UNTRACKED: the `--since` path diffs against the ref, so a changeset that exists on disk but is not yet committed is invisible to it.

Harmless here (the runner commits with `git add -A`, after which the check passes), but it matters for the wiring proposed in `changeset-not-wired-into-verify-gate` (`changeset-check-not-wired-into-verify-gate.md`): an agent gate that runs `changeset:check` BEFORE the completion commit would false-fail on every task, so the enforcement point has to be post-commit (or the check has to consider untracked `.changeset/*.md`).
