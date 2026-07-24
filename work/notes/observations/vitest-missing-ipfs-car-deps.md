---
title: 5 vitest files fail to import (ipfs-car / @ipld/car not installed)
date: 2026-07-24
status: open
---

On this worktree `npx vitest run` (packages/pinnace) shows 5 pre-existing failing test files (index, cli/client-commands, cli/config-flag, car/car-build, deploy/deploy). All fail at import time with `Cannot find package 'ipfs-car'` / `Cannot find package '@ipld/car'` from `src/car/car-build.ts`. These fail on a clean tree too (before the cloud-init Reprovider->Provide fix), so it is an install/dependency-resolution issue in this environment, not a code regression. Unrelated to the cloud-init task; noting so the signal is captured.
