---
title: claimed tasks rest in tasks/backlog/ while the worker prompt says tasks/ready/
date: 2026-07-25
status: open
---

Working `pin-external-cid-ipns-mode`, the in-band prompt said the body lived at `work/tasks/ready/pin-external-cid-ipns-mode.md`, but there is no `work/tasks/ready/` on disk at all: the claimed body was in `work/tasks/backlog/` (the position gate / staging spot the work contract says is NOT the claimable agent pool), and `git log` shows the previous item landed as `work/tasks/{backlog => done}/pin-external-cid.md` too, so this is the repo's habit rather than a one-off.

Harmless for this build (the slug was unambiguous), but it means either the promote step (`backlog → ready`) is being skipped for this repo or the runner's prompt path is hard-coded to `ready/`; worth deciding which, since "status = the folder" is load-bearing.
